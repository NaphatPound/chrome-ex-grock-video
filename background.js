// Background Service Worker for Grok Video Generator

class GrokVideoGenerator {
  constructor() {
    this.isRunning = false;
    this.shouldStop = false;
    this.currentConfig = null;
    this.currentImageName = null;
    this.progress = { current: 0, total: 0 };
    this.grokTabId = null;
    this.keepAliveInterval = null;
    this.init();
  }

  // Prevent the MV3 service worker from being evicted during a run.
  // Without this, Chrome terminates the worker after ~30s of idle —
  // which kills the pending waitForGeneration promise and the outer
  // for-loop, so no second iteration ever runs.
  startKeepAlive() {
    if (this.keepAliveInterval) return;
    this.keepAliveInterval = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, 20000);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  init() {
    chrome.runtime.onMessage.addListener((message, sender) => {
      this.handleMessage(message, sender);
    });

    // Restore state on startup
    this.restoreState();
  }

  async restoreState() {
    // MV3 service workers can be evicted between events. Rehydrate
    // currentConfig so a VIDEO_READY that wakes the worker can still find
    // autoDownload (otherwise the download is silently skipped).
    const state = await chrome.storage.local.get(['isRunning', 'currentConfig', 'currentImageName']);
    if (state.isRunning) {
      await chrome.storage.local.set({ isRunning: false });
    }
    if (state.currentConfig) {
      this.currentConfig = state.currentConfig;
    }
    if (state.currentImageName) {
      this.currentImageName = state.currentImageName;
    }
  }

  async handleMessage(message, sender) {
    switch (message.action) {
      case 'START_GENERATION':
        await this.startGeneration(message.config);
        break;
      case 'STOP_GENERATION':
        this.stopGeneration();
        break;
      case 'VIDEO_READY':
        await this.handleVideoReady(message.videoUrl, message.videoData);
        break;
      case 'GENERATION_COMPLETE':
        await this.handleGenerationComplete();
        break;
      case 'GENERATION_ERROR':
        await this.handleGenerationError(message.error);
        break;
    }
  }

  async startGeneration(config) {
    if (this.isRunning) {
      this.log('Generation already in progress', 'warning');
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;
    this.currentConfig = config;
    // One generation per uploaded image; loop count is implicitly images.length.
    this.progress = { current: 0, total: config.images.length };

    await chrome.storage.local.set({
      isRunning: true,
      progress: this.progress,
      currentConfig: config
    });

    this.notifyStateChange();
    this.log('Starting generation process...', 'info');

    this.startKeepAlive();

    // Find or create Grok tab
    await this.ensureGrokTab();

    // Start the generation loop
    try {
      await this.runGenerationLoop();
    } finally {
      this.stopKeepAlive();
    }
  }

  stopGeneration() {
    this.shouldStop = true;
    this.isRunning = false;
    this.currentImageName = null;
    this.stopKeepAlive();
    chrome.storage.local.set({ isRunning: false, currentConfig: null, currentImageName: null });
    this.notifyStateChange();
    this.log('Stopping generation...', 'warning');
  }

  async ensureGrokTab() {
    // Look for existing Grok tab
    const tabs = await chrome.tabs.query({ url: ['https://grok.com/*'] });

    if (tabs.length > 0) {
      this.grokTabId = tabs[0].id;
      await chrome.tabs.update(this.grokTabId, { active: true });
      this.log('Using existing Grok tab', 'info');
    } else {
      // Create new tab
      const tab = await chrome.tabs.create({ url: 'https://grok.com/imagine' });
      this.grokTabId = tab.id;
      this.log('Created new Grok tab', 'info');

      // Wait for tab to load
      await this.waitForTabLoad(this.grokTabId);
    }
  }

  waitForTabLoad(tabId, { requireLoading = false, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      let sawLoading = !requireLoading;
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        if (err) reject(err);
        else setTimeout(resolve, 2000); // Let content script finish initializing
      };

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === 'loading') sawLoading = true;
        if (changeInfo.status === 'complete' && sawLoading) finish();
      };

      const timeout = setTimeout(() => finish(new Error('Tab load timeout')), timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async navigateToStart() {
    if (!this.grokTabId) {
      await this.ensureGrokTab();
      return;
    }

    // Grok sometimes redirects /imagine → /imagine/saved when there is recent
    // history. The saved page has no generation form AND contains old videos
    // that would be mis-detected as the result of our next generation.
    // Navigate to a cache-busted URL and verify we landed on a clean page.
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const loadPromise = this.waitForTabLoad(this.grokTabId, { requireLoading: true });
        const url = `https://grok.com/imagine?t=${Date.now()}`;
        await chrome.tabs.update(this.grokTabId, { url, active: true });
        await loadPromise;

        const tab = await chrome.tabs.get(this.grokTabId);
        const landedUrl = tab.url || '';
        if (!landedUrl.includes('/saved')) {
          return; // Clean generation page reached
        }

        this.log(`Grok redirected to saved page (attempt ${attempt + 1}), retrying...`, 'warning');
        await this.delay(1000);
      } catch (error) {
        this.log(`Navigation attempt ${attempt + 1} failed: ${error.message}`, 'warning');
      }
    }

    // Redirect could not be escaped by retrying — recreate the tab fresh
    this.log('Recreating Grok tab to escape /saved redirect', 'warning');
    try { await chrome.tabs.remove(this.grokTabId); } catch (_) {}
    this.grokTabId = null;
    await this.ensureGrokTab();
  }

  async runGenerationLoop() {
    const { images, delayBetween } = this.currentConfig;
    // Support both the new prompts[] array and the old single-prompt config
    // (older persisted configs may still be in storage from previous runs).
    const prompts = Array.isArray(this.currentConfig.prompts)
      ? this.currentConfig.prompts
      : (this.currentConfig.prompt ? [this.currentConfig.prompt] : []);
    let isFirstGeneration = true;

    for (let imgIndex = 0; imgIndex < images.length; imgIndex++) {
      if (this.shouldStop) break;

      const image = images[imgIndex];
      const promptIndex = imgIndex % prompts.length;
      const prompt = prompts[promptIndex];
      // Remember which source image produced the upcoming video so the
      // VIDEO_READY handler can name the download after it.
      this.currentImageName = image?.name || null;
      await chrome.storage.local.set({ currentImageName: this.currentImageName });

      this.log(`Processing image ${imgIndex + 1}/${images.length} — prompt #${promptIndex + 1}/${prompts.length}`, 'info');

      try {
        // After the first generation the tab is on a result page;
        // navigate back to the image-generation start page so the
        // content script can find the input and upload controls again.
        if (!isFirstGeneration) {
          this.log('Navigating back to Grok images page...', 'info');
          await this.navigateToStart();
        }
        isFirstGeneration = false;

        // Send image and prompt to content script
        await this.sendToContentScript({
          action: 'GENERATE_VIDEO',
          image: image,
          prompt: prompt
        });

        // Wait for generation to complete (handled by content script response)
        await this.waitForGeneration();
        this.log('Generation finished, preparing next iteration', 'success');

        this.progress.current++;
        await chrome.storage.local.set({ progress: this.progress });
        this.notifyProgress();

        if (!this.shouldStop && imgIndex < images.length - 1) {
          this.log(`Waiting ${delayBetween / 1000} seconds before next generation...`, 'info');
          await this.delay(delayBetween);
        }
      } catch (error) {
        this.log(`Error: ${error.message}`, 'error');
        await this.delay(5000); // Wait before retry
      }
    }

    this.isRunning = false;
    this.currentImageName = null;
    await chrome.storage.local.set({ isRunning: false, currentConfig: null, currentImageName: null });
    this.notifyStateChange();
    this.log('Generation completed!', 'success');
  }

  async sendToContentScript(message) {
    if (!this.grokTabId) {
      throw new Error('Grok tab not found');
    }

    // The content script runs at document_idle and may briefly be unavailable
    // right after a navigation. Retry a few times before giving up.
    const maxAttempts = 5;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await chrome.tabs.sendMessage(this.grokTabId, message);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          // First failure — the tab might have been closed; re-ensure
          try {
            await this.ensureGrokTab();
          } catch (_) {}
        }
        await this.delay(1500);
      }
    }
    throw lastErr || new Error('Failed to reach content script');
  }

  waitForGeneration() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Generation timeout'));
      }, 300000); // 5 minute timeout

      const listener = (message) => {
        if (message.action === 'GENERATION_COMPLETE') {
          cleanup();
          resolve();
        } else if (message.action === 'GENERATION_ERROR') {
          cleanup();
          reject(new Error(message.error));
        }
      };

      chrome.runtime.onMessage.addListener(listener);
    });
  }

  async handleVideoReady(videoUrl, videoData) {
    // If the service worker was evicted and restarted between loops,
    // currentConfig / currentImageName may not be rehydrated yet. Pull
    // them from storage so we don't drop the download for autoDownload users.
    if (!this.currentConfig || !this.currentImageName) {
      const stored = await chrome.storage.local.get(['currentConfig', 'currentImageName']);
      if (!this.currentConfig && stored.currentConfig) this.currentConfig = stored.currentConfig;
      if (!this.currentImageName && stored.currentImageName) this.currentImageName = stored.currentImageName;
    }
    if (this.currentConfig?.autoDownload && (videoUrl || videoData)) {
      await this.downloadVideo(videoUrl, videoData);
    }
  }

  // Path-sanitize a segment so Chrome's downloads API accepts it.
  // Strips characters Chrome rejects ( <>:"|?* ), trims, and guards against
  // empty strings / leading dots / path traversal.
  sanitizePathSegment(name, fallback) {
    const cleaned = (name || '')
      .replace(/[<>:"|?*\x00-\x1f]/g, '')
      .replace(/[\\/]+/g, '_')
      .replace(/^\.+/, '')
      .trim();
    return cleaned || fallback;
  }

  buildDownloadFilename() {
    const rawFolder = this.currentConfig?.downloadFolder || '';
    const folder = rawFolder
      .split('/')
      .map(seg => this.sanitizePathSegment(seg, ''))
      .filter(Boolean)
      .join('/');

    // Strip extension from the source image name: "image1.png" -> "image1"
    const rawImage = this.currentImageName || `grok-video-${Date.now()}`;
    const base = rawImage.replace(/\.[^./\\]+$/, '');
    const safeBase = this.sanitizePathSegment(base, `grok-video-${Date.now()}`);

    const filename = `${safeBase}_video.mp4`;
    return folder ? `${folder}/${filename}` : filename;
  }

  async downloadVideo(videoUrl, videoData) {
    try {
      const filename = this.buildDownloadFilename();

      if (videoData) {
        // Download from base64 data
        const blob = this.base64ToBlob(videoData, 'video/mp4');
        const blobUrl = URL.createObjectURL(blob);

        await chrome.downloads.download({
          url: blobUrl,
          filename: filename,
          saveAs: false
        });
      } else if (videoUrl) {
        // Download from URL
        await chrome.downloads.download({
          url: videoUrl,
          filename: filename,
          saveAs: false
        });
      }

      this.log(`Downloaded: ${filename}`, 'success');
    } catch (error) {
      this.log(`Download failed: ${error.message}`, 'error');
    }
  }

  base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  log(message, type = 'info') {
    console.log(`[GrokVideoGen] ${message}`);
    chrome.runtime.sendMessage({
      action: 'LOG',
      text: message,
      type: type
    }).catch(() => {});
  }

  notifyProgress() {
    chrome.runtime.sendMessage({
      action: 'PROGRESS',
      current: this.progress.current,
      total: this.progress.total
    }).catch(() => {});
  }

  notifyStateChange() {
    chrome.runtime.sendMessage({
      action: 'STATE_CHANGE',
      isRunning: this.isRunning
    }).catch(() => {});
  }
}

// Initialize generator
const generator = new GrokVideoGenerator();

// API IS WORKING
console.log('[Grok Video Generator] Background service worker initialized');
