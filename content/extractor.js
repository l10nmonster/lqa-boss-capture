/* eslint-disable complexity */
/**
 * Text and metadata extraction content script
 * Ported from flowCapture.js:extractTextAndMetadataInPageContext
 */

// Import fe00 decoder (included via manifest)
// Note: This will be loaded via chrome.scripting.executeScript

function fe00RangeToUtf8_browser(encoded) {
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
 * @param {DOMRect} rect - The bounding rectangle to check
 * @param {Element} parentElement - The parent element of the text node
 * @returns {boolean} - True if the element is visible
 */
function isRectVisible(rect, parentElement) {
  // Check if rect has valid dimensions
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  // Check if element is clipped by any parent with overflow
  let element = parentElement;
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

  // Check if rect is in viewport
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  if (rect.right <= 0 || rect.left >= viewportWidth ||
      rect.bottom <= 0 || rect.top >= viewportHeight) {
    return false;
  }

  // Check all 4 corners with elementFromPoint to ensure fully visible
  const offset = 2;
  const corners = [
    { x: rect.left + offset, y: rect.top + offset },           // Top-left
    { x: rect.right - offset, y: rect.top + offset },          // Top-right
    { x: rect.left + offset, y: rect.bottom - offset },        // Bottom-left
    { x: rect.right - offset, y: rect.bottom - offset }        // Bottom-right
  ];

  try {
    // All 4 corners must be visible and not obscured
    for (const corner of corners) {
      // Check if corner is in viewport
      if (corner.x < 0 || corner.x >= viewportWidth ||
          corner.y < 0 || corner.y >= viewportHeight) {
        return false;
      }

      const elementAtPoint = document.elementFromPoint(corner.x, corner.y);
      if (!elementAtPoint) {
        return false;
      }

      // Check if the element at this corner is related to our parent
      const isRelated = elementAtPoint === parentElement ||
                        parentElement.contains(elementAtPoint) ||
                        elementAtPoint.contains(parentElement);

      if (!isRelated) {
        return false;
      }
    }

    return true;
  } catch (e) {
    return false;
  }
}

function extractTextAndMetadata() {
  const textElements = [];
  const START_MARKER_REGEX = /(?<![''<])\u200B([\uFE00-\uFE0F]+)/g;
  const END_MARKER = '\u200C';

  if (!document.body) {
    return { error: 'Document body not found.' };
  }

  const treeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);

  let activeSegment = null;
  let node;

  while (node = treeWalker.nextNode()) {
    const parentElement = node.parentElement;

    if (parentElement) {
      const styles = window.getComputedStyle(parentElement);
      if (styles.display === 'none' || styles.visibility === 'hidden' || parseFloat(styles.opacity) === 0) continue;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'HEAD'].includes(parentElement.tagName)) continue;
    } else {
      continue;
    }

    let searchPos = 0;
    const text = node.nodeValue;

    while (searchPos < text.length) {
      if (activeSegment) {
        const endMarkerPos = text.indexOf(END_MARKER, searchPos);

        if (endMarkerPos !== -1) {
          activeSegment.text += text.substring(searchPos, endMarkerPos);

          const range = document.createRange();
          range.setStart(activeSegment.startNode, activeSegment.startOffset);
          range.setEnd(node, endMarkerPos);

          const rect = range.getBoundingClientRect();
          let parsedMetadata = {};
          try {
            const decodedJsonMetadata = fe00RangeToUtf8_browser(activeSegment.encodedMetadata);
            if (decodedJsonMetadata && decodedJsonMetadata.trim() !== '') {
              parsedMetadata = JSON.parse(decodedJsonMetadata);
            }
          } catch (e) {
            parsedMetadata.decodingError = e.message;
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
          const textAfterStart = text.substring(match.index + match[0].length);
          const endMarkerPosInSubstring = textAfterStart.indexOf(END_MARKER);

          if (endMarkerPosInSubstring !== -1) {
            const capturedText = textAfterStart.substring(0, endMarkerPosInSubstring);

            const range = document.createRange();
            range.setStart(node, match.index);
            const endOffset = match.index + match[0].length + endMarkerPosInSubstring;
            range.setEnd(node, endOffset);

            const rect = range.getBoundingClientRect();
            let parsedMetadata = {};
            try {
              const decodedJsonMetadata = fe00RangeToUtf8_browser(match[1]);
              if (decodedJsonMetadata && decodedJsonMetadata.trim() !== '') {
                parsedMetadata = JSON.parse(decodedJsonMetadata);
              }
            } catch (e) {
              parsedMetadata.decodingError = e.message;
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

  return { textElements };
}

// Expose extraction function globally for use by other content scripts
if (typeof window !== 'undefined') {
  window.LQABOSS_extractTextAndMetadata = extractTextAndMetadata;
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

// Export for testing (Node environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fe00RangeToUtf8_browser, isRectVisible, extractTextAndMetadata };
}
