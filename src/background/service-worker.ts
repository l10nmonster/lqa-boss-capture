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

import {
  MAX_CHUNK_SIZE,
  needsChunkedTransfer,
  calculateChunkCount,
  getChunkRange,
  isLastChunk
} from '../lib/chunking.js';

import { withTimeout, TimeoutError } from '../lib/timeout.js';

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
  flowId?: string;
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

// Abort controller for cancelling captures (kept separate since AbortController doesn't serialize)
let captureAbortController: AbortController | null = null;

// Current capture phase for timeout error messages
let capturePhase: string = '';

// Capture timeout in milliseconds (30 seconds)
const CAPTURE_TIMEOUT_MS = 30000;

let sidePanelOpen = false;
let sidePanelPort: chrome.runtime.Port | null = null;

// URL Rewrite Rules Storage
let urlRewriteRules: URLRewriteRule[] = [];

// Pending flow storage for PWA communication
let pendingFlow: PendingFlow | null = null;

// Default screenshot settings (can be overridden in user settings)
const DEFAULT_SCREENSHOT_QUALITY = 80;
const DEFAULT_SCREENSHOT_MAX_HEIGHT = 16000;

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

interface PageDimensions {
  isPageScrollable: boolean;
  isMobileEmulation: boolean;
  isScrollLocked: boolean;  // Body/html has overflow:hidden (modal open)
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;   // Full scrollable width
  documentHeight: number;  // Full scrollable height
  contentHeight: number;
  devicePixelRatio: number;  // For calculating physical pixel limits
}

/**
 * Get page dimensions and detect mobile emulation
 */
async function getPageDimensions(tabId: number): Promise<PageDimensions> {
  const [pageInfo] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth
        ),
        documentHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        ),
        devicePixelRatio: window.devicePixelRatio,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        // Detect if scroll is locked (modal open, etc.)
        isScrollLocked: (() => {
          const bodyStyle = window.getComputedStyle(document.body);
          const htmlStyle = window.getComputedStyle(document.documentElement);
          const bodyOverflow = bodyStyle.overflow + bodyStyle.overflowY;
          const htmlOverflow = htmlStyle.overflow + htmlStyle.overflowY;
          const isOverflowHidden = bodyOverflow.includes('hidden') || htmlOverflow.includes('hidden');
          const isPositionFixed = bodyStyle.position === 'fixed';
          return isOverflowHidden || isPositionFixed;
        })()
      };
    }
  });

  const pageData = pageInfo.result as {
    viewportWidth: number;
    viewportHeight: number;
    documentWidth: number;
    documentHeight: number;
    devicePixelRatio: number;
    screenWidth: number;
    screenHeight: number;
    isScrollLocked: boolean;
  };

  // Get layout metrics from Chrome DevTools Protocol
  const layoutMetrics = await chrome.debugger.sendCommand(
    { tabId },
    'Page.getLayoutMetrics'
  ) as any;

  const contentHeight = layoutMetrics.contentSize.height;
  const contentWidth = layoutMetrics.contentSize.width;

  // Page is scrollable if document is taller than viewport
  const isPageScrollable = pageData.documentHeight > pageData.viewportHeight + 100;

  // Detect mobile emulation: significant mismatch between JS documentHeight and DevTools contentHeight
  // In mobile emulation, these values diverge significantly (often by 2x or more)
  const heightRatio = contentHeight / pageData.documentHeight;
  const isMobileEmulation = heightRatio > 1.5 || heightRatio < 0.67;

  return {
    viewportWidth: pageData.viewportWidth,
    viewportHeight: pageData.viewportHeight,
    documentWidth: pageData.documentWidth,
    documentHeight: pageData.documentHeight,
    isPageScrollable,
    isMobileEmulation,
    contentHeight,
    isScrollLocked: pageData.isScrollLocked,
    devicePixelRatio: pageData.devicePixelRatio
  };
}

interface CapturedChunk {
  data: string;
  scrollY: number;
}

interface ScreenshotResult {
  data: string;
  scale: number;  // Actual scale factor (bitmap pixels / CSS pixels)
  capturedHeight: number;  // Actual CSS height captured (may be less than documentHeight if truncated)
}

interface ScreenshotOptions {
  quality: number;  // 1-100, 100 = PNG
  maxHeightPixels: number;  // Maximum height in physical pixels
}

/**
 * Wait for browser to render after scroll using double-requestAnimationFrame.
 * Two rAF calls ensure the browser has completed at least one paint cycle.
 */
async function waitForScrollRender(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    })
  });
  // Small buffer for lazy-loaded content
  await new Promise(r => setTimeout(r, 50));
}

/**
 * Capture full page using scroll-and-stitch for mobile emulation
 */
async function captureFullPageWithStitch(
  tabId: number,
  dims: PageDimensions,
  options: ScreenshotOptions
): Promise<ScreenshotResult> {
  const { viewportWidth, documentWidth, documentHeight } = dims;
  const chunks: CapturedChunk[] = [];

  // Determine format and quality based on settings
  const usePng = options.quality >= 100;
  const format = usePng ? 'png' : 'jpeg';
  const mimeType = usePng ? 'image/png' : 'image/jpeg';

  // First capture to determine actual bitmap dimensions and scale
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo(0, 0)
  });
  await waitForScrollRender(tabId);

  const screenshotParams: any = { format, captureBeyondViewport: false };
  if (!usePng) {
    screenshotParams.quality = options.quality;
  }

  const firstResult = await chrome.debugger.sendCommand(
    { tabId },
    'Page.captureScreenshot',
    screenshotParams
  ) as { data: string };

  const firstBlob = await fetch(`data:${mimeType};base64,${firstResult.data}`).then(r => r.blob());
  const firstBitmap = await createImageBitmap(firstBlob);
  const bitmapWidth = firstBitmap.width;
  const bitmapHeight = firstBitmap.height;
  const scale = bitmapWidth / viewportWidth;
  const capturedCSSHeight = bitmapHeight / scale; // Actual CSS pixels captured per screenshot

  // Cap document height based on physical pixel limit (accounts for retina displays)
  const maxCSSHeight = options.maxHeightPixels / scale;
  const cappedHeight = Math.min(documentHeight, maxCSSHeight);

  chunks.push({ data: firstResult.data, scrollY: 0 });
  firstBitmap.close();

  // Keep capturing until we've covered the target range
  let lastCapturedBottom = capturedCSSHeight; // First chunk covers 0 to capturedCSSHeight
  let prevScrollY = -1; // Track previous scroll to detect when we can't scroll further

  while (lastCapturedBottom < cappedHeight) {
    // Calculate next scroll position to avoid gaps
    const targetY = lastCapturedBottom;

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y: number) => window.scrollTo(0, y),
      args: [targetY]
    });

    await waitForScrollRender(tabId);

    const [scrollCheck] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.scrollY
    });
    const actualScrollY = scrollCheck.result as number;

    // Check if we're stuck at the same scroll position (can't scroll further)
    if (actualScrollY === prevScrollY) {
      break;
    }
    prevScrollY = actualScrollY;

    // Capture with duplicate detection and retry
    let result: { data: string };
    let retries = 0;
    const maxRetries = 3;
    const prevData = chunks[chunks.length - 1]?.data;

    do {
      result = await chrome.debugger.sendCommand(
        { tabId },
        'Page.captureScreenshot',
        screenshotParams
      ) as { data: string };

      // If this chunk is identical to the previous one, wait and retry
      if (prevData && result.data === prevData && retries < maxRetries) {
        retries++;
        await new Promise(r => setTimeout(r, 100 * retries)); // Exponential backoff: 100, 200, 300ms
      } else {
        break;
      }
    } while (retries <= maxRetries);

    chunks.push({ data: result.data, scrollY: actualScrollY });

    // Update how far we've captured
    lastCapturedBottom = actualScrollY + capturedCSSHeight;
  }

  // Scroll back to top
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo(0, 0)
  });

  // If only one chunk, return it directly
  if (chunks.length === 1) {
    return { data: chunks[0].data, scale, capturedHeight: cappedHeight };
  }

  // Create canvas at full resolution (using capped height)
  const canvasHeight = Math.round(cappedHeight * scale);
  const canvas = new OffscreenCanvas(bitmapWidth, canvasHeight);
  const ctx = canvas.getContext('2d')!;

  // Draw all chunks at their scroll positions
  // Canvas clips anything beyond bounds automatically
  for (let i = 0; i < chunks.length; i++) {
    const blob = await fetch(`data:${mimeType};base64,${chunks[i].data}`).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);

    // Draw at actual scroll position - don't special-case last chunk
    // This ensures content aligns with coordinates extracted at scroll=0
    const drawY = Math.round(chunks[i].scrollY * scale);

    ctx.drawImage(bitmap, 0, drawY);
    bitmap.close();
  }

  // Convert to base64
  const stitchedBlob = usePng
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await canvas.convertToBlob({ type: 'image/jpeg', quality: options.quality / 100 });
  const arrayBuffer = await stitchedBlob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return { data: btoa(binary), scale, capturedHeight: cappedHeight };
}

/**
 * Capture screenshot - uses stitch method for mobile emulation
 */
async function captureScreenshot(
  tabId: number,
  dims: PageDimensions,
  options: ScreenshotOptions
): Promise<ScreenshotResult> {
  // Determine format and quality based on settings
  const usePng = options.quality >= 100;
  const format = usePng ? 'png' : 'jpeg';
  const mimeType = usePng ? 'image/png' : 'image/jpeg';

  // If scroll is locked (modal open), just capture current viewport
  if (dims.isScrollLocked) {
    const screenshotParams: any = { format, captureBeyondViewport: false };
    if (!usePng) {
      screenshotParams.quality = options.quality;
    }

    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Page.captureScreenshot',
      screenshotParams
    ) as { data: string };

    const blob = await fetch(`data:${mimeType};base64,${result.data}`).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    const actualScale = bitmap.width / dims.viewportWidth;
    bitmap.close();

    return { data: result.data, scale: actualScale, capturedHeight: dims.viewportHeight };
  }

  if (dims.isMobileEmulation) {
    // Mobile emulation - always use simple viewport capture
    // captureBeyondViewport with clip doesn't work correctly in mobile emulation
    // (coordinates get confused with device pixel ratio)
    return captureFullPageWithStitch(tabId, dims, options);
  }

  // Regular capture with captureBeyondViewport (cap height to prevent excessive memory usage)
  // Calculate max CSS height based on physical pixel limit
  const maxCSSHeight = options.maxHeightPixels / dims.devicePixelRatio;
  const captureHeight = Math.min(
    dims.isPageScrollable
      ? Math.min(dims.contentHeight, dims.viewportHeight * 5)
      : dims.documentHeight,
    maxCSSHeight
  );

  const screenshotParams: any = {
    format,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: dims.viewportWidth,
      height: captureHeight,
      scale: 1
    }
  };
  if (!usePng) {
    screenshotParams.quality = options.quality;
  }

  const result = await chrome.debugger.sendCommand(
    { tabId },
    'Page.captureScreenshot',
    screenshotParams
  ) as { data: string };

  // Decode to get actual image dimensions for scale calculation
  const blob = await fetch(`data:${mimeType};base64,${result.data}`).then(r => r.blob());
  const bitmap = await createImageBitmap(blob);
  const actualScale = bitmap.width / dims.viewportWidth;
  bitmap.close();

  return { data: result.data, scale: actualScale, capturedHeight: captureHeight };
}

/**
 * Clean up after full-page capture
 */
async function finishFullPageCapture(tabId: number): Promise<void> {
  await chrome.debugger.detach({ tabId });
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
 * Check if capture was aborted and throw if so
 */
function checkAborted(): void {
  if (captureAbortController?.signal.aborted) {
    throw new Error('Capture cancelled');
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
  captureAbortController = new AbortController();
  capturePhase = 'initializing';

  try {
    // Wrap the entire capture in a timeout
    return await withTimeout(
      capturePageInternal(tabId),
      CAPTURE_TIMEOUT_MS,
      'Capture timed out' // Base message, will be enhanced with phase
    );
  } catch (error) {
    // Clean up debugger on error (including timeout/cancel)
    try {
      await chrome.debugger.detach({ tabId });
    } catch { /* ignore */ }

    // Enhance timeout error with current phase
    if (error instanceof TimeoutError && capturePhase) {
      throw new Error(`Capture timed out while ${capturePhase}`);
    }
    throw error;
  } finally {
    captureState.isCapturing = false;
    captureState.currentTabId = null;
    captureAbortController = null;
    capturePhase = '';
  }
}

/**
 * Internal capture logic (wrapped by capturePage with timeout)
 */
async function capturePageInternal(tabId: number): Promise<ExtendedCapturedPage> {
  // Get tab info
  capturePhase = 'getting tab info';
  const tab = await chrome.tabs.get(tabId);

  // Hide X-ray overlay if present (so it doesn't appear in screenshot)
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'hide-xray-temporarily'
    });
    // Wait for DOM update to complete
    await new Promise(resolve => setTimeout(resolve, 50));
  } catch {
    // Ignore if xray script not injected
  }

  // Check if cancelled
  checkAborted();

  // Get current scroll position first (before attaching debugger)
  const [scrollInfo] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ x: window.scrollX, y: window.scrollY })
  });
  const originalScroll = scrollInfo.result as { x: number; y: number };

  // Attach debugger and get page dimensions
  capturePhase = 'attaching debugger';
  await chrome.debugger.attach({ tabId }, '1.3');
  capturePhase = 'getting page dimensions';
  const dims = await getPageDimensions(tabId);

  // Check if cancelled after debugger attach
  checkAborted();

  // Get settings from storage early (needed for screenshot options)
  const settingsResult = await chrome.storage.sync.get('lqaboss_settings');
  const settings: Settings = settingsResult.lqaboss_settings || {};

  // Screenshot options from settings (with defaults)
  const screenshotOptions: ScreenshotOptions = {
    quality: settings.screenshotQuality || DEFAULT_SCREENSHOT_QUALITY,
    maxHeightPixels: settings.screenshotMaxHeight || DEFAULT_SCREENSHOT_MAX_HEIGHT
  };

  // Calculate capture range
  const maxCaptureHeight = screenshotOptions.maxHeightPixels / dims.devicePixelRatio;
  const captureEndY = Math.min(maxCaptureHeight, dims.documentHeight);

  // Extract segments - method depends on scroll lock state
  capturePhase = 'extracting segments';
  let segments: Segment[] = [];

  if (dims.isScrollLocked) {
    // When scroll is locked, just extract at current position
    const extractionResult = await extractPageMetadata(tabId);
    if (extractionResult.error) {
      throw new Error(extractionResult.error);
    }
    segments = extractionResult.textElements || [];
  } else {
    // For full-page capture: extract at each scroll position to handle lazy-loaded content
    const scrollStep = dims.viewportHeight;
    const allSegments: Segment[] = [];
    const totalScrolls = Math.ceil(captureEndY / scrollStep);
    let currentScroll = 0;

    for (let scrollY = 0; scrollY <= captureEndY; scrollY += scrollStep) {
      currentScroll++;
      capturePhase = `extracting segments (scroll ${currentScroll}/${totalScrolls})`;

      // Check if cancelled between scroll iterations
      checkAborted();

      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y: number) => window.scrollTo(0, y),
        args: [scrollY]
      });
      // Wait for lazy content to load and render
      await new Promise(resolve => setTimeout(resolve, 150));

      // Extract at this scroll position
      const extractionResult = await extractPageMetadata(tabId);
      if (extractionResult.error) {
        throw new Error(extractionResult.error);
      }

      const pageSegments: Segment[] = extractionResult.textElements || [];

      // Add segments with valid coordinates that are within the capture range
      for (const seg of pageSegments) {
        const hasValidCoords = seg.x !== 0 || seg.y !== 0 || seg.width !== 0 || seg.height !== 0;
        const inCaptureRange = seg.y < captureEndY;
        if (hasValidCoords && inCaptureRange) {
          allSegments.push(seg);
        }
      }
    }

    // Scroll back to top for screenshot
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.scrollTo(0, 0)
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Deduplicate by position (same GUID can appear multiple times, but not at same position)
    // Use a key of "guid:x:y" rounded to nearest 10px to handle minor variations
    const seen = new Set<string>();
    segments = allSegments.filter(seg => {
      const key = `${seg.g}:${Math.round(seg.x / 10) * 10}:${Math.round(seg.y / 10) * 10}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  // When scroll is locked (modal open), filter to only visible segments in viewport
  // and adjust coordinates to be viewport-relative
  if (dims.isScrollLocked) {
    const scrollX = originalScroll.x;
    const scrollY = originalScroll.y;

    segments = segments
      .filter(seg => {
        // Skip segments marked as invisible (x:0,y:0,width:0,height:0)
        if (seg.x === 0 && seg.y === 0 && seg.width === 0 && seg.height === 0) {
          return false;
        }
        // Convert to viewport-relative for bounds check
        const viewportY = seg.y - scrollY;
        const viewportX = seg.x - scrollX;
        // Only include segments within viewport bounds
        const inViewport = viewportY < dims.viewportHeight && (viewportY + seg.height) > 0 &&
                          viewportX < dims.viewportWidth && (viewportX + seg.width) > 0;
        return inViewport;
      })
      .map(seg => ({
        ...seg,
        // Adjust coordinates to be viewport-relative
        x: seg.x - scrollX,
        y: seg.y - scrollY
      }));
  } else {
    // For full-page captures, just filter out invisible segments
    segments = segments.filter(seg =>
      !(seg.x === 0 && seg.y === 0 && seg.width === 0 && seg.height === 0)
    );
  }

  // Validate segments were detected
  if (segments.length === 0) {
    throw new Error('No segments detected on this page');
  }

  // Check if cancelled before TM lookup
  checkAborted();

  // Fetch TUs BEFORE capturing screenshot (to verify TM matches exist)
  capturePhase = `fetching TM data for ${segments.length} segment${segments.length !== 1 ? 's' : ''}`;
  let segmentsWithMatches = segments;
  const matchedTUs = new Map<string, TranslationUnit>(); // guid -> TU object
  let matchedCount = 0;
  let warnings: string[] = [];

  // TM endpoint is required for capture
  if (!settings.tmEndpointUrl) {
    throw new Error('TM Lookup URL not configured. Please set it in Settings.');
  }

  if (segments.length > 0) {
    // Fetch TUs for all segments in one batch request (with abort signal)
    const tmResult = await fetchTUsForSegments(segments, settings, captureAbortController?.signal);

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

    // Validate at least one TU was matched BEFORE taking screenshot
    if (matchedCount === 0) {
      throw new Error(`No TUs matched for ${segments.length} segment${segments.length !== 1 ? 's' : ''}`);
    }
  }

  // Check if cancelled before screenshot
  checkAborted();

  // Now capture screenshot (only after TM lookup succeeds)
  capturePhase = 'capturing screenshot';
  const screenshotResult = await captureScreenshot(tabId, dims, screenshotOptions);
  const screenshotBase64 = screenshotResult.data;
  const screenshotScale = screenshotResult.scale;
  const capturedHeight = screenshotResult.capturedHeight;

  // Clean up debugger
  await finishFullPageCapture(tabId);

  // Restore original scroll position (only if we scrolled to top earlier)
  if (!dims.isScrollLocked) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (scroll: { x: number; y: number }) => {
        window.scrollTo(scroll.x, scroll.y);
      },
      args: [originalScroll]
    });
  }

  // Note: X-ray will be restored by cart.js after successful capture
  // with updated match colors (green/red)

  const pageData: ExtendedCapturedPage = {
    pageId: `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    originalUrl: tab.url!,
    title: tab.title!,
    timestamp: new Date().toISOString(),
    screenshotBase64,
    segments: segmentsWithMatches,  // CSS pixel coordinates for X-ray overlay
    // Store capture info for normalization and debugging
    viewportWidth: dims.viewportWidth,
    viewportHeight: dims.viewportHeight,
    documentWidth: dims.documentWidth,
    documentHeight: dims.documentHeight,
    capturedHeight,  // Actual height captured (may be less than documentHeight if truncated)
    screenshotScale: screenshotScale,
    isMobileEmulation: dims.isMobileEmulation,
    isScrollLocked: dims.isScrollLocked,
    matchedTUs: Array.from(matchedTUs.values()),
    matchedCount,
    favicon: tab.favIconUrl,
    warnings
  };

  return pageData;
}

/**
 * Fetch TUs from TM endpoint using batch POST request
 * Returns { tus: Array, warnings: Array, error: string|null }
 * @param signal Optional AbortSignal to cancel the request
 */
async function fetchTUsForSegments(segments: Segment[], settings: Settings, signal?: AbortSignal): Promise<TMResponse> {
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
      body: JSON.stringify(body),
      signal
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

  // Determine file extension based on quality setting
  const usePng = (settings.screenshotQuality || DEFAULT_SCREENSHOT_QUALITY) >= 100;
  const imageExt = usePng ? 'png' : 'jpg';

  // Collect unique TUs from all captured pages
  const allTUs = new Map<string, TranslationUnit>(); // guid -> TU object

  // Add screenshots
  capturedPages.forEach((page, index) => {
    const imageName = `page_${index + 1}_${page.pageId}.${imageExt}`;
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
  const manifest = chrome.runtime.getManifest();
  const flowMetadata = {
    createdBy: `${manifest.name} v${manifest.version}`,
    createdAt: new Date().toISOString(),
    pages: capturedPages.map((page, index) => {
      // Normalize coordinates from CSS pixels to (0-1) range
      // Use viewportWidth for X
      // For Y: use viewportHeight if scroll was locked (modal capture), otherwise capturedHeight
      // capturedHeight accounts for truncation when page exceeds MAX_CAPTURE_HEIGHT_PIXELS
      const vw = page.viewportWidth || 1;
      const capturedH = page.capturedHeight || page.documentHeight || 1;
      const dh = page.isScrollLocked ? (page.viewportHeight || 1) : capturedH;

      // Filter out segments that are below the captured area (not visible in screenshot)
      const visibleSegments = page.segments.filter(seg => seg.y < capturedH);

      return {
        pageId: page.pageId,
        originalUrl: page.originalUrl,
        title: page.title,
        timestamp: page.timestamp,
        imageFile: `page_${index + 1}_${page.pageId}.${imageExt}`,
        // Debug info for diagnosing coordinate issues
        captureInfo: {
          viewportWidth: page.viewportWidth,
          viewportHeight: page.viewportHeight,
          documentWidth: page.documentWidth,
          documentHeight: page.documentHeight,
          capturedHeight: page.capturedHeight,
          screenshotScale: page.screenshotScale,
          isMobileEmulation: page.isMobileEmulation,
          hasHorizontalOverflow: (page.documentWidth || 0) > (page.viewportWidth || 0),
          isScrollLocked: page.isScrollLocked || false,
          // Calculated screenshot dimensions (CSS dims * scale)
          screenshotPixelWidth: Math.round((page.viewportWidth || 0) * (page.screenshotScale || 1)),
          screenshotPixelHeight: Math.round(dh * (page.screenshotScale || 1)),
        },
        // Segment coordinates normalized to (0-1) - PWA multiplies by display dimensions
        segments: visibleSegments.map(seg => ({
          g: seg.g,
          text: seg.text,
          x: seg.x / vw,
          y: seg.y / dh,
          width: seg.width / vw,
          height: seg.height / dh
        }))
      };
    })
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
 * Store flow ZIP temporarily in IndexedDB (for internal extension use)
 * This avoids Chrome's 64MB message passing limit
 */
async function storeFlowZipInDB(zipArrayBuffer: ArrayBuffer): Promise<string> {
  const flowId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const flowBlob = new Blob([zipArrayBuffer], { type: 'application/zip' });

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lqaboss-capture', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('temp-flows')) {
        db.createObjectStore('temp-flows', { keyPath: 'id' });
      }
    };
  });

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['temp-flows'], 'readwrite');
    const store = transaction.objectStore('temp-flows');
    const request = store.put({ id: flowId, zipBlob: flowBlob, timestamp: Date.now() });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });

  db.close();
  return flowId;
}

/**
 * Retrieve flow ZIP from IndexedDB
 */
async function getFlowZipFromDB(flowId: string): Promise<ArrayBuffer | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lqaboss-capture', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('temp-flows')) {
        db.createObjectStore('temp-flows', { keyPath: 'id' });
      }
    };
  });

  const result = await new Promise<{ id: string; zipBlob: Blob; timestamp: number } | undefined>((resolve, reject) => {
    const transaction = db.transaction(['temp-flows'], 'readonly');
    const store = transaction.objectStore('temp-flows');
    const request = store.get(flowId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

  db.close();

  if (!result) return null;
  return await result.zipBlob.arrayBuffer();
}

/**
 * Delete flow from IndexedDB after use
 */
async function deleteFlowFromDB(flowId: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lqaboss-capture', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['temp-flows'], 'readwrite');
    const store = transaction.objectStore('temp-flows');
    const request = store.delete(flowId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });

  db.close();
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
          // Read pages from storage (avoids 64MB message limit)
          const storageResult = await chrome.storage.local.get('capturedPages');
          const pages = storageResult.capturedPages as ExtendedCapturedPage[];

          if (!pages || pages.length === 0) {
            sendResponse({ success: false, error: 'No captured pages found' });
            break;
          }

          const zipArrayBuffer = await createFlowZIP(
            pages,
            request.instructions!,
            request.settings!
          );
          // Store in IndexedDB and return flowId (avoids 64MB message limit)
          const flowId = await storeFlowZipInDB(zipArrayBuffer);
          sendResponse({ success: true, flowId });
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

        case 'cancel-capture': {
          if (captureState.isCapturing && captureAbortController) {
            // Abort the capture
            captureAbortController.abort();

            // Clean up debugger if attached
            if (captureState.currentTabId) {
              try {
                await chrome.debugger.detach({ tabId: captureState.currentTabId });
              } catch { /* ignore - may already be detached */ }
            }

            // Reset state
            captureState.isCapturing = false;
            captureState.currentTabId = null;
            captureAbortController = null;

            sendResponse({ success: true, cancelled: true });
          } else {
            sendResponse({ success: false, error: 'No capture in progress' });
          }
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
          // Store flowId reference for PWA to retrieve (actual data is in IndexedDB)
          pendingFlow = {
            flowId: request.flowId!,
            fileName: request.fileName!,
            timestamp: Date.now()
          };
          sendResponse({ success: true });
          break;
        }

        case 'download-flow': {
          // Download flow directly from service worker (avoids 64MB message limit)
          const zipArrayBuffer = await getFlowZipFromDB(request.flowId!);
          if (!zipArrayBuffer) {
            sendResponse({ success: false, error: 'Flow not found' });
            break;
          }

          // Convert ArrayBuffer to base64 data URL
          // Service workers don't have URL.createObjectURL, so use data URL
          const uint8Array = new Uint8Array(zipArrayBuffer);

          // Build binary string efficiently by collecting chunks and joining
          // Using 8192 bytes per chunk to stay under call stack limits for String.fromCharCode.apply
          const binaryChunks: string[] = [];
          const chunkSize = 8192;
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
            binaryChunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
          }
          const binaryString = binaryChunks.join('');
          const base64Data = btoa(binaryString);
          const dataUrl = `data:application/octet-stream;base64,${base64Data}`;

          await chrome.downloads.download({
            url: dataUrl,
            filename: request.fileName!,
            saveAs: true,
            conflictAction: 'uniquify'
          });

          // Clean up IndexedDB
          await deleteFlowFromDB(request.flowId!);

          sendResponse({ success: true });
          break;
        }

        case 'lookup-single-segment': {
          // Single-segment TM lookup from xray overlay modal
          const segment = request.segment;
          if (!segment || !segment.g) {
            sendResponse({ success: false, error: 'No segment GUID' });
            break;
          }

          // Get settings
          const settingsResult = await chrome.storage.sync.get('lqaboss_settings');
          const lookupSettings: Settings = settingsResult.lqaboss_settings || {};

          if (!lookupSettings.tmEndpointUrl) {
            sendResponse({ success: false, error: 'TM endpoint not configured' });
            break;
          }

          // Fetch TU for this single segment
          const tmResult = await fetchTUsForSegments([segment], lookupSettings);

          if (tmResult.error) {
            sendResponse({ success: false, error: tmResult.error });
            break;
          }

          // Find the TU matching this segment's GUID
          const matchingTu = tmResult.tus.find(tu => tu.guid === segment.g);

          if (matchingTu) {
            sendResponse({ success: true, tu: matchingTu });
          } else {
            sendResponse({ success: false, error: 'No TM match found' });
          }
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
        'Cannot capture restricted pages',
        'Capture cancelled',
        'Capture timed out'
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
  try {
    // Check if declarativeNetRequest is available
    if (!chrome.declarativeNetRequest) {
      return { success: false, error: 'declarativeNetRequest API not available' };
    }

    // Only add rules if we have rules AND the side panel is open
    if (urlRewriteRules.length > 0 && sidePanelOpen) {
      // Convert our rules to declarativeNetRequest format
      const dynamicRules: chrome.declarativeNetRequest.Rule[] = urlRewriteRules.map((rule, index) => {
        return convertToDeclarativeRule(rule, URL_REWRITE_RULE_ID_BASE + index);
      });

      // Update dynamic rules (remove old ones, add new ones)
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: dynamicRules.map(r => r.id),
        addRules: dynamicRules
      });
    } else {
      // Remove all URL rewrite rules when panel is closed or no rules configured
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      const rewriteRuleIds = existingRules
        .filter(r => r.id >= URL_REWRITE_RULE_ID_BASE && r.id < URL_REWRITE_RULE_ID_BASE + 1000)
        .map(r => r.id);

      if (rewriteRuleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: rewriteRuleIds
        });
      }
    }
    return { success: true };
  } catch (error) {
    const errorMsg = (error as Error).message;
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
            const storageData = await chrome.storage.local.get(['capturedPages', 'instructions']);
            const capturedPages: ExtendedCapturedPage[] = storageData.capturedPages || [];
            const instructions: string = storageData.instructions || '';

            if (capturedPages.length === 0) {
              sendResponse({
                success: false,
                error: 'No flow available. Please capture pages in the extension first.'
              });
              return;
            }

            // Create flow from captured pages and store in IndexedDB
            try {
              const settings = await chrome.storage.sync.get('lqaboss_settings');
              const userSettings: Settings = settings.lqaboss_settings || {};

              const zipArrayBuffer = await createFlowZIP(
                capturedPages,
                instructions,
                userSettings
              );

              const fileName = generateFileName(userSettings.jobName);

              // Store in IndexedDB and create pendingFlow for chunked transfer
              const flowId = await storeFlowZipInDB(zipArrayBuffer);
              pendingFlow = {
                flowId,
                fileName,
                timestamp: Date.now()
              };

              // Fall through to the normal pendingFlow handling below
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
            // Clean up expired flow from IndexedDB
            await deleteFlowFromDB(pendingFlow.flowId);
            pendingFlow = null;
            sendResponse({
              success: false,
              error: 'Flow data expired. Please send from extension again.'
            });
            return;
          }

          // Read ZIP from IndexedDB
          const zipArrayBuffer = await getFlowZipFromDB(pendingFlow.flowId);
          if (!zipArrayBuffer) {
            pendingFlow = null;
            sendResponse({
              success: false,
              error: 'Flow data not found'
            });
            return;
          }

          const totalSize = zipArrayBuffer.byteLength;
          const fileName = pendingFlow.fileName;

          // If small enough, send directly (existing behavior)
          if (!needsChunkedTransfer(totalSize)) {
            const zipBase64 = new Uint8Array(zipArrayBuffer).toBase64();

            // Clean up IndexedDB and clear pending flow reference
            await deleteFlowFromDB(pendingFlow.flowId);
            pendingFlow = null;

            // Notify side panel that flow was successfully retrieved
            if (sidePanelPort) {
              try {
                sidePanelPort.postMessage({ action: 'flow-retrieved-by-pwa' });
              } catch {
                // Port may be disconnected
              }
            }

            sendResponse({
              success: true,
              data: { zipBase64, fileName }
            });
            return;
          }

          // Large flow: send metadata, keep data for chunk requests
          const totalChunks = calculateChunkCount(totalSize);
          console.log(`[ServiceWorker] Large flow detected (${(totalSize / 1024 / 1024).toFixed(1)}MB), using chunked transfer (${totalChunks} chunks)`);

          sendResponse({
            success: true,
            data: {
              flowId: pendingFlow.flowId,
              fileName,
              totalSize,
              totalChunks,
              chunked: true
            }
          });
          // Don't delete flow yet - will be deleted after all chunks retrieved
          break;
        }

        case 'requestFlowChunk': {
          const { flowId, chunkIndex } = request;

          if (!flowId || chunkIndex === undefined) {
            sendResponse({ success: false, error: 'Missing flowId or chunkIndex' });
            return;
          }

          const zipArrayBuffer = await getFlowZipFromDB(flowId);
          if (!zipArrayBuffer) {
            sendResponse({ success: false, error: 'Flow not found' });
            return;
          }

          const totalSize = zipArrayBuffer.byteLength;
          const { start, end } = getChunkRange(chunkIndex, totalSize);
          const chunk = zipArrayBuffer.slice(start, end);
          const chunkBase64 = new Uint8Array(chunk).toBase64();

          const lastChunk = isLastChunk(chunkIndex, totalSize);
          const totalChunks = calculateChunkCount(totalSize);

          console.log(`[ServiceWorker] Sending chunk ${chunkIndex + 1}/${totalChunks} (${(chunk.byteLength / 1024 / 1024).toFixed(1)}MB)`);

          // Clean up after last chunk
          if (lastChunk) {
            await deleteFlowFromDB(flowId);
            pendingFlow = null;
            console.log('[ServiceWorker] Chunked transfer complete, cleaned up');

            // Notify side panel that flow was successfully retrieved
            if (sidePanelPort) {
              try {
                sidePanelPort.postMessage({ action: 'flow-retrieved-by-pwa' });
              } catch {
                // Port may be disconnected
              }
            }
          }

          sendResponse({
            success: true,
            data: {
              chunkIndex,
              chunkBase64,
              isLastChunk: lastChunk
            }
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

// Handle keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-xray') {
    // Only works when side panel is open
    if (sidePanelPort) {
      try {
        sidePanelPort.postMessage({ action: 'keyboard-toggle-xray' });
      } catch {
        // Port may be disconnected - ignore
      }
    }
  } else if (command === 'refresh-xray') {
    // Only works when side panel is open
    if (sidePanelPort) {
      try {
        sidePanelPort.postMessage({ action: 'keyboard-refresh-xray' });
      } catch {
        // Port may be disconnected - ignore
      }
    }
  }
});

export {};
