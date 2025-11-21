/**
 * LQA Boss Background Service Worker
 * Handles capture orchestration, debugger API, and IndexedDB communication
 */

import type {
  URLRewriteRule,
  Segment,
  TranslationUnit,
  CapturedPage,
  Settings,
  CaptureState,
  PendingFlow,
  RuntimeMessage as BaseRuntimeMessage,
  RuntimeResponse as BaseRuntimeResponse,
  TMServiceResponse
} from '../types/shared.js';

// Import JSZip type declaration
declare const JSZip: any;

// Load JSZip library
// Note: Ensure lib/jszip.min.js is available (run: npm run setup)
importScripts('/lib/jszip.min.js');

// Extension-specific runtime message types (extend base)
interface RuntimeMessage extends BaseRuntimeMessage {
  tabId?: number;
  pages?: ExtendedCapturedPage[];
  instructions?: string;
  settings?: Settings;
  rules?: URLRewriteRule[];
  zipData?: number[];
  fileName?: string;
  metadata?: any;
}

interface RuntimeResponse extends BaseRuntimeResponse {
  data?: any;
  error?: string;
  zipData?: number[];
  state?: CaptureState;
  flowId?: string;
}

// Extension-specific TM response (wraps service response)
interface TMResponse {
  tus: TranslationUnit[];
  warnings: string[];
  error: string | null;
}

// Extension-specific CapturedPage with additional fields
interface ExtendedCapturedPage extends CapturedPage {
  matchedTUs: TranslationUnit[];
  matchedCount: number;
  favicon?: string;
  warnings: string[];
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
function generateFileName(jobName?: string): string {
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

// State management
let captureState: CaptureState = {
  isCapturing: false,
  currentTabId: null
};

let sidePanelOpen = false;
let sidePanelPort: chrome.runtime.Port | null = null;

// URL Rewrite Rules Storage
let urlRewriteRules: URLRewriteRule[] = [];

// Pending flow storage for PWA communication
let pendingFlow: PendingFlow | null = null;

// Load URL rewrite rules on startup
chrome.runtime.onStartup.addListener(async () => {
  const result = await chrome.storage.local.get('url_rewrite_rules');
  urlRewriteRules = (result.url_rewrite_rules || []).filter((r: URLRewriteRule) => r.enabled);
  setupURLInterception();
});

// Also load rules when service worker is installed
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get('url_rewrite_rules');
  urlRewriteRules = (result.url_rewrite_rules || []).filter((r: URLRewriteRule) => r.enabled);
  setupURLInterception();
});

// Track side panel connection state
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelOpen = true;
    sidePanelPort = port;

    // Enable URL interception when panel opens
    setupURLInterception();

    port.onDisconnect.addListener(async () => {
      sidePanelOpen = false;
      sidePanelPort = null;

      // Disable URL interception when panel closes
      setupURLInterception();

      // Disable X-ray on all tabs when panel closes
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id!, {
            action: 'toggle-xray',
            enabled: false,
            segments: []
          });
        } catch {
          // Ignore errors (tab may not have content script)
        }
      }
    });
  }
});

// Re-enable X-ray when page finishes loading (if panel is open)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, _tab) => {
  if (changeInfo.status === 'complete' && sidePanelOpen) {
    // Check if this is the active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.id === tabId) {
      // Send message to side panel to re-enable X-ray
      if (sidePanelPort) {
        try {
          sidePanelPort.postMessage({ action: 'page-reloaded', tabId });
        } catch {
          // Port may be disconnected
        }
      }
    }
  }
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId! });
});

/**
 * Capture full-page screenshot using Chrome Debugger API
 */
async function captureFullPageScreenshot(tabId: number): Promise<string> {
  try {
    // Attach debugger
    await chrome.debugger.attach({ tabId }, '1.3');

    // Check if page is actually scrollable and get dimensions
    const [pageInfo] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const original = { x: window.scrollX, y: window.scrollY };
        window.scrollTo(0, 0);

        // Check if the page itself scrolls (not just internal divs)
        const scrollHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        );
        const clientHeight = Math.max(
          document.documentElement.clientHeight,
          document.body.clientHeight,
          window.innerHeight
        );

        // Page is scrollable if scrollHeight is significantly larger than viewport
        // Use 100px threshold to ignore minor differences from scrollbars, borders, etc.
        const isPageScrollable = scrollHeight > clientHeight + 100;

        return {
          original,
          isPageScrollable,
          scrollHeight,
          clientHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        };
      }
    });
    const pageData = pageInfo.result as {
      original: { x: number; y: number };
      isPageScrollable: boolean;
      scrollHeight: number;
      clientHeight: number;
      viewportWidth: number;
      viewportHeight: number;
    };

    // Wait for scroll and layout to settle (100ms)
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get layout metrics from Chrome DevTools Protocol
    const layoutMetrics = await chrome.debugger.sendCommand(
      { tabId },
      'Page.getLayoutMetrics'
    ) as any;

    let captureWidth: number, captureHeight: number, captureBeyondViewport: boolean;

    if (pageData.isPageScrollable) {
      // Page scrolls - capture full content with cap
      const contentWidth = layoutMetrics.contentSize.width;
      const contentHeight = layoutMetrics.contentSize.height;
      const maxReasonableHeight = pageData.viewportHeight * 5;

      captureWidth = contentWidth;
      captureHeight = Math.min(contentHeight, maxReasonableHeight);
      captureBeyondViewport = true;
    } else {
      // Fixed viewport (internal scrolling only) - use body dimensions
      const [dimensions] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyRect = document.body.getBoundingClientRect();

          return {
            width: document.documentElement.clientWidth,
            bodyHeight: bodyRect.height
          };
        }
      });

      const dims = dimensions.result as {
        width: number;
        bodyHeight: number;
      };

      // Use body height for fixed viewports
      captureWidth = dims.width;
      captureHeight = dims.bodyHeight;
      captureBeyondViewport = false;
    }


    // Capture screenshot with the proper dimensions
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: captureBeyondViewport,
        clip: {
          x: 0,
          y: 0,
          width: captureWidth,
          height: captureHeight,
          scale: 1
        }
      }
    ) as { data: string };

    // Restore original scroll position
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (scroll: { x: number; y: number }) => {
        window.scrollTo(scroll.x, scroll.y);
      },
      args: [pageData.original]
    });

    // Detach debugger
    await chrome.debugger.detach({ tabId });

    return result.data; // base64 PNG
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    // Try to detach debugger on error
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Ignore detach errors
    }
    throw error;
  }
}

/**
 * Extract text and metadata from current page
 */
async function extractPageMetadata(tabId: number): Promise<any> {
  try {
    // Inject extractor script if not already injected
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/extractor.js']
    });

    // Request extraction
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'extract-metadata'
    });

    return response;
  } catch (error) {
    console.error('Metadata extraction failed:', error);
    throw error;
  }
}

/**
 * Capture current page (screenshot + metadata)
 */
async function capturePage(tabId: number): Promise<ExtendedCapturedPage> {
  if (captureState.isCapturing) {
    throw new Error('Capture already in progress');
  }

  captureState.isCapturing = true;
  captureState.currentTabId = tabId;

  try {
    // Get tab info
    const tab = await chrome.tabs.get(tabId);

    // Hide X-ray overlay if present (so it doesn't appear in screenshot)
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'hide-xray-temporarily'
      });
    } catch {
      // Ignore if xray script not injected
    }

    // Capture screenshot
    const screenshotBase64 = await captureFullPageScreenshot(tabId);

    // Extract metadata
    const extractionResult = await extractPageMetadata(tabId);

    // Note: X-ray will be restored by cart.js after successful capture
    // with updated match colors (green/red)

    if (extractionResult.error) {
      throw new Error(extractionResult.error);
    }

    const segments: Segment[] = extractionResult.textElements || [];

    // Validate segments were detected
    if (segments.length === 0) {
      throw new Error('No segments detected on this page');
    }

    // Fetch TUs for each segment if TM endpoint is configured
    let segmentsWithMatches = segments;
    const matchedTUs = new Map<string, TranslationUnit>(); // guid -> TU object
    let matchedCount = 0;
    let warnings: string[] = [];

    // Get settings from storage
    const result = await chrome.storage.sync.get('lqaboss_settings');
    const settings: Settings = result.lqaboss_settings || {};

    if (settings.tmEndpointUrl && segments.length > 0) {
      // Fetch TUs for all segments in one batch request
      const tmResult = await fetchTUsForSegments(segments, settings);

      // Check for TM service errors
      if (tmResult.error) {
        throw new Error(tmResult.error);
      }

      const tus = tmResult.tus;
      warnings = tmResult.warnings || [];

      // Mark which segments matched and store the matched guid
      segmentsWithMatches = segments.map((seg, i) => {
        const tu = tus[i];
        if (tu && tu.guid) {
          return {
            ...seg,
            g: tu.guid,
            matched: true
          };
        } else {
          return {
            ...seg,
            matched: false
          };
        }
      });

      // Collect unique TUs
      tus.forEach(tu => {
        if (tu && tu.guid && !matchedTUs.has(tu.guid)) {
          matchedTUs.set(tu.guid, tu);
          matchedCount++;
        }
      });

      // Validate at least one TU was matched
      if (matchedCount === 0) {
        throw new Error(`No TUs matched for ${segments.length} segment${segments.length !== 1 ? 's' : ''}`);
      }
    }

    const pageData: ExtendedCapturedPage = {
      pageId: `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      originalUrl: tab.url!,
      title: tab.title!,
      timestamp: new Date().toISOString(),
      screenshotBase64,
      segments: segmentsWithMatches,
      matchedTUs: Array.from(matchedTUs.values()),
      matchedCount,
      favicon: tab.favIconUrl,
      warnings
    };

    return pageData;
  } finally {
    captureState.isCapturing = false;
    captureState.currentTabId = null;
  }
}

/**
 * Fetch TUs from TM endpoint using batch POST request
 * Returns { tus: Array, warnings: Array, error: string|null }
 */
async function fetchTUsForSegments(segments: Segment[], settings: Settings): Promise<TMResponse> {
  if (!settings.tmEndpointUrl || segments.length === 0) {
    return { tus: [], warnings: [], error: null };
  }

  try {
    // Filter out fields added by extractor, keep only decoded metadata
    const excludeFields = new Set(['text', 'x', 'y', 'width', 'height', 'decodingError', 'matched']);
    const cleanSegments = segments.map(seg => {
      const cleaned: Record<string, any> = {};
      for (const [key, value] of Object.entries(seg)) {
        if (value !== undefined && value !== null && !excludeFields.has(key)) {
          cleaned[key] = value;
        }
      }
      return cleaned;
    });

    // Build POST body
    const body = {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      segments: cleanSegments
    };

    const response = await fetch(settings.tmEndpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      return {
        tus: [],
        warnings: [],
        error: `TM service error: ${response.status} ${response.statusText}`
      };
    }

    const data = await response.json() as TMServiceResponse | TranslationUnit[];

    // New format: { results, warnings }
    if (data && typeof data === 'object' && 'results' in data && Array.isArray(data.results)) {
      return {
        tus: data.results,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        error: null
      };
    }

    // Legacy format: array of TUs
    if (Array.isArray(data)) {
      return { tus: data, warnings: [], error: null };
    }

    return {
      tus: [],
      warnings: [],
      error: 'TM service returned invalid response format'
    };
  } catch (error) {
    const err = error as Error;
    // Network error, invalid URL, etc.
    return {
      tus: [],
      warnings: [],
      error: `TM service unreachable: ${err.message}`
    };
  }
}

/**
 * Create ZIP file from captured pages (requires JSZip)
 */
async function createFlowZIP(capturedPages: ExtendedCapturedPage[], instructions: string, settings: Settings): Promise<ArrayBuffer> {
  const zip = new JSZip();

  // Collect unique TUs from all captured pages
  const allTUs = new Map<string, TranslationUnit>(); // guid -> TU object

  // Add screenshots
  capturedPages.forEach((page, index) => {
    const imageName = `page_${index + 1}_${page.pageId}.png`;
    zip.file(imageName, page.screenshotBase64, { base64: true });

    // Collect TUs from this page
    if (page.matchedTUs && page.matchedTUs.length > 0) {
      page.matchedTUs.forEach(tu => {
        if (tu.guid && !allTUs.has(tu.guid)) {
          allTUs.set(tu.guid, tu);
        }
      });
    }
  });

  // Add flow metadata
  const flowMetadata = {
    createdAt: new Date().toISOString(),
    pages: capturedPages.map((page, index) => ({
      pageId: page.pageId,
      originalUrl: page.originalUrl,
      title: page.title,
      timestamp: page.timestamp,
      imageFile: `page_${index + 1}_${page.pageId}.png`,
      segments: page.segments.map(seg => ({
        g: seg.g,
        text: seg.text,
        x: seg.x,
        y: seg.y,
        width: seg.width,
        height: seg.height
      }))
    }))
  };

  zip.file('flow_metadata.json', JSON.stringify(flowMetadata, null, 2));

  // Add TM entries to job.json if we have any
  if (allTUs.size > 0) {
    const job: any = {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      tus: Array.from(allTUs.values())
    };

    // Add instructions if provided
    if (instructions) {
      job.instructions = instructions;
    }

    zip.file('job.json', JSON.stringify(job, null, 2));
  }

  // Add quality model if configured
  if (settings.qualityModel) {
    zip.file('quality.json', JSON.stringify(settings.qualityModel, null, 2));
  }

  // Generate ZIP as arraybuffer (for message passing compatibility)
  const zipArrayBuffer = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  }) as ArrayBuffer;

  return zipArrayBuffer;
}

/**
 * Save flow to shared IndexedDB for PWA access
 */
async function saveFlowToSharedDB(flowArrayBuffer: ArrayBuffer, flowMetadata: any): Promise<string> {
  const flowId = `flow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Convert ArrayBuffer to Blob for storage
  const flowBlob = new Blob([flowArrayBuffer], { type: 'application/zip' });

  // Open IndexedDB
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lqaboss-shared', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('flows')) {
        db.createObjectStore('flows', { keyPath: 'id' });
      }
    };
  });

  // Store flow
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['flows'], 'readwrite');
    const store = transaction.objectStore('flows');

    const request = store.put({
      id: flowId,
      zipBlob: flowBlob,
      metadata: flowMetadata,
      timestamp: Date.now()
    });

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });

  db.close();

  // Notify PWA via BroadcastChannel
  const channel = new BroadcastChannel('lqaboss-sync');
  channel.postMessage({
    type: 'new-flow',
    id: flowId,
    metadata: flowMetadata
  });
  channel.close();

  return flowId;
}

/**
 * Message handler for side panel communication
 */
chrome.runtime.onMessage.addListener((request: RuntimeMessage, sender, sendResponse) => {
  // Handle async operations
  (async () => {
    try {
      switch (request.action) {
        case 'capture-page': {
          const pageData = await capturePage(request.tabId!);
          sendResponse({ success: true, data: pageData });
          break;
        }

        case 'create-flow': {
          const zipArrayBuffer = await createFlowZIP(
            request.pages!,
            request.instructions!,
            request.settings!
          );
          // Convert ArrayBuffer to Array for message passing
          const zipData = Array.from(new Uint8Array(zipArrayBuffer));
          sendResponse({ success: true, zipData });
          break;
        }

        case 'save-to-pwa': {
          // Convert array back to ArrayBuffer
          const zipArrayBuffer = new Uint8Array(request.zipData!).buffer;
          const flowId = await saveFlowToSharedDB(
            zipArrayBuffer,
            request.metadata
          );
          sendResponse({ success: true, flowId });
          break;
        }

        case 'get-capture-state': {
          sendResponse({ success: true, state: captureState });
          break;
        }

        case 'update-url-rewrite-rules': {
          urlRewriteRules = request.rules || [];
          const result = await setupURLInterception();
          if (result.success) {
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: result.error });
          }
          break;
        }

        case 'store-pending-flow': {
          // Store flow data temporarily for PWA to retrieve
          pendingFlow = {
            zipData: request.zipData!,
            fileName: request.fileName!,
            timestamp: Date.now()
          };
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      const err = error as Error;
      // Don't log expected/normal errors
      const normalErrors = [
        'No segments detected',
        'No TUs matched',
        'Cannot capture restricted pages'
      ];
      const isNormalError = normalErrors.some(msg => err.message.includes(msg));

      if (!isNormalError) {
        console.error('Background action failed:', error);
      }

      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source, _reason) => {
  if (captureState.currentTabId === source.tabId) {
    captureState.isCapturing = false;
    captureState.currentTabId = null;
  }
});

/**
 * URL Rewrite Functionality using declarativeNetRequest (Manifest V3)
 */

// Base rule ID for URL rewrite rules (starts at 1000 to avoid conflicts)
const URL_REWRITE_RULE_ID_BASE = 1000;

// Set up URL interception using declarativeNetRequest
async function setupURLInterception(): Promise<{ success: boolean; error?: string }> {
  console.log('[URL Rewrite] setupURLInterception called', {
    rulesCount: urlRewriteRules.length,
    sidePanelOpen,
    rules: urlRewriteRules
  });

  try {
    // Check if declarativeNetRequest is available
    if (!chrome.declarativeNetRequest) {
      const errorMsg = 'declarativeNetRequest API not available (may be blocked by IT policy)';
      console.error('[URL Rewrite] ERROR:', errorMsg);
      return { success: false, error: errorMsg };
    }

    // Only add rules if we have rules AND the side panel is open
    if (urlRewriteRules.length > 0 && sidePanelOpen) {
      console.log('[URL Rewrite] Converting rules to declarativeNetRequest format...');

      // Convert our rules to declarativeNetRequest format
      const dynamicRules: chrome.declarativeNetRequest.Rule[] = urlRewriteRules.map((rule, index) => {
        return convertToDeclarativeRule(rule, URL_REWRITE_RULE_ID_BASE + index);
      });

      console.log('[URL Rewrite] Registering dynamic rules:', dynamicRules);

      // Update dynamic rules (remove old ones, add new ones)
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: dynamicRules.map(r => r.id),
        addRules: dynamicRules
      });

      // Verify rules were registered
      const registeredRules = await chrome.declarativeNetRequest.getDynamicRules();
      console.log('[URL Rewrite] Successfully registered rules. Active dynamic rules:', registeredRules);
    } else {
      console.log('[URL Rewrite] Removing URL rewrite rules (panel closed or no rules)');

      // Remove all URL rewrite rules when panel is closed or no rules configured
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      const rewriteRuleIds = existingRules
        .filter(r => r.id >= URL_REWRITE_RULE_ID_BASE && r.id < URL_REWRITE_RULE_ID_BASE + 1000)
        .map(r => r.id);

      if (rewriteRuleIds.length > 0) {
        console.log('[URL Rewrite] Removing rule IDs:', rewriteRuleIds);
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: rewriteRuleIds
        });
        console.log('[URL Rewrite] Rules removed successfully');
      } else {
        console.log('[URL Rewrite] No rules to remove');
      }
    }
    return { success: true };
  } catch (error) {
    const errorMsg = (error as Error).message;
    console.error('[URL Rewrite] FAILED to set up URL interception:', error);
    console.error('[URL Rewrite] Error details:', {
      message: errorMsg,
      stack: (error as Error).stack
    });
    return { success: false, error: errorMsg };
  }
}

/**
 * Convert URL rewrite rule to declarativeNetRequest format
 * User provides full URL regex - we just need to find the first capture group
 * and add the suffix to it
 */
function convertToDeclarativeRule(
  rule: URLRewriteRule,
  ruleId: number
): chrome.declarativeNetRequest.Rule {
  // User's regex already includes full URL pattern
  // We just need to wrap the first capture group with suffix

  let urlRegex = rule.urlRegex;

  // Strip ^ and $ if present
  if (urlRegex.startsWith('^')) {
    urlRegex = urlRegex.slice(1);
  }
  if (urlRegex.endsWith('$')) {
    urlRegex = urlRegex.slice(0, -1);
  }

  // Find first capture group
  const firstCaptureStart = urlRegex.indexOf('(');
  const firstCaptureEnd = findMatchingParen(urlRegex, firstCaptureStart);

  if (firstCaptureStart === -1 || firstCaptureEnd === -1) {
    throw new Error('URL rewrite regex must contain at least one capture group');
  }

  const beforeCapture = urlRegex.slice(0, firstCaptureStart);
  const captureGroup = urlRegex.slice(firstCaptureStart, firstCaptureEnd + 1);
  const afterCapture = urlRegex.slice(firstCaptureEnd + 1);

  // Build the regex filter with capture groups for substitution
  // We need 3 groups: before, captured value, after
  const regexFilter = `(${beforeCapture})${captureGroup}(${afterCapture})`;

  // Substitution: keep before, add suffix to captured value, keep after
  const regexSubstitution = `\\1\\2${rule.suffix}\\3`;

  console.log('[URL Rewrite] Converted rule:', {
    id: ruleId,
    input: rule.urlRegex,
    suffix: rule.suffix,
    regexFilter,
    regexSubstitution
  });

  return {
    id: ruleId,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: {
        regexSubstitution
      }
    },
    condition: {
      regexFilter,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME]
    }
  };
}

function findMatchingParen(str: string, startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < str.length; i++) {
    if (str[i] === '(') {
      depth++;
    } else if (str[i] === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// Initialize rules on service worker start
(async () => {
  const result = await chrome.storage.local.get('url_rewrite_rules');
  urlRewriteRules = (result.url_rewrite_rules || []).filter((r: URLRewriteRule) => r.enabled);
  setupURLInterception();
})();

// Handle external messages from PWA
chrome.runtime.onMessageExternal.addListener((request: RuntimeMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {
        case 'ping': {
          // Health check - just respond with success
          sendResponse({ success: true });
          break;
        }

        case 'requestFlow': {
          // PWA is requesting flow data
          // If no pendingFlow, check if we have captured pages in cart
          if (!pendingFlow) {
            // Load captured pages and instructions from storage
            const result = await chrome.storage.local.get(['capturedPages', 'instructions']);
            const capturedPages: ExtendedCapturedPage[] = result.capturedPages || [];
            const instructions: string = result.instructions || '';

            if (capturedPages.length === 0) {
              sendResponse({
                success: false,
                error: 'No flow available. Please capture pages in the extension first.'
              });
              return;
            }

            // Create flow from captured pages
            try {
              const settings = await chrome.storage.sync.get('lqaboss_settings');
              const userSettings: Settings = settings.lqaboss_settings || {};

              const zipArrayBuffer = await createFlowZIP(
                capturedPages,
                instructions,
                userSettings
              );

              const zipData = Array.from(new Uint8Array(zipArrayBuffer));
              const fileName = generateFileName(userSettings.jobName);

              sendResponse({
                success: true,
                data: { zipData, fileName }
              });
              return;
            } catch (error) {
              const err = error as Error;
              console.error('[ServiceWorker] Failed to create flow:', error);
              sendResponse({
                success: false,
                error: `Failed to create flow: ${err.message}`
              });
              return;
            }
          }

          // Check if flow is not too old (within 5 minutes)
          const flowAge = Date.now() - pendingFlow.timestamp;

          if (flowAge > 5 * 60 * 1000) {
            pendingFlow = null;
            sendResponse({
              success: false,
              error: 'Flow data expired. Please send from extension again.'
            });
            return;
          }

          // Send the flow data
          const flowData = {
            zipData: pendingFlow.zipData,
            fileName: pendingFlow.fileName
          };

          // Clear pending flow after sending
          pendingFlow = null;

          sendResponse({
            success: true,
            data: flowData
          });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      const err = error as Error;
      console.error('[ServiceWorker] External message handler failed:', error);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});

export {};
