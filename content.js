// Content script for Grok Video Generator
// This script runs on Grok pages and handles image upload and video generation

class GrokContentHandler {
  constructor() {
    this.isProcessing = false;
    this.knownVideoUrls = new Set();      // Video URLs present before generation
    this.downloadedUrls = new Set();      // Videos we've already sent for download
    this.sdVideoSrcAtSnapshot = null;     // The URL sitting in <video id="sd-video"> right before we submit
    this.init();
  }

  init() {
    console.log('[GrokVideoGen] Content script initialized');

    chrome.runtime.onMessage.addListener((message) => {
      this.handleMessage(message);
    });

    // Snapshot all existing videos so we don't auto-download them
    this.snapshotExistingVideos();
  }

  /**
   * Scan the page for any videos that are already present and record their URLs.
   * These will be excluded from auto-download.
   */
  snapshotExistingVideos() {
    const existingVideos = document.querySelectorAll('video');
    for (const video of existingVideos) {
      if (video.src) this.knownVideoUrls.add(video.src);
      if (video.currentSrc) this.knownVideoUrls.add(video.currentSrc);
      const sources = video.querySelectorAll('source');
      for (const source of sources) {
        if (source.src) this.knownVideoUrls.add(source.src);
      }
    }
    // Specifically record what URL (if any) is currently in Grok's result
    // container. A later change of THIS element's src = the new generation.
    const sd = document.getElementById('sd-video');
    this.sdVideoSrcAtSnapshot = sd ? (sd.src || sd.currentSrc || '') : null;
    console.log(`[GrokVideoGen] Snapshot — ${existingVideos.length} <video>(s) on page, ${this.knownVideoUrls.size} known URL(s). sd-video src at snapshot:`, this.sdVideoSrcAtSnapshot);
  }

  async handleMessage(message) {
    switch (message.action) {
      case 'GENERATE_VIDEO':
        await this.generateVideo(message.image, message.prompt);
        break;
    }
  }

  async generateVideo(image, prompt) {
    if (this.isProcessing) {
      this.sendError('Already processing a request');
      return;
    }

    this.isProcessing = true;

    try {
      // Refuse to run on the saved/history page — it contains old videos that
      // would otherwise be mistaken for a fresh generation.
      if (location.pathname.includes('/saved')) {
        throw new Error('On /imagine/saved page — not the generation form');
      }

      // Wait for page to be ready
      await this.waitForElement('textarea, [contenteditable="true"], input[type="text"]');

      // Upload the image FIRST — Grok's UI often swaps in a different prompt
      // field / reveals a modal after an image is attached, so anything we
      // found beforehand may be stale or hidden.
      await this.uploadImage(image);

      // Give the UI time to update after the upload (modal, new input, etc.)
      await this.delay(2500);

      // Now find the prompt input against the post-upload DOM
      const inputArea = await this.findInputArea();
      if (!inputArea) {
        throw new Error('Could not find prompt input after image upload');
      }

      // Enter the prompt
      await this.enterPrompt(inputArea, prompt);

      // Verify the value actually stuck before we submit
      const readValue = () => inputArea.value !== undefined ? inputArea.value : inputArea.textContent;
      if ((readValue() || '').trim() !== prompt.trim()) {
        throw new Error('Prompt failed to appear in input after entry');
      }

      // Snapshot RIGHT before submit, after the page has fully settled with
      // the prompt/image present. Any <video> in the DOM at this point is
      // pre-existing and must NOT be downloaded as the result of our generation.
      await this.delay(1200);
      this.snapshotExistingVideos();

      // Submit the request
      await this.submitRequest(inputArea);

      // Wait for video generation to complete
      await this.waitForVideoGeneration();

      this.isProcessing = false;
      this.safeSend({ action: 'GENERATION_COMPLETE' });

    } catch (error) {
      this.isProcessing = false;
      this.sendError(error.message);
    }
  }

  isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 20) return false;
    if (el.offsetParent === null) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  }

  async findInputArea() {
    // Collect every plausible text-entry element
    const candidates = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('div[role="textbox"]'),
      ...document.querySelectorAll('input[type="text"]')
    ];

    const visible = candidates.filter(el => this.isVisible(el));
    if (visible.length === 0) {
      console.warn('[GrokVideoGen] No visible input candidates found (scanned', candidates.length, ')');
      return null;
    }

    // Prefer the candidate with the longest placeholder text (main prompt
    // usually has something like "Describe the video you want to generate").
    const byPlaceholder = visible
      .filter(el => (el.placeholder || '').length > 0)
      .sort((a, b) => (b.placeholder || '').length - (a.placeholder || '').length);
    if (byPlaceholder.length > 0) {
      console.log('[GrokVideoGen] Input chosen by placeholder:', JSON.stringify(byPlaceholder[0].placeholder || ''));
      return byPlaceholder[0];
    }

    // Otherwise pick the visually largest one (usually the main prompt box)
    const byArea = visible.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    console.log('[GrokVideoGen] Input chosen by area:', byArea[0].tagName, byArea[0].getBoundingClientRect());
    return byArea[0];
  }

  async uploadImage(image) {
    // Find file input or create one
    let fileInput = document.querySelector('input[type="file"][accept*="image"]');

    if (!fileInput) {
      fileInput = document.querySelector('input[type="file"]');
    }

    if (!fileInput) {
      // Look for upload button and click it
      const uploadBtns = document.querySelectorAll(
        'button[aria-label*="image"], button[aria-label*="photo"], button[aria-label*="upload"], ' +
        'button[aria-label*="Image"], button[aria-label*="Upload"], ' +
        '[data-testid*="image"], [data-testid*="photo"], [data-testid*="upload"], ' +
        'button svg, label[for*="file"], label[for*="upload"]'
      );

      for (const btn of uploadBtns) {
        btn.click();
        await this.delay(500);
        fileInput = document.querySelector('input[type="file"]');
        if (fileInput) break;
      }
    }

    // Convert base64 to file
    const file = await this.base64ToFile(image.data, image.name, image.type);

    if (fileInput) {
      // Create DataTransfer to set files
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // Trigger change event
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Also try drag and drop on various elements
    await this.tryDragAndDrop(file);

    // Wait for upload to process
    await this.delay(2000);

    console.log('[GrokVideoGen] Image uploaded');
  }

  async tryDragAndDrop(file) {
    const dropZone = document.querySelector('[data-testid*="drop"], .drop-zone, [contenteditable="true"], textarea') || document.body;

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    const dropEvent = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransfer
    });

    dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
    dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
    dropZone.dispatchEvent(dropEvent);
  }

  async base64ToFile(base64Data, filename, mimeType) {
    // Remove data URL prefix if present
    const base64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;

    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });

    return new File([blob], filename, { type: mimeType });
  }

  async enterPrompt(inputArea, prompt) {
    inputArea.focus();
    inputArea.click();

    const isTextField = inputArea.tagName === 'TEXTAREA' || inputArea.tagName === 'INPUT';
    const isEditable = inputArea.isContentEditable || inputArea.contentEditable === 'true';

    const setValue = (val) => {
      if (isTextField) {
        const proto = inputArea.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(inputArea, val);
        inputArea.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (isEditable) {
        inputArea.textContent = val;
        inputArea.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
      }
    };

    // Clear first
    setValue('');
    await this.delay(50);

    // Strategy 1: native setter / textContent (React-friendly)
    setValue(prompt);
    inputArea.dispatchEvent(new Event('change', { bubbles: true }));
    await this.delay(200);

    const readValue = () => isTextField ? inputArea.value : inputArea.textContent;

    if (readValue().trim() === prompt.trim()) {
      console.log('[GrokVideoGen] Prompt entered via direct set (len', prompt.length + ')');
      await this.delay(300);
      return;
    }

    // Strategy 2: execCommand insertText (works for contenteditable and many text inputs)
    console.warn('[GrokVideoGen] Direct set did not stick — falling back to execCommand insertText');
    setValue('');
    await this.delay(50);
    inputArea.focus();
    try { document.execCommand('insertText', false, prompt); } catch (_) {}
    await this.delay(200);

    if (readValue().trim() === prompt.trim()) {
      console.log('[GrokVideoGen] Prompt entered via execCommand');
      await this.delay(300);
      return;
    }

    // Strategy 3: simulate typing character-by-character via InputEvent
    console.warn('[GrokVideoGen] execCommand failed — falling back to simulated typing');
    setValue('');
    await this.delay(50);
    for (const char of prompt) {
      const current = readValue();
      setValue(current + char);
      await this.delay(15);
    }

    if (readValue().trim() !== prompt.trim()) {
      console.error('[GrokVideoGen] Prompt entry FAILED. Got:', JSON.stringify(readValue()));
      throw new Error('Could not enter prompt into input field');
    }

    console.log('[GrokVideoGen] Prompt entered via simulated typing');
    await this.delay(300);
  }

  findSubmitButton(inputArea) {
    // 1) Form-based lookup
    const form = inputArea ? inputArea.closest('form') : null;
    if (form) {
      const byType = form.querySelector('button[type="submit"]');
      if (byType) return byType;
    }

    // 2) Walk up from the input and look for a submit-like button nearby.
    //    Prefer type="submit", then aria-label (Submit/Send/Generate).
    if (inputArea) {
      let container = inputArea.parentElement;
      for (let i = 0; i < 8 && container; i++) {
        const typed = container.querySelector('button[type="submit"]');
        if (typed) return typed;

        const labelled = Array.from(container.querySelectorAll('button')).find(b => {
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          const testid = (b.getAttribute('data-testid') || '').toLowerCase();
          return label.includes('submit') || label.includes('send') ||
                 label.includes('generate') || label.includes('create') ||
                 testid.includes('submit') || testid.includes('send') ||
                 testid.includes('generate');
        });
        if (labelled) return labelled;

        container = container.parentElement;
      }
    }

    // 3) Global fallback
    return document.querySelector('button[type="submit"]') ||
           document.querySelector('button[aria-label*="Submit" i]') ||
           document.querySelector('button[aria-label*="Send" i]') ||
           document.querySelector('button[aria-label*="Generate" i]');
  }

  async submitRequest(inputArea) {
    // Wait up to 15s for an ENABLED submit button. The button is typically
    // disabled while Grok is still processing the image upload, and firing
    // the click too early results in a silent no-op.
    const deadline = Date.now() + 15000;
    let btn = null;
    while (Date.now() < deadline) {
      btn = this.findSubmitButton(inputArea);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        break;
      }
      await this.delay(250);
    }

    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      const label = btn.getAttribute('aria-label') || btn.type || '(no label)';
      console.log('[GrokVideoGen] Submitting via button:', label, '— rect:', btn.getBoundingClientRect());
      btn.click();
      return;
    }

    // Fallback — try Enter key
    console.warn('[GrokVideoGen] No enabled submit button found within 15s — falling back to Enter key');
    if (inputArea) {
      const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      inputArea.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      inputArea.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      inputArea.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    }
  }

  async handleNewVideoFound(videoElement) {
    // Wait for the video to be sufficiently loaded (readyState >= 2 means HAVE_CURRENT_DATA)
    if (videoElement.readyState < 2) {
      console.log('[GrokVideoGen] Video detected but not ready yet, waiting for loadeddata...');
      await new Promise((resolve) => {
        const onReady = () => {
          videoElement.removeEventListener('loadeddata', onReady);
          resolve();
        };
        videoElement.addEventListener('loadeddata', onReady);
        // Fallback timeout in case the event never fires
        setTimeout(resolve, 15000);
      });
    }

    // Resolve the URL after loadeddata — Grok may mount the result via a
    // <source> child or only populate currentSrc, so check all of them.
    // Capturing here (not at function entry) also avoids reading an empty
    // src before the element has been wired up.
    let videoUrl = videoElement.src || videoElement.currentSrc || '';
    if (!videoUrl) {
      const source = videoElement.querySelector('source[src]');
      if (source) videoUrl = source.src;
    }

    if (videoUrl && !videoUrl.startsWith('blob:')) {
      this.downloadedUrls.add(videoUrl);
      console.log('[GrokVideoGen] New generated video found:', videoUrl.substring(0, 80));
      this.safeSend({ action: 'VIDEO_READY', videoUrl: videoUrl });
    } else if (videoUrl && videoUrl.startsWith('blob:')) {
      // Try to extract video data from blob
      try {
        this.downloadedUrls.add(videoUrl);
        const response = await fetch(videoUrl);
        const blob = await response.blob();
        const base64 = await this.blobToBase64(blob);
        console.log('[GrokVideoGen] New generated blob video extracted');
        this.safeSend({ action: 'VIDEO_READY', videoData: base64 });
      } catch (error) {
        console.log('[GrokVideoGen] Could not extract blob video');
      }
    }
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * A video URL counts as a Grok-generated result if it lives on assets.grok.com
   * and the path contains "generated_video". The UUIDs in the path make each
   * generation URL unique, so tracking-by-URL is reliable.
   */
  isGrokGeneratedUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('assets.grok.com') && url.includes('generated_video');
  }

  async waitForVideoGeneration() {
    return new Promise((resolve, reject) => {
      const maxWaitTime = 300000; // 5 minutes
      let settled = false;
      const log = (msg) => console.log('[GrokVideoGen][wait]', msg);

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        fn();
      };

      // Return the generated video element if one is present AND not already
      // handled (either pre-existing on this page or downloaded in this session).
      const findGenerated = () => {
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
          const url = v.src || v.currentSrc;
          if (!this.isGrokGeneratedUrl(url)) continue;
          if (this.knownVideoUrls.has(url)) continue;      // was on page at snapshot
          if (this.downloadedUrls.has(url)) continue;      // already downloaded
          return v;
        }
        return null;
      };

      const tryDeliver = async () => {
        if (settled) return false;
        const video = findGenerated();
        if (!video) return false;

        const url = video.src || video.currentSrc;
        log(`found generated: ${url.slice(0,120)} (readyState=${video.readyState}, duration=${video.duration})`);

        // If the video hasn't fully loaded yet, wait for it to do so —
        // then download. Don't bail on duration/readyState for the result URL;
        // with preload="auto" + autoplay it'll be ready quickly, but either
        // way we know this is a genuinely new generated URL.
        if (video.readyState < 2 || !video.duration || isNaN(video.duration) || video.duration <= 0) {
          await new Promise((res) => {
            const done = () => {
              video.removeEventListener('loadedmetadata', done);
              video.removeEventListener('loadeddata', done);
              video.removeEventListener('canplay', done);
              res();
            };
            video.addEventListener('loadedmetadata', done);
            video.addEventListener('loadeddata', done);
            video.addEventListener('canplay', done);
            setTimeout(res, 15000); // fallback
          });
        }

        if (settled) return true;
        log(`delivering ${url.slice(0,120)}`);
        finish(async () => {
          await this.handleNewVideoFound(video);
          resolve();
        });
        return true;
      };

      // Poll every second for a matching generated video
      const poll = setInterval(async () => {
        if (settled) return;
        if (await tryDeliver()) return;

        // Surface explicit error banners so we don't wait the full 5 min
        const errs = document.querySelectorAll('[data-testid*="error"], .error-message, [role="alert"]');
        for (const err of errs) {
          const text = (err.textContent || '').toLowerCase();
          if (text.includes('error') || text.includes('failed')) {
            finish(() => reject(new Error(err.textContent.trim().slice(0, 200))));
            return;
          }
        }
      }, 1000);

      const timeout = setTimeout(() => {
        finish(() => reject(new Error('Video generation timeout')));
      }, maxWaitTime);

      log(`waiting — known URLs: ${this.knownVideoUrls.size}, downloaded: ${this.downloadedUrls.size}`);
    });
  }

  waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        const element = document.querySelector(selector);
        if (element) {
          resolve(element);
        } else {
          reject(new Error(`Element ${selector} not found`));
        }
      }, timeout);
    });
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Wrap runtime.sendMessage so a missing receiver (popup closed, background
  // restarting) doesn't surface as an unhandled "Could not establish
  // connection. Receiving end does not exist." error.
  safeSend(payload) {
    try {
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  }

  sendError(message) {
    this.safeSend({ action: 'GENERATION_ERROR', error: message });
  }
}

// Initialize content handler
const handler = new GrokContentHandler();

// API IS WORKING
