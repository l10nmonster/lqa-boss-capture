/**
 * Cart Management and Main UI Logic
 */

import type {
  Segment,
  CapturedPage,
  RuntimeMessage as BaseRuntimeMessage,
  RuntimeResponse as BaseRuntimeResponse
} from '../types/shared.js';

// Extension-specific CapturedPage with additional fields
interface ExtendedCapturedPage extends CapturedPage {
  matchedTUs?: any[];
  matchedCount?: number;
  favicon?: string;
  warnings?: string[];
}

// Extension-specific runtime message types
interface RuntimeMessage extends BaseRuntimeMessage {
  tabId?: number;
  pages?: ExtendedCapturedPage[];
  instructions?: string;
  settings?: any;
  zipData?: number[];
  fileName?: string;
  enabled?: boolean;
  segments?: Segment[];
}

interface RuntimeResponse extends BaseRuntimeResponse {
  data?: any;
  error?: string;
  zipData?: number[];
  textElements?: Segment[];
  wasVisible?: boolean;
}

/**
 * Generate a 3-character random suffix for uniqueness
 */
function generateRandomSuffix(): string {
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
function generateFileName(jobName: string): string {
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
  private capturedPages: CapturedPage[] = [];
  private currentTab: chrome.tabs.Tab | null = null;
  private port: chrome.runtime.Port | null = null;
  private currentSegmentCount: number = 0;
  private tmEndpointConfigured: boolean = false;
  // Track user preference for X-ray (false means user manually disabled it)
  private xrayUserEnabled: boolean = true;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Create persistent port connection to background script
    // When panel closes, this port will disconnect
    this.port = chrome.runtime.connect({ name: 'sidepanel' });

    this.port.onDisconnect.addListener(() => {
      // Panel is closing, cleanup handled by background
    });

    // Listen for messages from background script
    this.port.onMessage.addListener(async (msg: RuntimeMessage) => {
      if (msg.action === 'page-reloaded') {
        await this.updateCurrentTab();
        // Only re-enable X-ray if user hasn't manually disabled it
        if (this.xrayUserEnabled) {
          await this.enableXRay();
        }
      }
    });

    // Load captured pages from storage
    const result = await chrome.storage.local.get(['capturedPages', 'instructions']);
    if (result.capturedPages && result.capturedPages.length > 0) {
      this.capturedPages = result.capturedPages;
    }

    // Load instructions from storage
    if (result.instructions) {
      const instructionsField = document.getElementById('instructions') as HTMLTextAreaElement;
      if (instructionsField) {
        instructionsField.value = result.instructions;
      }
    }

    // Get current tab
    await this.updateCurrentTab();

    // Setup event listeners
    this.setupEventListeners();

    // Listen for messages from content scripts and background
    chrome.runtime.onMessage.addListener((request: RuntimeMessage, _sender, _sendResponse) => {
      if (request.action === 'segment-count-updated') {
        this.updateSegmentCount((request as any).count);
      } else if (request.action === 'xray-state-changed') {
        const enabled = (request as any).enabled;
        this.xrayUserEnabled = enabled;
        this.updateXrayCheckbox(enabled);
      }
    });

    // Check TM endpoint configuration
    await this.updateTMEndpointStatus();

    // Listen for storage changes (settings updates)
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes.lqaboss_settings) {
        this.updateTMEndpointStatus();
      }
    });

    // Update UI
    this.render();

    // Auto-enable X-ray when panel opens
    await this.enableXRay();

    // Disable X-ray when panel closes
    window.addEventListener('pagehide', () => {
      if (this.currentTab) {
        const message: RuntimeMessage = {
          action: 'toggle-xray',
          enabled: false,
          segments: []
        };
        chrome.tabs.sendMessage(this.currentTab.id!, message).catch(() => {
          // Ignore errors - tab may be closed
        });
      }
    });
  }

  private async updateCurrentTab(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTab = tab;
  }

  private async updateTMEndpointStatus(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get('lqaboss_settings');
      const settings = result.lqaboss_settings || {};
      this.tmEndpointConfigured = Boolean(settings.tmEndpointUrl && settings.tmEndpointUrl.trim());
      this.updateCaptureButtonState();
    } catch {
      this.tmEndpointConfigured = false;
      this.updateCaptureButtonState();
    }
  }

  private updateCaptureButtonState(): void {
    const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
    if (!captureBtn) return;

    if (!this.tmEndpointConfigured) {
      captureBtn.disabled = true;
      captureBtn.title = 'Configure TM Lookup URL in settings to enable capture';
    } else if (this.currentSegmentCount === 0) {
      captureBtn.disabled = true;
      captureBtn.title = 'No segments detected on this page';
    } else {
      captureBtn.disabled = false;
      captureBtn.title = '';
    }
  }

  private setupEventListeners(): void {
    // Capture button
    document.getElementById('capture-btn')?.addEventListener('click', async () => {
      await this.capturePage();
    });

    // Clear cart
    document.getElementById('clear-cart-btn')?.addEventListener('click', async () => {
      await this.clearCart();
    });

    // Send to PWA
    document.getElementById('send-to-pwa-btn')?.addEventListener('click', async () => {
      await this.sendToPWA();
    });

    // Download ZIP
    document.getElementById('download-btn')?.addEventListener('click', async () => {
      await this.downloadZIP();
    });

    // X-Ray checkbox toggle
    const xrayCheckbox = document.getElementById('xray-checkbox') as HTMLInputElement;
    if (xrayCheckbox) {
      xrayCheckbox.addEventListener('change', async () => {
        await this.setXrayEnabled(xrayCheckbox.checked);
      });
    }

    // Listen for tab changes - disable X-ray and re-enable for new tab
    chrome.tabs.onActivated.addListener(async () => {
      await this.disableXRay();
      await this.updateCurrentTab();
      await this.enableXRay();
    });

    // Warnings modal close buttons
    document.getElementById('close-modal-btn')?.addEventListener('click', () => {
      this.hideWarningsModal();
    });

    document.getElementById('modal-ok-btn')?.addEventListener('click', () => {
      this.hideWarningsModal();
    });

    // Close modal when clicking overlay
    document.querySelector('.modal-overlay')?.addEventListener('click', () => {
      this.hideWarningsModal();
    });

    // Save instructions to storage when they change
    const instructionsField = document.getElementById('instructions') as HTMLTextAreaElement;
    if (instructionsField) {
      instructionsField.addEventListener('input', async () => {
        const instructions = instructionsField.value.trim();
        await chrome.storage.local.set({ instructions });
      });
    }
  }

  private async capturePage(): Promise<void> {
    const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
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
      const message: RuntimeMessage = {
        action: 'capture-page',
        tabId: this.currentTab.id
      };
      const response = await chrome.runtime.sendMessage(message) as RuntimeResponse;

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
      const err = error as Error;
      console.error('Capture error:', error);
      this.showStatus(`Capture failed: ${err.message}`, 'error');

      // Re-enable X-ray after failed capture
      await this.enableXRay();
    } finally {
      // Restore button state
      captureBtn.textContent = originalText;
      this.updateCaptureButtonState();
    }
  }

  private async enableXRay(): Promise<void> {
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
        .find(p => p.originalUrl === this.currentTab!.url);

      let segments: Segment[] = [];

      if (lastPage) {
        // Use captured segments
        segments = lastPage.segments;
      } else {
        // Extract metadata on-demand
        await chrome.scripting.executeScript({
          target: { tabId: this.currentTab.id! },
          files: ['content/extractor.js']
        });

        const message: RuntimeMessage = {
          action: 'extract-metadata'
        };
        const response = await chrome.tabs.sendMessage(this.currentTab.id!, message) as RuntimeResponse;

        if (response && response.textElements) {
          segments = response.textElements;
        }
      }

      // Update segment count
      this.updateSegmentCount(segments.length);

      // Inject and enable X-ray overlay
      await chrome.scripting.executeScript({
        target: { tabId: this.currentTab.id! },
        files: ['content/xray-overlay.js']
      });

      const xrayMessage: RuntimeMessage = {
        action: 'toggle-xray',
        enabled: true,
        segments
      };
      await chrome.tabs.sendMessage(this.currentTab.id!, xrayMessage);
    } catch {
      // Silently fail for restricted pages, permission errors, or other errors
      this.updateSegmentCount(0);
    }
  }

  private async disableXRay(): Promise<void> {
    try {
      if (!this.currentTab) return;

      this.updateSegmentCount(0);

      const message: RuntimeMessage = {
        action: 'toggle-xray',
        enabled: false,
        segments: []
      };
      await chrome.tabs.sendMessage(this.currentTab.id!, message);
    } catch {
      // Silently fail - tab may have been closed or navigated away
    }
  }

  private async setXrayEnabled(enabled: boolean): Promise<void> {
    this.xrayUserEnabled = enabled;

    if (enabled) {
      // Re-extract segments when enabling X-ray
      // This handles cases where page content changed (modals, dynamic content)
      await this.enableXRay();
    } else {
      // Just disable X-ray without re-extraction
      try {
        if (!this.currentTab) return;

        const message: RuntimeMessage = {
          action: 'setXrayEnabled',
          enabled: false
        };
        await chrome.tabs.sendMessage(this.currentTab.id!, message);
      } catch {
        // Silently fail - content script may not be injected
      }
    }
  }

  private updateXrayCheckbox(enabled: boolean): void {
    const checkbox = document.getElementById('xray-checkbox') as HTMLInputElement;
    if (checkbox) {
      checkbox.checked = enabled;
    }
  }

  private async showXRayWithSegments(segments: Segment[]): Promise<void> {
    try {
      await this.updateCurrentTab();
      if (!this.currentTab) return;

      // Update segment count
      this.updateSegmentCount(segments.length);

      // Inject x-ray overlay script
      await chrome.scripting.executeScript({
        target: { tabId: this.currentTab.id! },
        files: ['content/xray-overlay.js']
      });

      // Enable X-ray with provided segments
      const message: RuntimeMessage = {
        action: 'toggle-xray',
        enabled: true,
        segments
      };
      await chrome.tabs.sendMessage(this.currentTab.id!, message);
    } catch (error) {
      console.error('Failed to show X-Ray:', error);
    }
  }

  private updateSegmentCount(count: number): void {
    this.currentSegmentCount = count;
    const countEl = document.getElementById('segment-count');
    if (countEl) {
      countEl.textContent = count.toString();
    }

    // Update capture button state (considers both segment count and TM endpoint)
    this.updateCaptureButtonState();
  }

  private async clearCart(): Promise<void> {
    if (this.capturedPages.length === 0) return;

    const confirmed = confirm(`Clear all ${this.capturedPages.length} captured pages?`);
    if (confirmed) {
      this.capturedPages = [];
      await this.render();
      this.showStatus('Cart cleared', 'info');
    }
  }

  private async removePage(index: number): Promise<void> {
    const page = this.capturedPages[index];
    const confirmed = confirm(`Remove "${page.title || page.originalUrl}"?`);

    if (confirmed) {
      this.capturedPages.splice(index, 1);
      await this.render();
      this.showStatus('Page removed', 'info');
    }
  }

  private async sendToPWA(): Promise<void> {
    const sendBtn = document.getElementById('send-to-pwa-btn') as HTMLButtonElement;
    const originalText = sendBtn.textContent;

    try {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<span class="spinner"></span> Creating flow...';

      const instructions = (document.getElementById('instructions') as HTMLTextAreaElement).value.trim();
      const settings = (window as any).settingsManager.getSettings();

      // Create ZIP
      const message: RuntimeMessage = {
        action: 'create-flow',
        pages: this.capturedPages,
        instructions,
        settings
      };
      const zipResponse = await chrome.runtime.sendMessage(message) as RuntimeResponse;

      if (!zipResponse.success) {
        throw new Error(zipResponse.error);
      }

      sendBtn.innerHTML = '<span class="spinner"></span> Opening LQA Boss...';

      // Generate filename based on job name or timestamp
      const fileName = generateFileName(settings.jobName);

      // Send ZIP data to background to hold temporarily
      const storeMessage: RuntimeMessage = {
        action: 'store-pending-flow',
        zipData: zipResponse.zipData,
        fileName
      };
      await chrome.runtime.sendMessage(storeMessage);

      // Get PWA URL from settings
      const baseUrl = settings.pwaUrl || 'https://lqaboss.l10n.monster';
      const pwaUrl = `${baseUrl}/?plugin=extension`;

      // Open PWA in new tab
      await chrome.tabs.create({ url: pwaUrl });

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
      const err = error as Error;
      console.error('[Cart] Send to LQA Boss error:', error);
      this.showStatus(`Failed to send to LQA Boss: ${err.message}`, 'error');
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = originalText;
    }
  }

  private async downloadZIP(): Promise<void> {
    const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
    const originalText = downloadBtn.textContent;

    try {
      downloadBtn.disabled = true;
      downloadBtn.innerHTML = '<span class="spinner"></span> Creating file...';

      const instructions = (document.getElementById('instructions') as HTMLTextAreaElement).value.trim();
      const settings = (window as any).settingsManager.getSettings();

      // Create ZIP
      const message: RuntimeMessage = {
        action: 'create-flow',
        pages: this.capturedPages,
        instructions,
        settings
      };
      const response = await chrome.runtime.sendMessage(message) as RuntimeResponse;

      if (!response.success) {
        throw new Error(response.error);
      }

      // Convert array back to Uint8Array then to Blob
      const uint8Array = new Uint8Array(response.zipData!);
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
      const err = error as Error;
      console.error('Download error:', error);
      this.showStatus(`Download failed: ${err.message}`, 'error');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = originalText;
    }
  }

  private async clearCartSilent(): Promise<void> {
    this.capturedPages = [];
    await this.render();
  }

  private showWarningsModal(warnings: string[]): void {
    const modal = document.getElementById('warnings-modal');
    const warningsList = document.getElementById('warnings-list');

    if (!modal || !warningsList) return;

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

  private hideWarningsModal(): void {
    const modal = document.getElementById('warnings-modal');
    modal?.classList.add('hidden');
  }

  private async render(): Promise<void> {
    const count = this.capturedPages.length;
    const pageCountEl = document.getElementById('page-count');
    if (pageCountEl) {
      pageCountEl.textContent = count.toString();
    }

    const cartList = document.getElementById('cart-list');
    const clearBtn = document.getElementById('clear-cart-btn') as HTMLButtonElement;
    const sendBtn = document.getElementById('send-to-pwa-btn') as HTMLButtonElement;
    const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;

    // Enable/disable buttons
    const hasPages = count > 0;
    clearBtn.disabled = !hasPages;
    sendBtn.disabled = !hasPages;
    downloadBtn.disabled = !hasPages;

    // Sync cart to storage for service worker access
    await chrome.storage.local.set({ capturedPages: this.capturedPages });

    // Render cart items
    if (!cartList) return;

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

  private renderCartItem(page: CapturedPage, _index: number): string {
    const segmentCount = page.segments.length;
    const matchedCount = page.matchedCount || 0;
    const timestamp = new Date(page.timestamp).toLocaleTimeString();

    // Extract hostname and path from URL
    let hostname = page.originalUrl;
    let urlPath = '/';
    try {
      const url = new URL(page.originalUrl);
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
          <div class="cart-item-url" title="${page.originalUrl}">${urlPath}</div>
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

  private showStatus(message: string, type: 'info' | 'error' | 'success' = 'info'): void {
    const statusEl = document.getElementById('status') as HTMLElement;
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
