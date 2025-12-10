/**
 * X-Ray Vision Overlay
 * Visualizes detected segments with colored overlays and tooltips
 */

import type {
  Segment,
  RuntimeMessage as BaseRuntimeMessage,
  RuntimeResponse as BaseRuntimeResponse
} from '../types/shared.js';

interface NormalizedPlaceholder {
  t: 'bx' | 'ex' | 'x';
  v: string;
  s?: string;
  v1?: string;
}

type NormalizedItem = string | NormalizedPlaceholder;

interface TranslationUnit {
  guid: string;
  rid?: string;
  sid?: string;
  nsrc?: NormalizedItem[];
  ntgt?: NormalizedItem[];
  // Legacy simple format
  source?: string;
  target?: string;
  q: number;
  ts: number | string;
  translationProvider?: string;
  notes?: {
    ph?: { [key: string]: { sample?: string; desc?: string } };
    desc?: string;
  } | string;
}

// Convert normalized array to readable string
function normalizedToString(items: NormalizedItem[]): string {
  return items.map(item => {
    if (typeof item === 'string') {
      return item;
    }
    // For placeholders, always use the placeholder code (v), not the sample value (s)
    return item.v || '';
  }).join('');
}

// Format timestamp for display
function formatTimestamp(ts: number | string): string {
  if (typeof ts === 'number') {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return ts;
}

interface RuntimeMessage extends BaseRuntimeMessage {
  enabled?: boolean;
  segments?: Segment[];
  tus?: TranslationUnit[];
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
// Store TU data for modal display (guid -> TranslationUnit)
let tusByGuid: Map<string, TranslationUnit> = new Map();
// Currently open modal element
let currentModal: HTMLDivElement | null = null;

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

    .lqaboss-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.3);
      z-index: 1000002;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 50px;
    }

    .lqaboss-modal {
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      color: #333;
    }

    .lqaboss-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid #e0e0e0;
      background: #f5f5f5;
      border-radius: 8px 8px 0 0;
      position: sticky;
      top: 0;
    }

    .lqaboss-modal-title {
      font-weight: 600;
      font-size: 14px;
      color: #333;
      margin: 0;
    }

    .lqaboss-modal-close {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: #666;
      padding: 0 4px;
      line-height: 1;
    }

    .lqaboss-modal-close:hover {
      color: #333;
    }

    .lqaboss-modal-section {
      padding: 12px 16px;
      border-bottom: 1px solid #e0e0e0;
    }

    .lqaboss-modal-section:last-child {
      border-bottom: none;
    }

    .lqaboss-modal-section-title {
      font-weight: 600;
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .lqaboss-modal-row {
      display: flex;
      margin-bottom: 6px;
    }

    .lqaboss-modal-row:last-child {
      margin-bottom: 0;
    }

    .lqaboss-modal-label {
      color: #666;
      min-width: 80px;
      flex-shrink: 0;
    }

    .lqaboss-modal-value {
      color: #333;
      word-break: break-all;
      user-select: text;
      cursor: text;
    }

    .lqaboss-modal-value.na {
      color: #999;
      font-style: italic;
    }

    .lqaboss-lookup-btn {
      background: #0066cc;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      margin-top: 8px;
    }

    .lqaboss-lookup-btn:hover {
      background: #0055aa;
    }

    .lqaboss-lookup-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .lqaboss-lookup-btn.loading {
      opacity: 0.7;
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

function closeModal(): void {
  if (currentModal) {
    currentModal.remove();
    currentModal = null;
  }
}

function showSegmentModal(seg: Segment): void {
  closeModal();

  const tu = seg.g ? tusByGuid.get(seg.g) : undefined;

  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'lqaboss-modal-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });

  // Create modal
  const modal = document.createElement('div');
  modal.className = 'lqaboss-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'lqaboss-modal-header';
  header.innerHTML = `
    <span class="lqaboss-modal-title">Segment Details</span>
    <button class="lqaboss-modal-close">&times;</button>
  `;
  header.querySelector('.lqaboss-modal-close')?.addEventListener('click', closeModal);
  modal.appendChild(header);

  // Invisicode Metadata Section
  const invisiSection = document.createElement('div');
  invisiSection.className = 'lqaboss-modal-section';
  invisiSection.innerHTML = `<div class="lqaboss-modal-section-title">Invisicode Metadata</div>`;

  // Collect metadata fields (exclude positional and display fields)
  const excludeFields = new Set(['text', 'x', 'y', 'width', 'height', 'decodingError', 'matched']);
  let hasMetadata = false;

  for (const [key, value] of Object.entries(seg)) {
    if (!excludeFields.has(key) && value !== undefined && value !== null) {
      hasMetadata = true;
      const row = document.createElement('div');
      row.className = 'lqaboss-modal-row';
      const displayKey = key.toUpperCase();
      row.innerHTML = `
        <span class="lqaboss-modal-label">${displayKey}:</span>
        <span class="lqaboss-modal-value">${String(value)}</span>
      `;
      invisiSection.appendChild(row);
    }
  }

  if (!hasMetadata) {
    const row = document.createElement('div');
    row.className = 'lqaboss-modal-row';
    row.innerHTML = `<span class="lqaboss-modal-value na">No metadata available</span>`;
    invisiSection.appendChild(row);
  }

  if (seg.decodingError) {
    const row = document.createElement('div');
    row.className = 'lqaboss-modal-row';
    row.innerHTML = `
      <span class="lqaboss-modal-label">Error:</span>
      <span class="lqaboss-modal-value" style="color: #cc0000;">${seg.decodingError}</span>
    `;
    invisiSection.appendChild(row);
  }

  modal.appendChild(invisiSection);

  // TM Lookup Section
  const tmSection = document.createElement('div');
  tmSection.className = 'lqaboss-modal-section';
  tmSection.innerHTML = `<div class="lqaboss-modal-section-title">TM Lookup</div>`;

  if (tu) {
    // Get source and target text (handle both nsrc/ntgt and legacy source/target)
    const sourceText = tu.nsrc ? normalizedToString(tu.nsrc) : tu.source || '';
    const targetText = tu.ntgt ? normalizedToString(tu.ntgt) : tu.target || '';

    // Get notes description
    let notesDesc = '';
    if (tu.notes) {
      if (typeof tu.notes === 'string') {
        notesDesc = tu.notes;
      } else if (tu.notes.desc) {
        notesDesc = tu.notes.desc.trim();
      }
    }

    // Build fields array
    const fields: { label: string; value: string }[] = [];

    if (tu.rid) {
      fields.push({ label: 'RID', value: tu.rid });
    }
    if (tu.sid) {
      fields.push({ label: 'SID', value: tu.sid });
    }
    fields.push({ label: 'Source', value: sourceText });
    fields.push({ label: 'Target', value: targetText });
    fields.push({ label: 'Quality', value: String(tu.q) });
    fields.push({ label: 'Timestamp', value: formatTimestamp(tu.ts) });
    if (tu.translationProvider) {
      fields.push({ label: 'Provider', value: tu.translationProvider });
    }
    if (notesDesc) {
      fields.push({ label: 'Notes', value: notesDesc });
    }

    for (const field of fields) {
      const row = document.createElement('div');
      row.className = 'lqaboss-modal-row';
      row.innerHTML = `
        <span class="lqaboss-modal-label">${field.label}:</span>
        <span class="lqaboss-modal-value">${field.value || 'N/A'}</span>
      `;
      tmSection.appendChild(row);
    }
  } else {
    // No TU data - show N/A and Lookup button
    const naRow = document.createElement('div');
    naRow.className = 'lqaboss-modal-row';
    naRow.innerHTML = `<span class="lqaboss-modal-value na">No TM data available</span>`;
    tmSection.appendChild(naRow);

    // Only show Lookup button if segment has a guid
    if (seg.g) {
      const lookupBtn = document.createElement('button');
      lookupBtn.className = 'lqaboss-lookup-btn';
      lookupBtn.textContent = 'Lookup';
      lookupBtn.addEventListener('click', async () => {
        lookupBtn.disabled = true;
        lookupBtn.classList.add('loading');
        lookupBtn.textContent = 'Looking up...';

        try {
          const response = await chrome.runtime.sendMessage({
            action: 'lookup-single-segment',
            segment: seg
          });

          if (response.success && response.tu) {
            // Store the TU
            tusByGuid.set(seg.g!, response.tu);

            // Update segment matched status
            seg.matched = true;

            // Update currentSegments array so the matched status persists
            const segIndex = currentSegments.findIndex(s => s.g === seg.g);
            if (segIndex !== -1) {
              currentSegments[segIndex].matched = true;
            }

            // Update segment element's visual appearance
            const segmentEl = document.querySelector(
              `.lqaboss-segment-highlight[data-guid="${seg.g}"]`
            ) as HTMLElement;
            if (segmentEl) {
              segmentEl.classList.remove('default', 'unmatched');
              segmentEl.classList.add('matched');
            }

            // Refresh modal to show the TU data
            showSegmentModal(seg);
          } else {
            // Show error briefly, then reset button for retry
            lookupBtn.textContent = response.error || 'No match found';
            lookupBtn.classList.remove('loading');
            setTimeout(() => {
              lookupBtn.textContent = 'Lookup';
              lookupBtn.disabled = false;
            }, 2000);
          }
        } catch (error) {
          // Show error briefly, then reset button for retry
          lookupBtn.textContent = 'Lookup failed';
          lookupBtn.classList.remove('loading');
          setTimeout(() => {
            lookupBtn.textContent = 'Lookup';
            lookupBtn.disabled = false;
          }, 2000);
        }
      });
      tmSection.appendChild(lookupBtn);
    }
  }

  modal.appendChild(tmSection);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  currentModal = overlay;
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
    // - matched === true (explicitly matched by TM) → green
    // - matched === false (explicitly unmatched by TM) → red
    // - matched is undefined/null (not yet looked up) → gray
    let colorClass = 'default';
    if (Object.prototype.hasOwnProperty.call(seg, 'matched')) {
      if (seg.matched === true) {
        colorClass = 'matched';
      } else if (seg.matched === false) {
        colorClass = 'unmatched';
      }
    }

    highlight.className = `lqaboss-segment-highlight ${colorClass}`;

    // Add data-guid for easy lookup when updating segment appearance
    if (seg.g) {
      highlight.setAttribute('data-guid', seg.g);
    }

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

    // Click to show modal with segment details
    highlight.addEventListener('click', (e) => {
      e.stopPropagation();
      showSegmentModal(seg);
    });

    overlay.appendChild(highlight);
  });

  document.body.appendChild(overlay);
}

function toggleXRayVision(enabled: boolean, segments: Segment[] = [], tus: TranslationUnit[] = []): void {
  if (enabled && segments.length > 0) {
    // Always remove existing overlay first to ensure clean state
    removeOverlay();
    closeModal();

    // Store TU data for modal display
    tusByGuid.clear();
    for (const tu of tus) {
      if (tu.guid) {
        tusByGuid.set(tu.guid, tu);
      }
    }

    createOverlay(segments);
    currentSegments = segments;
    isCurrentlyVisible = true;
  } else {
    // Clear all pending timeouts to prevent recreation
    clearTimeout(resizeTimeout);
    clearTimeout(scrollTimeout);

    removeOverlay();
    closeModal();
    currentSegments = [];
    isCurrentlyVisible = false;
  }
}

// Listen for messages from background/side panel
chrome.runtime.onMessage.addListener((request: RuntimeMessage, sender, sendResponse) => {
  if (request.action === 'toggle-xray') {
    // Side panel enable/disable - also sets user preference
    xrayUserEnabled = request.enabled || false;
    toggleXRayVision(request.enabled || false, request.segments || [], request.tus || []);
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
    if (wasVisible) {
      removeOverlay();
      isCurrentlyVisible = false;  // Prevent scroll/resize/click handlers from recreating overlay
    }
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

  clearTimeout(scrollTimeout);
  scrollTimeout = window.setTimeout(() => {
    if (!isCurrentlyVisible || !xrayUserEnabled || !(window as any).LQABOSS_extractTextAndMetadata) return;

    // Hide overlay only briefly during re-extraction
    const overlay = document.getElementById(XRAY_OVERLAY_ID);
    if (overlay) {
      overlay.style.display = 'none';
    }

    const result = (window as any).LQABOSS_extractTextAndMetadata();

    if (result?.textElements) {
      updateOverlayPositions(result.textElements);
      // Ensure overlay respects user preference after update
      const updatedOverlay = document.getElementById(XRAY_OVERLAY_ID);
      if (updatedOverlay) {
        updatedOverlay.style.display = xrayUserEnabled ? '' : 'none';
      }
    }
  }, 150);
}, true);

// Listen for click events to re-extract after DOM changes (modals, dropdowns, etc.)
let clickTimeout: number | undefined;
document.addEventListener('click', () => {
  if (!isCurrentlyVisible || !xrayUserEnabled) return;

  // Delay to allow modals/dynamic content to render
  clearTimeout(clickTimeout);
  clickTimeout = window.setTimeout(() => {
    if (!isCurrentlyVisible || !xrayUserEnabled || !(window as any).LQABOSS_extractTextAndMetadata) return;

    const overlay = document.getElementById(XRAY_OVERLAY_ID);
    if (overlay) {
      overlay.style.display = 'none';
    }

    const result = (window as any).LQABOSS_extractTextAndMetadata();

    if (result?.textElements) {
      updateOverlayPositions(result.textElements);
      const updatedOverlay = document.getElementById(XRAY_OVERLAY_ID);
      if (updatedOverlay) {
        updatedOverlay.style.display = xrayUserEnabled ? '' : 'none';
      }
    }
  }, 300);
}, true);

} // End guard against multiple injections
