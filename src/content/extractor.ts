/**
 * Text and metadata extraction content script
 * Ported from flowCapture.js:extractTextAndMetadataInPageContext
 */

interface TextElement {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: any;
}

interface ExtractionResult {
  textElements?: TextElement[];
  error?: string;
}

interface ActiveSegment {
  startNode: Node;
  startOffset: number;
  encodedMetadata: string;
  text: string;
}

function fe00RangeToUtf8Browser(encoded: string): string {
  const encodingOffset = 0xfe00;
  const decoder = new TextDecoder();
  const length = encoded.length;

  if (length % 2 !== 0) throw new Error('Invalid fe00 encoded input length');

  const bytes = new Uint8Array(length / 2);
  let byteIndex = 0;

  for (let i = 0; i < length; i += 2) {
    const highNibble = encoded.charCodeAt(i) - encodingOffset;
    const lowNibble = encoded.charCodeAt(i + 1) - encodingOffset;

    if (highNibble < 0 || highNibble > 15 || lowNibble < 0 || lowNibble > 15) {
      throw new Error('Invalid char code in fe00 encoded input');
    }

    bytes[byteIndex++] = (highNibble << 4) | lowNibble;
  }

  return decoder.decode(bytes);
}

/**
 * Check if a rect is actually visible to the user
 * @param rect - The bounding rectangle to check
 * @param parentElement - The parent element of the text node
 * @returns True if the element is visible
 */
function isRectVisible(rect: DOMRect, parentElement: Element): boolean {
  // Check if rect has valid dimensions
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  // Check if element is clipped by any parent with overflow
  let element: Element | null = parentElement;
  while (element && element !== document.body) {
    const styles = window.getComputedStyle(element);
    const overflow = styles.overflow + styles.overflowX + styles.overflowY;

    if (overflow.includes('hidden') || overflow.includes('scroll') || overflow.includes('clip')) {
      const elementRect = element.getBoundingClientRect();

      // Check if rect is completely outside the parent's bounds
      if (rect.right <= elementRect.left ||
          rect.left >= elementRect.right ||
          rect.bottom <= elementRect.top ||
          rect.top >= elementRect.bottom) {
        return false;
      }

      // Check if rect is only partially visible (more than 50% clipped)
      const visibleWidth = Math.min(rect.right, elementRect.right) - Math.max(rect.left, elementRect.left);
      const visibleHeight = Math.min(rect.bottom, elementRect.bottom) - Math.max(rect.top, elementRect.top);

      if (visibleWidth < rect.width * 0.5 || visibleHeight < rect.height * 0.5) {
        return false;
      }
    }

    element = element.parentElement;
  }

  // Note: We intentionally do NOT check if rect is in the current viewport
  // because we capture full-page screenshots. Elements below the fold are valid.

  // Check horizontal bounds only (element should be within document width)
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  if (rect.right <= 0 || rect.left >= viewportWidth) {
    return false;
  }

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  // Check if element is within the visible viewport (for elementFromPoint check)
  const isInViewport = rect.top < viewportHeight && rect.bottom > 0 &&
                       rect.left < viewportWidth && rect.right > 0;

  // If element is completely outside viewport, trust it (for full-page screenshots)
  if (!isInViewport) {
    return true;
  }

  // For elements in viewport, check center and corners with elementFromPoint
  // to ensure they're not obscured by other elements (like modals)
  const offset = 2;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // Clamp points to viewport bounds for elementFromPoint
  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

  const pointsToCheck = [
    { x: clamp(centerX, 0, viewportWidth - 1), y: clamp(centerY, 0, viewportHeight - 1) }, // Center
    { x: clamp(rect.left + offset, 0, viewportWidth - 1), y: clamp(rect.top + offset, 0, viewportHeight - 1) },
    { x: clamp(rect.right - offset, 0, viewportWidth - 1), y: clamp(rect.bottom - offset, 0, viewportHeight - 1) }
  ];

  try {
    for (const point of pointsToCheck) {
      const elementAtPoint = document.elementFromPoint(point.x, point.y);
      if (!elementAtPoint) {
        continue; // Point might be outside document
      }

      // Check if the element at this point is related to our parent
      const isRelated = elementAtPoint === parentElement ||
                        parentElement.contains(elementAtPoint) ||
                        elementAtPoint.contains(parentElement);

      if (isRelated) {
        return true; // At least one point is visible
      }
    }

    // None of the points were related to our element - it's obscured
    return false;
  } catch {
    return false;
  }
}

function extractTextAndMetadata(): ExtractionResult {
  const textElements: TextElement[] = [];
  const START_MARKER_REGEX = /(?<![''<])\u200B([\uFE00-\uFE0F]+)/g;
  const END_MARKER = '\u200C';

  if (!document.body) {
    console.error('[Extractor] Document body not found');
    return { error: 'Document body not found.' };
  }

  const treeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);

  let activeSegment: ActiveSegment | null = null;
  let node: Node | null;
  let nodesWithMarkers = 0;
  let matchCount = 0;

  while ((node = treeWalker.nextNode())) {
    const parentElement = (node as Text).parentElement;

    if (parentElement) {
      const styles = window.getComputedStyle(parentElement);
      if (styles.display === 'none' || styles.visibility === 'hidden' || parseFloat(styles.opacity) === 0) {
        continue;
      }
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'HEAD'].includes(parentElement.tagName)) {
        continue;
      }
    } else {
      continue;
    }

    let searchPos = 0;
    const text = node.nodeValue || '';

    // Track if this text node contains any Invisicode markers
    if (text.includes('\u200B') || text.includes('\u200C') || /[\uFE00-\uFE0F]/.test(text)) {
      nodesWithMarkers++;
    }

    while (searchPos < text.length) {
      if (activeSegment) {
        const endMarkerPos = text.indexOf(END_MARKER, searchPos);

        if (endMarkerPos !== -1) {
          activeSegment.text += text.substring(searchPos, endMarkerPos);

          const range = document.createRange();
          range.setStart(activeSegment.startNode, activeSegment.startOffset);
          range.setEnd(node, endMarkerPos);

          const rect = range.getBoundingClientRect();
          let parsedMetadata: any = {};
          try {
            const decodedJsonMetadata = fe00RangeToUtf8Browser(activeSegment.encodedMetadata);
            if (decodedJsonMetadata && decodedJsonMetadata.trim() !== '') {
              parsedMetadata = JSON.parse(decodedJsonMetadata);
            }
          } catch (e) {
            const error = e as Error;
            parsedMetadata.decodingError = error.message;
          }

          // Check if the segment is actually visible
          const visible = isRectVisible(rect, parentElement);

          // Always include the segment, but only add coordinates if visible
          if (visible) {
            textElements.push({
              text: activeSegment.text,
              x: rect.left + window.scrollX,
              y: rect.top + window.scrollY,
              width: rect.width,
              height: rect.height,
              ...parsedMetadata
            });
          } else {
            textElements.push({
              text: activeSegment.text,
              x: 0,
              y: 0,
              width: 0,
              height: 0,
              ...parsedMetadata
            });
          }

          searchPos = endMarkerPos + 1;
          activeSegment = null;
        } else {
          activeSegment.text += text.substring(searchPos);
          break;
        }
      } else {
        START_MARKER_REGEX.lastIndex = searchPos;
        const match = START_MARKER_REGEX.exec(text);

        if (match) {
          matchCount++;
          const textAfterStart = text.substring(match.index + match[0].length);
          const endMarkerPosInSubstring = textAfterStart.indexOf(END_MARKER);

          if (endMarkerPosInSubstring !== -1) {
            const capturedText = textAfterStart.substring(0, endMarkerPosInSubstring);

            const range = document.createRange();
            range.setStart(node, match.index);
            const endOffset = match.index + match[0].length + endMarkerPosInSubstring;
            range.setEnd(node, endOffset);

            const rect = range.getBoundingClientRect();
            let parsedMetadata: any = {};
            try {
              const decodedJsonMetadata = fe00RangeToUtf8Browser(match[1]);
              if (decodedJsonMetadata && decodedJsonMetadata.trim() !== '') {
                parsedMetadata = JSON.parse(decodedJsonMetadata);
              }
            } catch (e) {
              const error = e as Error;
              parsedMetadata.decodingError = error.message;
            }

            // Check if the segment is actually visible
            const visible = isRectVisible(rect, parentElement);

            // Always include the segment, but only add coordinates if visible
            if (visible) {
              textElements.push({
                text: capturedText,
                x: rect.left + window.scrollX,
                y: rect.top + window.scrollY,
                width: rect.width,
                height: rect.height,
                ...parsedMetadata
              });
            } else {
              textElements.push({
                text: capturedText,
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                ...parsedMetadata
              });
            }
            searchPos = endOffset + 1;
          } else {
            activeSegment = {
              startNode: node,
              startOffset: match.index,
              encodedMetadata: match[1],
              text: textAfterStart
            };
            break;
          }
        } else {
          break;
        }
      }
    }
  }

  // Only log when no segments found (for debugging)
  if (textElements.length === 0) {
    const bodyText = document.body.innerText;
    const bodyHtml = document.body.innerHTML;
    const debugInfo = {
      nodesWithMarkers,
      regexMatches: matchCount,
      markersInInnerText: {
        ZWS: bodyText.includes('\u200B'),
        ZWNJ: bodyText.includes('\u200C'),
        FE00: /[\uFE00-\uFE0F]/.test(bodyText)
      },
      markersInHTML: {
        ZWS: bodyHtml.includes('\u200B'),
        ZWNJ: bodyHtml.includes('\u200C'),
        FE00: /[\uFE00-\uFE0F]/.test(bodyHtml)
      }
    };
    console.info('[Extractor] No segments found:', JSON.stringify(debugInfo, null, 2));
  }

  return { textElements };
}

// Expose extraction function globally for use by other content scripts
if (typeof window !== 'undefined') {
  (window as any).LQABOSS_extractTextAndMetadata = extractTextAndMetadata;
}

// Listen for messages from background script
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract-metadata') {
      const result = extractTextAndMetadata();
      sendResponse(result);
      return true;
    }
  });
}

export { fe00RangeToUtf8Browser, isRectVisible, extractTextAndMetadata };
export type { TextElement, ExtractionResult };
