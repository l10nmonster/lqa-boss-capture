/**
 * Cart Management and Main UI Logic
 */

/**
 * Generate a 3-character random suffix for uniqueness
 */
function generateRandomSuffix() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return suffix;
}

/**
 * Generate filename based on job name or timestamp
 */
function generateFileName(jobName) {
  if (jobName && jobName.trim()) {
    // Use job name with random suffix
    const cleanName = jobName.trim().replace(/[^a-zA-Z0-9-_]/g, '-');
    const suffix = generateRandomSuffix();
    return `${cleanName}-${suffix}.lqaboss`;
  } else {
    // Use timestamp (existing behavior)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    return `lqa-flow-${timestamp}.lqaboss`;
  }
}

class CartManager {
  constructor() {
    this.capturedPages = [];
    this.currentTab = null;
    this.port = null;
    this.currentSegmentCount = 0;
    this.init();
  }

  async init() {
    // Create persistent port connection to background script
    // When panel closes, this port will disconnect
    this.port = chrome.runtime.connect({ name: 'sidepanel' });

    this.port.onDisconnect.addListener(() => {
      // Panel is closing, cleanup handled by background
    });

    // Listen for messages from background script
    this.port.onMessage.addListener(async (msg) => {
      if (msg.action === 'page-reloaded') {
        await this.updateCurrentTab();
        await this.enableXRay();
      }
    });

    // Load captured pages from storage
    const result = await chrome.storage.local.get(['capturedPages', 'instructions']);
    if (result.capturedPages && result.capturedPages.length > 0) {
      this.capturedPages = result.capturedPages;
    }

    // Load instructions from storage
    if (result.instructions) {
      const instructionsField = document.getElementById('instructions');
      if (instructionsField) {
        instructionsField.value = result.instructions;
      }
    }

    // Get current tab
    await this.updateCurrentTab();

    // Setup event listeners
    this.setupEventListeners();

    // Listen for messages from content scripts
    chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
      if (request.action === 'segment-count-updated') {
        this.updateSegmentCount(request.count);
      }
    });

    // Update UI
    this.render();

    // Auto-enable X-ray when panel opens
    await this.enableXRay();

    // Disable X-ray when panel closes
    window.addEventListener('pagehide', () => {
      if (this.currentTab) {
        chrome.tabs.sendMessage(this.currentTab.id, {
          action: 'toggle-xray',
          enabled: false,
          segments: []
        }).catch(() => {
          // Ignore errors - tab may be closed
        });
      }
    });
  }

  async updateCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTab = tab;
  }

  setupEventListeners() {
    // Capture button
    document.getElementById('capture-btn').addEventListener('click', async () => {
      await this.capturePage();
    });

    // Clear cart
    document.getElementById('clear-cart-btn').addEventListener('click', async () => {
      await this.clearCart();
    });

    // Send to PWA
    document.getElementById('send-to-pwa-btn').addEventListener('click', async () => {
      await this.sendToPWA();
    });

    // Download ZIP
    document.getElementById('download-btn').addEventListener('click', async () => {
      await this.downloadZIP();
    });

    // Listen for tab changes - disable X-ray and re-enable for new tab
    chrome.tabs.onActivated.addListener(async () => {
      await this.disableXRay();
      await this.updateCurrentTab();
      await this.enableXRay();
    });

    // Warnings modal close buttons
    document.getElementById('close-modal-btn').addEventListener('click', () => {
      this.hideWarningsModal();
    });

    document.getElementById('modal-ok-btn').addEventListener('click', () => {
      this.hideWarningsModal();
    });

    // Close modal when clicking overlay
    document.querySelector('.modal-overlay').addEventListener('click', () => {
      this.hideWarningsModal();
    });

    // Save instructions to storage when they change
    const instructionsField = document.getElementById('instructions');
    if (instructionsField) {
      instructionsField.addEventListener('input', async () => {
        const instructions = instructionsField.value.trim();
        await chrome.storage.local.set({ instructions });
      });
    }
  }

  async capturePage() {
    const captureBtn = document.getElementById('capture-btn');
    const originalText = captureBtn.textContent;

    try {
      // Update current tab
      await this.updateCurrentTab();

      if (!this.currentTab) {
        this.showStatus('No active tab found', 'error');
        return;
      }

      // Check if URL is restricted
      const url = this.currentTab.url || '';

      if (!url || url === 'about:blank') {
        this.showStatus('Cannot capture empty page', 'error');
        return;
      }

      const restrictedProtocols = [
        'chrome:',
        'edge:',
        'about:',
        'chrome-extension:',
        'data:',
        'view-source:',
        'chrome-search:',
        'devtools:'
      ];

      const isRestricted = restrictedProtocols.some(protocol => url.startsWith(protocol)) ||
                          url.includes('chrome.google.com/webstore');

      if (isRestricted) {
        this.showStatus('Cannot capture restricted pages', 'error');
        return;
      }

      // Show loading state
      captureBtn.disabled = true;
      captureBtn.innerHTML = '<span class="spinner"></span> Capturing...';

      // Request capture from background script
      const response = await chrome.runtime.sendMessage({
        action: 'capture-page',
        tabId: this.currentTab.id
      });

      if (response.success) {
        // Add to cart
        this.capturedPages.push(response.data);
        await this.render();
        this.showStatus(`Captured: ${response.data.title || 'Page'}`, 'success');

        // Re-enable X-ray with color-coded segments (green/red)
        await this.showXRayWithSegments(response.data.segments);

        // Show warnings modal if warnings exist
        if (response.data.warnings && response.data.warnings.length > 0) {
          this.showWarningsModal(response.data.warnings);
        }
      } else {
        this.showStatus(`Capture failed: ${response.error}`, 'error');

        // Re-enable X-ray after failed capture
        await this.enableXRay();
      }
    } catch (error) {
      console.error('Capture error:', error);
      this.showStatus(`Capture failed: ${error.message}`, 'error');

      // Re-enable X-ray after failed capture
      await this.enableXRay();
    } finally {
      // Restore button state
      captureBtn.disabled = false;
      captureBtn.textContent = originalText;
    }
  }

  async enableXRay() {
    try {
      await this.updateCurrentTab();
      if (!this.currentTab) {
        this.updateSegmentCount(0);
        return;
      }

      // Check if URL is accessible
      const url = this.currentTab.url || '';

      // Skip restricted URLs or empty URLs
      if (!url || url === 'about:blank') {
        this.updateSegmentCount(0);
        return;
      }

      const restrictedProtocols = [
        'chrome:',
        'edge:',
        'about:',
        'chrome-extension:',
        'data:',
        'view-source:',
        'chrome-search:',
        'devtools:'
      ];

      // Also block Chrome Web Store
      const isRestricted = restrictedProtocols.some(protocol => url.startsWith(protocol)) ||
                          url.includes('chrome.google.com/webstore');

      if (isRestricted) {
        this.updateSegmentCount(0);
        return;
      }

      // Check if page was already captured
      const lastPage = this.capturedPages
        .slice()
        .reverse()
        .find(p => p.url === this.currentTab.url);

      let segments = [];

      if (lastPage) {
        // Use captured segments
        segments = lastPage.segments;
      } else {
        // Extract metadata on-demand
        await chrome.scripting.executeScript({
          target: { tabId: this.currentTab.id },
          files: ['content/extractor.js']
        });

        const response = await chrome.tabs.sendMessage(this.currentTab.id, {
          action: 'extract-metadata'
        });

        if (response && response.textElements) {
          segments = response.textElements;
        }
      }

      // Update segment count
      this.updateSegmentCount(segments.length);

      // Inject and enable X-ray overlay
      await chrome.scripting.executeScript({
        target: { tabId: this.currentTab.id },
        files: ['content/xray-overlay.js']
      });

      await chrome.tabs.sendMessage(this.currentTab.id, {
        action: 'toggle-xray',
        enabled: true,
        segments
      });
    } catch {
      // Silently fail for restricted pages, permission errors, or other errors
      this.updateSegmentCount(0);
    }
  }

  async disableXRay() {
    try {
      if (!this.currentTab) return;

      this.updateSegmentCount(0);

      await chrome.tabs.sendMessage(this.currentTab.id, {
        action: 'toggle-xray',
        enabled: false,
        segments: []
      });
    } catch {
      // Silently fail - tab may have been closed or navigated away
    }
  }

  async showXRayWithSegments(segments) {
    try {
      await this.updateCurrentTab();
      if (!this.currentTab) return;

      // Update segment count
      this.updateSegmentCount(segments.length);

      // Inject x-ray overlay script
      await chrome.scripting.executeScript({
        target: { tabId: this.currentTab.id },
        files: ['content/xray-overlay.js']
      });

      // Enable X-ray with provided segments
      await chrome.tabs.sendMessage(this.currentTab.id, {
        action: 'toggle-xray',
        enabled: true,
        segments
      });
    } catch (error) {
      console.error('Failed to show X-Ray:', error);
    }
  }

  updateSegmentCount(count) {
    this.currentSegmentCount = count;
    const countEl = document.getElementById('segment-count');
    if (countEl) {
      countEl.textContent = count;
    }

    // Enable/disable capture button based on segment count
    const captureBtn = document.getElementById('capture-btn');
    if (captureBtn) {
      captureBtn.disabled = count === 0;
    }
  }

  async clearCart() {
    if (this.capturedPages.length === 0) return;

    const confirmed = confirm(`Clear all ${this.capturedPages.length} captured pages?`);
    if (confirmed) {
      this.capturedPages = [];
      await this.render();
      this.showStatus('Cart cleared', 'info');
    }
  }

  async removePage(index) {
    const page = this.capturedPages[index];
    const confirmed = confirm(`Remove "${page.title || page.url}"?`);

    if (confirmed) {
      this.capturedPages.splice(index, 1);
      await this.render();
      this.showStatus('Page removed', 'info');
    }
  }

  async sendToPWA() {
    const sendBtn = document.getElementById('send-to-pwa-btn');
    const originalText = sendBtn.textContent;

    try {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<span class="spinner"></span> Creating flow...';

      const instructions = document.getElementById('instructions').value.trim();
      const settings = settingsManager.getSettings();

      // Create ZIP
      const zipResponse = await chrome.runtime.sendMessage({
        action: 'create-flow',
        pages: this.capturedPages,
        instructions,
        settings
      });

      if (!zipResponse.success) {
        throw new Error(zipResponse.error);
      }

      sendBtn.innerHTML = '<span class="spinner"></span> Opening LQA Boss...';

      // Generate filename based on job name or timestamp
      const fileName = generateFileName(settings.jobName);

      // Send ZIP data to background to hold temporarily
      await chrome.runtime.sendMessage({
        action: 'store-pending-flow',
        zipData: zipResponse.zipData,
        fileName
      });

      // Get PWA URL from settings
      const baseUrl = settings.pwaUrl || 'https://lqaboss.l10n.monster';
      const pwaUrl = `${baseUrl}/?plugin=extension`;

      // Open PWA in new tab
      const _tab = await chrome.tabs.create({ url: pwaUrl });

      // If this is the production URL, show a helpful message about opening in the app
      if (baseUrl.includes('lqaboss.l10n.monster')) {
        this.showStatus('Flow sent! Click "Open in app" button in the address bar to open in LQA Boss', 'success');
      } else {
        this.showStatus('Flow sent to LQA Boss successfully!', 'success');
      }

      // Clear cart after successful send
      setTimeout(() => {
        this.clearCartSilent();
      }, 1000);
    } catch (error) {
      console.error('[Cart] Send to LQA Boss error:', error);
      this.showStatus(`Failed to send to LQA Boss: ${error.message}`, 'error');
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = originalText;
    }
  }

  async downloadZIP() {
    const downloadBtn = document.getElementById('download-btn');
    const originalText = downloadBtn.textContent;

    try {
      downloadBtn.disabled = true;
      downloadBtn.innerHTML = '<span class="spinner"></span> Creating file...';

      const instructions = document.getElementById('instructions').value.trim();
      const settings = settingsManager.getSettings();

      // Create ZIP
      const response = await chrome.runtime.sendMessage({
        action: 'create-flow',
        pages: this.capturedPages,
        instructions,
        settings
      });

      if (!response.success) {
        throw new Error(response.error);
      }

      // Convert array back to Uint8Array then to Blob
      const uint8Array = new Uint8Array(response.zipData);
      const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);

      // Generate filename based on job name or timestamp
      const filename = generateFileName(settings.jobName);

      chrome.downloads.download({
        url,
        filename,
        saveAs: true,
        conflictAction: 'uniquify'
      });

      this.showStatus(`Downloading ${filename}...`, 'success');

      // Cleanup
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Download error:', error);
      this.showStatus(`Download failed: ${error.message}`, 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = originalText;
    }
  }

  async clearCartSilent() {
    this.capturedPages = [];
    await this.render();
  }

  showWarningsModal(warnings) {
    const modal = document.getElementById('warnings-modal');
    const warningsList = document.getElementById('warnings-list');

    // Clear previous warnings
    warningsList.innerHTML = '';

    // Add each warning as a list item
    warnings.forEach(warning => {
      const li = document.createElement('li');
      li.textContent = warning;
      warningsList.appendChild(li);
    });

    // Show modal
    modal.classList.remove('hidden');
  }

  hideWarningsModal() {
    const modal = document.getElementById('warnings-modal');
    modal.classList.add('hidden');
  }

  async render() {
    const count = this.capturedPages.length;
    document.getElementById('page-count').textContent = count;

    const cartList = document.getElementById('cart-list');
    const clearBtn = document.getElementById('clear-cart-btn');
    const sendBtn = document.getElementById('send-to-pwa-btn');
    const downloadBtn = document.getElementById('download-btn');

    // Enable/disable buttons
    const hasPages = count > 0;
    clearBtn.disabled = !hasPages;
    sendBtn.disabled = !hasPages;
    downloadBtn.disabled = !hasPages;

    // Sync cart to storage for service worker access
    await chrome.storage.local.set({ capturedPages: this.capturedPages });

    // Render cart items
    if (count === 0) {
      cartList.innerHTML = `
        <div class="empty-state">
          <p>No pages captured yet</p>
          <p class="hint">Click "Capture Page" to start</p>
        </div>
      `;
      return;
    }

    cartList.innerHTML = this.capturedPages
      .map((page, index) => this.renderCartItem(page, index))
      .join('');

    // Add event listeners to remove buttons
    cartList.querySelectorAll('.remove-page-btn').forEach((btn, index) => {
      btn.addEventListener('click', async () => await this.removePage(index));
    });
  }

  renderCartItem(page, _index) {
    const segmentCount = page.segments.length;
    const matchedCount = page.matchedCount || 0;
    const timestamp = new Date(page.timestamp).toLocaleTimeString();

    // Extract hostname and path from URL
    let hostname = page.url;
    let urlPath = '/';
    try {
      const url = new URL(page.url);
      hostname = url.hostname;
      urlPath = url.pathname + url.search + url.hash;
      if (urlPath === '/') urlPath = '/';
    } catch {
      // Keep full URL if parsing fails
    }

    // Build segments info with matched count
    let segmentsInfo = `${segmentCount} segment${segmentCount !== 1 ? 's' : ''}`;
    if (matchedCount > 0) {
      segmentsInfo += ` (${matchedCount} matched)`;
    }

    return `
      <div class="cart-item">
        <div class="cart-item-content">
          <div class="cart-item-title">${hostname}</div>
          <div class="cart-item-url" title="${page.url}">${urlPath}</div>
          <div class="cart-item-meta">
            ${segmentsInfo} • ${timestamp}
          </div>
        </div>
        <div class="cart-item-actions">
          <button class="btn-danger remove-page-btn">Remove</button>
        </div>
      </div>
    `;
  }

  showStatus(message, type = 'info') {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = `status visible ${type}`;

    // Show longer for success messages that require user action
    const duration = message.includes('Open in app') ? 15000 : 10000;

    setTimeout(() => {
      statusEl.classList.remove('visible');
    }, duration);
  }
}

// Initialize cart when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new CartManager();
  });
} else {
  new CartManager();
}
