/**
 * Decodes fe00-range encoded strings to UTF-8
 * Ported from flowCapture.js
 */
function fe00RangeToUtf8(encoded) {
  const encodingOffset = 0xfe00;
  const decoder = new TextDecoder();
  const length = encoded.length;

  if (length % 2 !== 0) {
    throw new Error('Invalid fe00 encoded input length');
  }

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

// Export for testing (Node environment)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fe00RangeToUtf8 };
}
