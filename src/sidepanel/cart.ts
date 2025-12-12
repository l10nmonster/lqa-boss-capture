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
  flowId?: string;
  fileName?: string;
  enabled?: boolean;
  segments?: Segment[];
}

interface RuntimeResponse extends BaseRuntimeResponse {
  data?: any;
  error?: string;
  zipData?: number[];
  flowId?: string;
  textElements?: Segment[];
  wasVisible?: boolean;
}

/**
 * List of restricted URL protocols that Chrome extensions cannot access
 */
const RESTRICTED_PROTOCOLS = [
  'chrome:',
  'chrome-extension:',
  'view-source:',
  'devtools:'
];

/**
 * Check if a URL is restricted (cannot be accessed by extensions)
 */
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url || url === 'about:blank') return true;
  if (RESTRICTED_PROTOCOLS.some(protocol => url.startsWith(protocol))) return true;
  if (url.includes('chrome.google.com/webstore')) return true;
  return false;
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
    // Set app title from manifest
    const manifest = chrome.runtime.getManifest();
    const appTitle = document.getElementById('app-title');
    if (appTitle) {
      appTitle.textContent = `${manifest.name} v${manifest.version}`;
    }

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
      } else if (msg.action === 'keyboard-toggle-xray') {
        // Alt+X keyboard shortcut - toggle X-ray with full extraction
        this.xrayUserEnabled = !this.xrayUserEnabled;
        this.updateXrayCheckbox(this.xrayUserEnabled);

        if (this.xrayUserEnabled) {
          await this.enableXRay();
        } else {
          await this.disableXRay();
        }
      } else if (msg.action === 'keyboard-refresh-xray') {
        // Alt+Z keyboard shortcut - refresh X-ray segments
        await this.refreshXRay();
      } else if (msg.action === 'flow-retrieved-by-pwa') {
        // PWA successfully retrieved the flow - show confirmation and clear cart
        this.showStatus('LQA Boss received the flow successfully!', 'success');
        await this.clearCartSilent();
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

    // X-Ray refresh button
    const xrayRefreshBtn = document.getElementById('xray-refresh-btn');
    if (xrayRefreshBtn) {
      xrayRefreshBtn.addEventListener('click', async () => {
        await this.refreshXRay();
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

    // Close modal when clicking overlay (warnings modal)
    document.querySelector('#warnings-modal .modal-overlay')?.addEventListener('click', () => {
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

        // Re-enable X-ray with color-coded segments (green/red) and TU data
        await this.showXRayWithSegments(response.data.segments, response.data.matchedTUs);

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

  private async extractSegments(): Promise<Segment[]> {
    if (!this.currentTab?.id) return [];

    // Silently skip restricted URLs (chrome://, edge://, etc.)
    if (isRestrictedUrl(this.currentTab.url)) {
      return [];
    }

    try {
      // Hide X-ray overlay before extracting to avoid interference with elementFromPoint
      try {
        await chrome.tabs.sendMessage(this.currentTab.id, { action: 'hide-xray-temporarily' });
      } catch {
        // Overlay might not be injected yet
      }

      await chrome.scripting.executeScript({
        target: { tabId: this.currentTab.id },
        files: ['content/extractor.js']
      });

      const message: RuntimeMessage = {
        action: 'extract-metadata'
      };
      const response = await chrome.tabs.sendMessage(this.currentTab.id, message) as RuntimeResponse;

      if (response && response.textElements) {
        return response.textElements;
      }
    } catch (error) {
      console.error('[Cart] Failed to extract segments:', error);
    }
    return [];
  }

  private async enableXRay(): Promise<void> {
    try {
      await this.updateCurrentTab();
      if (!this.currentTab) {
        this.updateSegmentCount(0);
        return;
      }

      // Skip restricted URLs (chrome://, edge://, etc.)
      if (isRestrictedUrl(this.currentTab.url)) {
        this.updateSegmentCount(0);
        return;
      }

      // Always extract fresh segments (like scroll behavior)
      let segments: Segment[] = await this.extractSegments();

      // If no segments found, retry after a short delay (for SPAs that render content dynamically)
      if (segments.length === 0) {
        console.log('[Cart] No segments found, retrying in 500ms...');
        await new Promise(resolve => setTimeout(resolve, 500));
        segments = await this.extractSegments();
        console.log('[Cart] Retry result:', segments.length, 'segments');
      }

      // If page was previously captured, preserve matched status (green/red colors) and TU data
      let tus: any[] | undefined;
      const lastPage = this.capturedPages
        .slice()
        .reverse()
        .find(p => p.originalUrl === this.currentTab!.url) as ExtendedCapturedPage | undefined;

      if (lastPage) {
        segments = segments.map(seg => {
          // Find matching captured segment by GUID or text
          const captured = lastPage.segments.find(c =>
            (seg.g && c.g && seg.g === c.g) || c.text === seg.text
          );
          if (captured?.matched !== undefined) {
            return { ...seg, matched: captured.matched };
          }
          return seg;
        });
        // Also get the TU data from the captured page
        tus = lastPage.matchedTUs;
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
        segments,
        tus
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

  private async refreshXRay(): Promise<void> {
    // Only refresh if X-ray is currently enabled
    if (!this.xrayUserEnabled) return;

    const refreshBtn = document.getElementById('xray-refresh-btn');

    try {
      // Add spinning animation
      refreshBtn?.classList.add('spinning');

      // Re-extract and update the overlay without turning it off first
      await this.enableXRay();
    } finally {
      // Remove spinning animation
      refreshBtn?.classList.remove('spinning');
    }
  }

  private async showXRayWithSegments(segments: Segment[], tus?: any[]): Promise<void> {
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

      // Enable X-ray with provided segments and TU data
      const message: RuntimeMessage = {
        action: 'toggle-xray',
        enabled: true,
        segments,
        tus
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

      // Create ZIP (service worker reads pages from storage, avoids 64MB message limit)
      const message: RuntimeMessage = {
        action: 'create-flow',
        instructions,
        settings
      };
      const createResponse = await chrome.runtime.sendMessage(message) as RuntimeResponse;

      if (!createResponse.success || !createResponse.flowId) {
        throw new Error(createResponse.error || 'Failed to create flow');
      }

      sendBtn.innerHTML = '<span class="spinner"></span> Opening LQA Boss...';

      // Generate filename based on job name or timestamp
      const fileName = generateFileName(settings.jobName);

      // Store flowId reference for PWA to retrieve (actual data is in IndexedDB)
      const storeMessage: RuntimeMessage = {
        action: 'store-pending-flow',
        flowId: createResponse.flowId,
        fileName
      };
      await chrome.runtime.sendMessage(storeMessage);

      // Get PWA URL from settings
      const baseUrl = settings.pwaUrl || 'https://lqaboss.l10n.monster';
      const pwaUrl = `${baseUrl}/?plugin=extension`;

      // Open PWA in new tab
      await chrome.tabs.create({ url: pwaUrl });

      // Show message - don't auto-clear cart in case PWA fails to retrieve
      if (baseUrl.includes('lqaboss.l10n.monster')) {
        this.showStatus('Flow ready! Click "Open in app" in the address bar. Clear cart after confirming receipt.', 'success');
      } else {
        this.showStatus('Flow ready for LQA Boss. Clear cart after confirming receipt.', 'success');
      }
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

      // Create ZIP (service worker reads pages from storage, avoids 64MB message limit)
      const createMessage: RuntimeMessage = {
        action: 'create-flow',
        instructions,
        settings
      };
      const createResponse = await chrome.runtime.sendMessage(createMessage) as RuntimeResponse;

      if (!createResponse.success || !createResponse.flowId) {
        throw new Error(createResponse.error || 'Failed to create flow');
      }

      // Generate filename based on job name or timestamp
      const filename = generateFileName(settings.jobName);

      // Download directly from service worker (avoids 64MB message limit)
      const downloadMessage: RuntimeMessage = {
        action: 'download-flow',
        flowId: createResponse.flowId,
        fileName: filename
      };
      const downloadResponse = await chrome.runtime.sendMessage(downloadMessage) as RuntimeResponse;

      if (!downloadResponse.success) {
        throw new Error(downloadResponse.error || 'Failed to download flow');
      }

      this.showStatus(`Downloading ${filename}...`, 'success');
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

  /**
   * Calculate estimated memory usage for a single page
   */
  private calculatePageMemory(page: CapturedPage): number {
    let bytes = 0;
    // Screenshot is base64 encoded, estimate original binary size
    if (page.screenshotBase64) {
      // Base64 is ~33% larger than original, so multiply by 0.75 to get binary size
      bytes += Math.ceil(page.screenshotBase64.length * 0.75);
    }
    // Segments and metadata (rough estimate)
    if (page.segments) {
      bytes += JSON.stringify(page.segments).length;
    }
    return bytes;
  }

  /**
   * Calculate estimated memory usage of all captured pages
   */
  private calculateMemoryUsage(): number {
    let totalBytes = 0;
    for (const page of this.capturedPages) {
      totalBytes += this.calculatePageMemory(page);
    }
    return totalBytes;
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private async render(): Promise<void> {
    const count = this.capturedPages.length;
    const pageCountEl = document.getElementById('page-count');
    if (pageCountEl) {
      pageCountEl.textContent = count.toString();
    }

    // Update memory usage display
    const memoryEl = document.getElementById('cart-memory');
    if (memoryEl) {
      const memoryBytes = this.calculateMemoryUsage();
      const memoryMB = memoryBytes / (1024 * 1024);
      if (count === 0) {
        memoryEl.textContent = '';
        memoryEl.className = 'cart-memory';
      } else {
        memoryEl.textContent = this.formatBytes(memoryBytes);
        // Add warning classes based on size
        if (memoryMB > 50) {
          memoryEl.className = 'cart-memory danger';
          memoryEl.title = 'Large flow - may be slow to transfer';
        } else if (memoryMB > 20) {
          memoryEl.className = 'cart-memory warning';
          memoryEl.title = 'Moderate flow size';
        } else {
          memoryEl.className = 'cart-memory';
          memoryEl.title = 'Estimated memory usage';
        }
      }
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
    try {
      await chrome.storage.local.set({ capturedPages: this.capturedPages });
    } catch (error) {
      const err = error as Error;
      console.error('[Cart] Storage error:', error);
      if (err.message?.includes('QuotaBytes') || err.message?.includes('quota')) {
        // Remove the last added page since we can't store it
        if (this.capturedPages.length > 0) {
          this.capturedPages.pop();
          // Update count display to reflect the actual stored pages
          const newCount = this.capturedPages.length;
          if (pageCountEl) {
            pageCountEl.textContent = newCount.toString();
          }
          // Update button states
          clearBtn.disabled = newCount === 0;
          sendBtn.disabled = newCount === 0;
          downloadBtn.disabled = newCount === 0;
        }
        this.showStatus('Storage quota exceeded. Page not saved. Try removing some pages first.', 'error');
        // Don't continue rendering - the previous cart state is still valid
        return;
      }
    }

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

    // Add event listeners for preview tooltips (load image on hover)
    cartList.querySelectorAll('.preview-trigger').forEach((trigger) => {
      trigger.addEventListener('mouseenter', (e) => {
        const index = parseInt((trigger as HTMLElement).dataset.index || '0', 10);
        const page = this.capturedPages[index];
        if (page?.screenshotBase64) {
          const tooltip = trigger.querySelector('.preview-tooltip') as HTMLElement;
          const img = trigger.querySelector('.preview-tooltip img') as HTMLImageElement;

          if (img && !img.getAttribute('src')) {
            // Detect PNG by magic bytes (base64 encoded "iVBORw0KGgo" is PNG header)
            const isPng = page.screenshotBase64?.startsWith('iVBORw0KGgo');
            const mimeType = isPng ? 'image/png' : 'image/jpeg';
            img.src = `data:${mimeType};base64,${page.screenshotBase64}`;
          }

          // Position the fixed tooltip
          if (tooltip) {
            const rect = (trigger as HTMLElement).getBoundingClientRect();
            tooltip.style.left = `${rect.right + 8}px`;
            tooltip.style.top = `${Math.max(8, rect.top - 100)}px`;
          }
        }
      });
    });
  }

  private renderCartItem(page: CapturedPage, index: number): string {
    const segmentCount = page.segments.length;
    const matchedCount = page.matchedCount || 0;
    const pageMemory = this.formatBytes(this.calculatePageMemory(page));

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
        <div class="preview-trigger" data-index="${index}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
          <div class="preview-tooltip">
            <img alt="">
          </div>
        </div>
        <div class="cart-item-content">
          <div class="cart-item-title">${hostname}</div>
          <div class="cart-item-url" title="${page.originalUrl}">${urlPath}</div>
          <div class="cart-item-meta">
            ${segmentsInfo} • ${pageMemory}
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
