/**
 * X-Ray Vision Overlay
 * Visualizes detected segments with colored overlays and tooltips
 */

// Guard against multiple injections
if (typeof window.LQABOSS_XRAY_LOADED === 'undefined') {
  window.LQABOSS_XRAY_LOADED = true;

const XRAY_OVERLAY_ID = 'lqaboss-xray-overlay';
const XRAY_STYLE_ID = 'lqaboss-xray-styles';

// Track current state for temporary hide/restore
let currentSegments = [];
let isCurrentlyVisible = false;

// Helper to notify side panel of segment count changes
function notifySidePanelSegmentCount(count) {
  chrome.runtime.sendMessage({
    action: 'segment-count-updated',
    count: count
  }).catch(() => {
    // Ignore if side panel is not open
  });
}

function createStyles() {
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

function removeOverlay() {
  const existingOverlay = document.getElementById(XRAY_OVERLAY_ID);
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const existingStyle = document.getElementById(XRAY_STYLE_ID);
  if (existingStyle) {
    existingStyle.remove();
  }
}

function createOverlay(segments) {
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
    const tooltipLines = [];
    tooltipLines.push(`Segment #${index + 1}`);
    tooltipLines.push(`Text: ${seg.text.substring(0, 60)}${seg.text.length > 60 ? '...' : ''}`);

    // Show extracted metadata (exclude fields added by extractor)
    const excludeFields = new Set(['text', 'x', 'y', 'width', 'height', 'decodingError', 'matched']);
    const metadataLines = [];

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

function toggleXRayVision(enabled, segments = []) {
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
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggle-xray') {
    toggleXRayVision(request.enabled, request.segments || []);
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
function updateOverlayPositions(newSegments) {
  // Preserve matched status from current segments by matching on GUID
  const segmentsWithMatchStatus = newSegments.map((seg) => {
    // Try to find matching segment by GUID
    const matchingSegment = currentSegments.find(current =>
      seg.g && current.g && seg.g === current.g
    );

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
let resizeTimeout;
window.addEventListener('resize', () => {
  if (!isCurrentlyVisible) return;

  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (!isCurrentlyVisible || !window.LQABOSS_extractTextAndMetadata) return;

    const overlay = document.getElementById(XRAY_OVERLAY_ID);
    if (!overlay) return;

    overlay.style.display = 'none';
    const result = window.LQABOSS_extractTextAndMetadata();
    overlay.style.display = '';

    if (result?.textElements) {
      updateOverlayPositions(result.textElements);
    }
  }, 250);
});

// Listen for scroll events (including from scrollable containers)
let scrollTimeout;
document.addEventListener('scroll', () => {
  if (!isCurrentlyVisible) return;

  const overlay = document.getElementById(XRAY_OVERLAY_ID);
  if (!overlay) return;

  overlay.style.display = 'none';

  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    if (!isCurrentlyVisible || !window.LQABOSS_extractTextAndMetadata) return;

    const result = window.LQABOSS_extractTextAndMetadata();

    if (result?.textElements) {
      updateOverlayPositions(result.textElements);
    }
  }, 100);
}, true);

// Shift-hold to temporarily hide X-ray
let shiftHeldDown = false;
let savedSegmentsForShift = [];

function handleShiftState(e) {
  if (!isCurrentlyVisible) return;

  // Check if ONLY Shift is currently pressed (no other modifiers)
  const onlyShiftPressed = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;

  const overlay = document.getElementById(XRAY_OVERLAY_ID);
  if (!overlay) return;

  if (onlyShiftPressed && !shiftHeldDown) {
    // Hide overlay
    shiftHeldDown = true;
    savedSegmentsForShift = [...currentSegments];
    overlay.style.display = 'none';
  } else if (!onlyShiftPressed && shiftHeldDown) {
    // Restore overlay
    overlay.style.display = '';
    shiftHeldDown = false;
    savedSegmentsForShift = [];
  }
}

window.addEventListener('keydown', handleShiftState);
window.addEventListener('keyup', handleShiftState);

} // End guard against multiple injections
