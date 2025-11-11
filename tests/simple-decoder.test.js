/**
 * Simple tests for FE00 decoder that will measure coverage
 */

// Mock TextDecoder for Node environment
global.TextDecoder = class TextDecoder {
  decode(bytes) {
    return Buffer.from(bytes).toString('utf8');
  }
};

// Import the actual module for coverage tracking
const { fe00RangeToUtf8 } = require('../lib/fe00-decoder.js');

describe('FE00 Decoder Module Coverage', () => {
  test('module should be loadable', () => {
    expect(fe00RangeToUtf8).toBeDefined();
    expect(typeof fe00RangeToUtf8).toBe('function');
  });

  test('should decode ASCII characters', () => {
    const encoded = '\uFE04\uFE08\uFE06\uFE09'; // "Hi"
    const result = fe00RangeToUtf8(encoded);
    expect(result).toBe('Hi');
  });

  test('should throw on invalid input length', () => {
    expect(() => fe00RangeToUtf8('\uFE00\uFE01\uFE02')).toThrow();
  });

  test('should handle empty string', () => {
    expect(fe00RangeToUtf8('')).toBe('');
  });
});
