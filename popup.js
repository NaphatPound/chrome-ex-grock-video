// Popup script for Grok Video Generator

class GrokVideoPopup {
  constructor() {
    this.images = [];
    this.isRunning = false;
    this.init();
  }

  async init() {
    this.bindElements();
    this.bindEvents();
    await this.loadSettings();
    await this.syncState();
  }

  bindElements() {
    this.elements = {
      prompt: document.getElementById('prompt'),
      imageInput: document.getElementById('imageInput'),
      imagePreview: document.getElementById('imagePreview'),
      loopCount: document.getElementById('loopCount'),
      delayBetween: document.getElementById('delayBetween'),
      autoDownload: document.getElementById('autoDownload'),
      continuousMode: document.getElementById('continuousMode'),
      startBtn: document.getElementById('startBtn'),
      stopBtn: document.getElementById('stopBtn'),
      progressBar: document.getElementById('progressBar'),
      progressText: document.getElementById('progressText'),
      logContainer: document.getElementById('logContainer'),
      clearLogBtn: document.getElementById('clearLogBtn'),
      openGrokBtn: document.getElementById('openGrokBtn'),
      statusDot: document.getElementById('statusDot'),
      statusText: document.getElementById('statusText')
    };
  }

  bindEvents() {
    this.elements.imageInput.addEventListener('change', (e) => this.handleImageSelect(e));
    this.elements.startBtn.addEventListener('click', () => this.startGeneration());
    this.elements.stopBtn.addEventListener('click', () => this.stopGeneration());
    this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
    this.elements.openGrokBtn.addEventListener('click', () => this.openGrok());

    // Save settings on change
    ['prompt', 'loopCount', 'delayBetween'].forEach(id => {
      this.elements[id].addEventListener('change', () => this.saveSettings());
    });
    ['autoDownload', 'continuousMode'].forEach(id => {
      this.elements[id].addEventListener('change', () => this.saveSettings());
    });

    // Listen for messages from background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message);
    });
  }

  async loadSettings() {
    const settings = await chrome.storage.local.get([
      'prompt', 'loopCount', 'delayBetween', 'autoDownload', 'continuousMode', 'logs'
    ]);

    if (settings.prompt) this.elements.prompt.value = settings.prompt;
    if (settings.loopCount) this.elements.loopCount.value = settings.loopCount;
    if (settings.delayBetween) this.elements.delayBetween.value = settings.delayBetween;
    if (settings.autoDownload !== undefined) this.elements.autoDownload.checked = settings.autoDownload;
    if (settings.continuousMode !== undefined) this.elements.continuousMode.checked = settings.continuousMode;
    if (settings.logs) {
      settings.logs.forEach(log => this.addLogEntry(log.message, log.type, false));
    }
  }

  async saveSettings() {
    await chrome.storage.local.set({
      prompt: this.elements.prompt.value,
      loopCount: parseInt(this.elements.loopCount.value),
      delayBetween: parseInt(this.elements.delayBetween.value),
      autoDownload: this.elements.autoDownload.checked,
      continuousMode: this.elements.continuousMode.checked
    });
  }

  async syncState() {
    const state = await chrome.storage.local.get(['isRunning', 'progress']);
    this.isRunning = state.isRunning || false;
    this.updateUI();

    if (state.progress) {
      this.updateProgress(state.progress.current, state.progress.total);
    }
  }

  handleImageSelect(event) {
    const files = Array.from(event.target.files);
    this.images = [];
    this.elements.imagePreview.innerHTML = '';

    files.forEach((file, index) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        this.images.push({
          name: file.name,
          data: e.target.result,
          type: file.type
        });

        const item = document.createElement('div');
        item.className = 'image-item';
        item.innerHTML = `
          <img src="${e.target.result}" alt="${file.name}">
          <button class="remove-btn" data-index="${index}">×</button>
        `;
        item.querySelector('.remove-btn').addEventListener('click', () => {
          this.images.splice(index, 1);
          item.remove();
        });
        this.elements.imagePreview.appendChild(item);
      };
      reader.readAsDataURL(file);
    });

    this.addLogEntry(`Selected ${files.length} image(s)`, 'info');
  }

  async startGeneration() {
    const prompt = this.elements.prompt.value.trim();
    if (!prompt) {
      this.addLogEntry('Please enter a prompt', 'error');
      return;
    }

    if (this.images.length === 0) {
      this.addLogEntry('Please select at least one image', 'error');
      return;
    }

    await this.saveSettings();

    const config = {
      prompt,
      images: this.images,
      loopCount: parseInt(this.elements.loopCount.value),
      delayBetween: parseInt(this.elements.delayBetween.value) * 1000,
      autoDownload: this.elements.autoDownload.checked,
      continuousMode: this.elements.continuousMode.checked
    };

    // Send to background script
    chrome.runtime.sendMessage({
      action: 'START_GENERATION',
      config
    });

    this.isRunning = true;
    this.updateUI();
    this.addLogEntry('Starting video generation...', 'info');
  }

  async stopGeneration() {
    chrome.runtime.sendMessage({ action: 'STOP_GENERATION' });
    this.isRunning = false;
    this.updateUI();
    this.addLogEntry('Generation stopped', 'warning');
  }

  updateUI() {
    this.elements.startBtn.disabled = this.isRunning;
    this.elements.stopBtn.disabled = !this.isRunning;
    this.elements.statusDot.className = 'status-dot ' + (this.isRunning ? 'running' : 'ready');
    this.elements.statusText.textContent = this.isRunning ? 'Running...' : 'Ready';
  }

  updateProgress(current, total) {
    const percent = total > 0 ? (current / total) * 100 : 0;
    this.elements.progressBar.style.width = `${percent}%`;
    this.elements.progressText.textContent = `${current} / ${total} completed`;
  }

  handleMessage(message) {
    switch (message.action) {
      case 'LOG':
        this.addLogEntry(message.text, message.type);
        break;
      case 'PROGRESS':
        this.updateProgress(message.current, message.total);
        break;
      case 'STATE_CHANGE':
        this.isRunning = message.isRunning;
        this.updateUI();
        break;
      case 'ERROR':
        this.addLogEntry(message.text, 'error');
        this.elements.statusDot.className = 'status-dot error';
        break;
    }
  }

  addLogEntry(message, type = 'info', save = true) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="timestamp">[${time}]</span> ${message}`;
    this.elements.logContainer.appendChild(entry);
    this.elements.logContainer.scrollTop = this.elements.logContainer.scrollHeight;

    if (save) {
      this.saveLog(message, type);
    }
  }

  async saveLog(message, type) {
    const logs = (await chrome.storage.local.get('logs')).logs || [];
    logs.push({ message, type, timestamp: Date.now() });
    // Keep only last 100 logs
    if (logs.length > 100) logs.shift();
    await chrome.storage.local.set({ logs });
  }

  async clearLog() {
    this.elements.logContainer.innerHTML = '';
    await chrome.storage.local.set({ logs: [] });
    this.addLogEntry('Log cleared', 'info');
  }

  openGrok() {
    chrome.tabs.create({ url: 'https://grok.com/imagine' });
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  new GrokVideoPopup();
});
