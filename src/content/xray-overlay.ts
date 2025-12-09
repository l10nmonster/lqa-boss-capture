/**
 * X-Ray Vision Overlay
 * Visualizes detected segments with colored overlays and tooltips
 */

import type {
  Segment,
  RuntimeMessage as BaseRuntimeMessage,
  RuntimeResponse as BaseRuntimeResponse
} from '../types/shared.js';

interface RuntimeMessage extends BaseRuntimeMessage {
  enabled?: boolean;
  segments?: Segment[];
  count?: number;
}

interface RuntimeResponse extends BaseRuntimeResponse {
  wasVisible?: boolean;
}

// Guard against multiple injections
if (typeof (window as any).LQABOSS_XRAY_LOADED === 'undefined') {
  (window as any).LQABOSS_XRAY_LOADED = true;

const XRAY_OVERLAY_ID = 'lqaboss-xray-overlay';
const XRAY_STYLE_ID = 'lqaboss-xray-styles';

// Track current state for temporary hide/restore
let currentSegments: Segment[] = [];
let isCurrentlyVisible = false;
// User preference - when false, X-ray stays hidden even after scroll/resize
let xrayUserEnabled = true;

// Helper to notify side panel of X-ray state changes
function notifySidePanelXrayState(enabled: boolean): void {
  const message: RuntimeMessage = {
    action: 'xray-state-changed',
    enabled: enabled
  };
  chrome.runtime.sendMessage(message).catch(() => {
    // Ignore if side panel is not open
  });
}

// Helper to notify side panel of segment count changes
function notifySidePanelSegmentCount(count: number): void {
  const message: RuntimeMessage = {
    action: 'segment-count-updated',
    count: count
  };
  chrome.runtime.sendMessage(message).catch(() => {
    // Ignore if side panel is not open
  });
}

function createStyles(): void {
  if (document.getElementById(XRAY_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = XRAY_STYLE_ID;
  style.textContent = `
    .lqaboss-segment-highlight {
      position: absolute;
      pointer-events: auto;
      cursor: pointer;
      transition: background 0.2s ease;
      box-sizing: border-box;
      min-width: 20px;
      min-height: 16px;
    }

    .lqaboss-segment-highlight.default {
      background: rgba(100, 100, 100, 0.15);
      border: 2px dashed rgba(100, 100, 100, 0.8);
    }

    .lqaboss-segment-highlight.default:hover {
      background: rgba(100, 100, 100, 0.3);
      border-color: rgba(100, 100, 100, 1);
      border-style: solid;
    }

    .lqaboss-segment-highlight.matched {
      background: rgba(0, 255, 0, 0.15);
      border: 2px dashed rgba(0, 255, 0, 0.7);
    }

    .lqaboss-segment-highlight.matched:hover {
      background: rgba(0, 255, 0, 0.3);
      border-color: rgba(0, 255, 0, 1);
      border-style: solid;
    }

    .lqaboss-segment-highlight.unmatched {
      background: rgba(255, 0, 0, 0.15);
      border: 2px dashed rgba(255, 0, 0, 0.7);
    }

    .lqaboss-segment-highlight.unmatched:hover {
      background: rgba(255, 0, 0, 0.3);
      border-color: rgba(255, 0, 0, 1);
      border-style: solid;
    }

    .lqaboss-tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.95);
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 11px;
      white-space: pre-wrap;
      display: none;
      z-index: 1000001;
      max-width: 300px;
      word-wrap: break-word;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
      pointer-events: none;
      direction: ltr;
      text-align: left;
    }

    .lqaboss-segment-highlight:hover .lqaboss-tooltip {
      display: block;
    }

    .lqaboss-tooltip-label {
      color: #888;
      font-size: 10px;
      text-transform: uppercase;
      margin-top: 4px;
    }
  `;

  document.head.appendChild(style);
}

function removeOverlay(): void {
  const existingOverlay = document.getElementById(XRAY_OVERLAY_ID);
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const existingStyle = document.getElementById(XRAY_STYLE_ID);
  if (existingStyle) {
    existingStyle.remove();
  }
}

function createOverlay(segments: Segment[]): void {
  removeOverlay();
  createStyles();

  const overlay = document.createElement('div');
  overlay.id = XRAY_OVERLAY_ID;

  // Get full document dimensions
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  );
  const docWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth
  );

  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: ${docWidth}px;
    height: ${docHeight}px;
    pointer-events: none;
    z-index: 999999;
  `;

  segments.forEach((seg, index) => {
    // Skip segments with no dimensions (invisible/off-screen)
    if (!seg.width || !seg.height || seg.width <= 0 || seg.height <= 0) {
      return;
    }

    const highlight = document.createElement('div');

    // Determine color class based on matched status
    let colorClass = 'default';
    if (seg.matched === true) {
      colorClass = 'matched';
    } else if (seg.matched === false) {
      colorClass = 'unmatched';
    }

    highlight.className = `lqaboss-segment-highlight ${colorClass}`;

    // Add padding around the segment (4px on all sides)
    const padding = 4;
    const width = Math.max(seg.width, 20) + (padding * 2);
    const height = Math.max(seg.height, 16) + (padding * 2);

    highlight.style.cssText = `
      left: ${seg.x - padding}px;
      top: ${seg.y - padding}px;
      width: ${width}px;
      height: ${height}px;
    `;


    // Create tooltip content
    const tooltipLines: string[] = [];
    tooltipLines.push(`Segment #${index + 1}`);
    tooltipLines.push(`Text: ${seg.text.substring(0, 60)}${seg.text.length > 60 ? '...' : ''}`);

    // Show extracted metadata (exclude fields added by extractor)
    const excludeFields = new Set(['text', 'x', 'y', 'width', 'height', 'decodingError', 'matched']);
    const metadataLines: string[] = [];

    for (const [key, value] of Object.entries(seg)) {
      if (!excludeFields.has(key) && value !== undefined && value !== null) {
        // Format the key nicely
        const displayKey = key.charAt(0).toUpperCase() + key.slice(1);
        // Truncate long values
        const displayValue = String(value).length > 40
          ? String(value).substring(0, 40) + '...'
          : String(value);
        metadataLines.push(`${displayKey}: ${displayValue}`);
      }
    }

    if (metadataLines.length > 0) {
      tooltipLines.push(''); // Empty line
      tooltipLines.push(...metadataLines);
    }

    if (seg.decodingError) {
      tooltipLines.push('');
      tooltipLines.push(`⚠️ Decode Error: ${seg.decodingError}`);
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'lqaboss-tooltip';
    tooltip.textContent = tooltipLines.join('\n');

    // Position tooltip above or below highlight
    if (seg.y > 100) {
      tooltip.style.bottom = `${seg.height + 5}px`;
    } else {
      tooltip.style.top = `${seg.height + 5}px`;
    }
    tooltip.style.left = '0px';

    // Click to copy GUID
    highlight.addEventListener('click', (e) => {
      e.stopPropagation();
      if (seg.g) {
        navigator.clipboard.writeText(seg.g).then(() => {
          // Visual feedback - flash white
          const originalBg = highlight.style.background;
          highlight.style.background = 'rgba(255, 255, 255, 0.6)';
          setTimeout(() => {
            highlight.style.background = originalBg;
          }, 300);
        });
      }
    });

    highlight.appendChild(tooltip);
    overlay.appendChild(highlight);
  });

  document.body.appendChild(overlay);
}

function toggleXRayVision(enabled: boolean, segments: Segment[] = []): void {
  if (enabled && segments.length > 0) {
    // Always remove existing overlay first to ensure clean state
    removeOverlay();
    createOverlay(segments);
    currentSegments = segments;
    isCurrentlyVisible = true;
  } else {
    // Clear all pending timeouts to prevent recreation
    clearTimeout(resizeTimeout);
    clearTimeout(scrollTimeout);

    removeOverlay();
    currentSegments = [];
    isCurrentlyVisible = false;
  }
}

// Listen for messages from background/side panel
chrome.runtime.onMessage.addListener((request: RuntimeMessage, sender, sendResponse) => {
  if (request.action === 'toggle-xray') {
    // Side panel enable/disable - also sets user preference
    xrayUserEnabled = request.enabled || false;
    toggleXRayVision(request.enabled || false, request.segments || []);
    notifySidePanelXrayState(xrayUserEnabled);
  } else if (request.action === 'toggleXray') {
    // Keyboard shortcut toggle - toggle user preference
    xrayUserEnabled = !xrayUserEnabled;

    if (xrayUserEnabled) {
      // Re-extract segments when enabling via keyboard shortcut
      // This handles cases where page content changed (modals, dynamic content)
      if ((window as any).LQABOSS_extractTextAndMetadata) {
        const result = (window as any).LQABOSS_extractTextAndMetadata();
        if (result?.textElements) {
          updateOverlayPositions(result.textElements);
          const overlay = document.getElementById(XRAY_OVERLAY_ID);
          if (overlay) {
            overlay.style.display = '';
          }
        }
      }
    } else {
      // Just hide the overlay
      const overlay = document.getElementById(XRAY_OVERLAY_ID);
      if (overlay) {
        overlay.style.display = 'none';
      }
    }

    notifySidePanelXrayState(xrayUserEnabled);
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'setXrayEnabled') {
    // Checkbox toggle from side panel
    xrayUserEnabled = request.enabled || false;

    if (xrayUserEnabled) {
      // Re-extract segments when enabling
      if ((window as any).LQABOSS_extractTextAndMetadata) {
        const result = (window as any).LQABOSS_extractTextAndMetadata();
        if (result?.textElements) {
          updateOverlayPositions(result.textElements);
          const overlay = document.getElementById(XRAY_OVERLAY_ID);
          if (overlay) {
            overlay.style.display = '';
          }
        }
      }
    } else {
      const overlay = document.getElementById(XRAY_OVERLAY_ID);
      if (overlay) {
        overlay.style.display = 'none';
      }
    }

    sendResponse({ success: true });
    return true;
  } else if (request.action === 'hide-xray-temporarily') {
    const wasVisible = isCurrentlyVisible;
    if (wasVisible) removeOverlay();
    sendResponse({ success: true, wasVisible });
    return true;
  } else if (request.action === 'restore-xray') {
    if (currentSegments.length > 0) {
      createOverlay(currentSegments);
      isCurrentlyVisible = true;
    }
  }
  sendResponse({ success: true });
  return true;
});

// Update overlay positions with new segment coordinates
function updateOverlayPositions(newSegments: Segment[]): void {
  // Preserve matched status from current segments using multiple matching strategies
  const segmentsWithMatchStatus = newSegments.map((seg, index) => {
    // Strategy 1: Match by GUID if both have it
    let matchingSegment = currentSegments.find(current =>
      seg.g && current.g && seg.g === current.g
    );

    // Strategy 2: Match by text content if GUID match failed
    if (!matchingSegment) {
      matchingSegment = currentSegments.find(current =>
        current.text === seg.text
      );
    }

    // Strategy 3: Match by index if same number of segments
    if (!matchingSegment && currentSegments.length === newSegments.length) {
      matchingSegment = currentSegments[index];
    }

    return {
      ...seg,
      matched: matchingSegment?.matched
    };
  });

  // Recreate overlay with new positions (simpler than trying to update in place)
  createOverlay(segmentsWithMatchStatus);
  currentSegments = segmentsWithMatchStatus;

  // Notify side panel of updated segment count
  notifySidePanelSegmentCount(segmentsWithMatchStatus.length);
}

// Listen for window resize and update positions
let resizeTimeout: number | undefined;
window.addEventListener('resize', () => {
  if (!isCurrentlyVisible || !xrayUserEnabled) return;

  clearTimeout(resizeTimeout);
  resizeTimeout = window.setTimeout(() => {
    if (!isCurrentlyVisible || !xrayUserEnabled || !(window as any).LQABOSS_extractTextAndMetadata) return;

    const overlay = document.getElementById(XRAY_OVERLAY_ID);
    if (!overlay) return;

    overlay.style.display = 'none';
    const result = (window as any).LQABOSS_extractTextAndMetadata();
    // Restore display only if user still wants X-ray enabled
    overlay.style.display = xrayUserEnabled ? '' : 'none';

    if (result?.textElements) {
      updateOverlayPositions(result.textElements);
    }
  }, 250);
});

// Listen for scroll events (including from scrollable containers)
let scrollTimeout: number | undefined;
document.addEventListener('scroll', () => {
  if (!isCurrentlyVisible || !xrayUserEnabled) return;

  const overlay = document.getElementById(XRAY_OVERLAY_ID);
  if (!overlay) return;

  overlay.style.display = 'none';

  clearTimeout(scrollTimeout);
  scrollTimeout = window.setTimeout(() => {
    if (!isCurrentlyVisible || !xrayUserEnabled || !(window as any).LQABOSS_extractTextAndMetadata) return;

    const result = (window as any).LQABOSS_extractTextAndMetadata();

    if (result?.textElements) {
      updateOverlayPositions(result.textElements);
      // Ensure overlay respects user preference after update
      const updatedOverlay = document.getElementById(XRAY_OVERLAY_ID);
      if (updatedOverlay) {
        updatedOverlay.style.display = xrayUserEnabled ? '' : 'none';
      }
    }
  }, 100);
}, true);


} // End guard against multiple injections
