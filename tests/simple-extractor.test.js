/**
 * Simple tests for extractor that will measure coverage
 */

// Mock TextDecoder for Node environment
global.TextDecoder = class TextDecoder {
  decode(bytes) {
    return Buffer.from(bytes).toString('utf8');
  }
};

// Mock DOM APIs
global.document = {
  body: { tagName: 'BODY' },
  createRange: jest.fn(() => ({
    setStart: jest.fn(),
    setEnd: jest.fn(),
    getBoundingClientRect: jest.fn(() => ({
      left: 10,
      top: 10,
      right: 110,
      bottom: 60,
      width: 100,
      height: 50
    }))
  })),
  createTreeWalker: jest.fn(() => ({
    nextNode: jest.fn(() => null)
  })),
  elementFromPoint: jest.fn()
};

global.window = {
  innerWidth: 1024,
  innerHeight: 768,
  scrollX: 0,
  scrollY: 0,
  getComputedStyle: jest.fn(() => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    overflow: 'visible',
    overflowX: 'visible',
    overflowY: 'visible'
  }))
};

global.NodeFilter = {
  SHOW_TEXT: 4
};

// Import the module for coverage tracking
const { fe00RangeToUtf8_browser, isRectVisible } = require('../content/extractor.js');

describe('Extractor Module Coverage', () => {
  describe('fe00RangeToUtf8_browser', () => {
    test('should decode simple text', () => {
      const encoded = '\uFE04\uFE08\uFE06\uFE09'; // "Hi"
      const result = fe00RangeToUtf8_browser(encoded);
      expect(result).toBe('Hi');
    });

    test('should throw on odd length', () => {
      expect(() => fe00RangeToUtf8_browser('\uFE00\uFE01\uFE02')).toThrow();
    });

    test('should throw on invalid char codes', () => {
      expect(() => fe00RangeToUtf8_browser('\u0000\uFE01')).toThrow();
    });

    test('should handle empty string', () => {
      expect(fe00RangeToUtf8_browser('')).toBe('');
    });
  });

  describe('isRectVisible', () => {
    test('should return false for zero width rect', () => {
      const rect = { left: 10, top: 10, right: 10, bottom: 60, width: 0, height: 50 };
      const parent = { tagName: 'DIV', parentElement: null };
      expect(isRectVisible(rect, parent)).toBe(false);
    });

    test('should return false for zero height rect', () => {
      const rect = { left: 10, top: 10, right: 110, bottom: 10, width: 100, height: 0 };
      const parent = { tagName: 'DIV', parentElement: null };
      expect(isRectVisible(rect, parent)).toBe(false);
    });

    test('should return false for negative dimensions', () => {
      const rect = { left: 10, top: 10, right: 5, bottom: 60, width: -5, height: 50 };
      const parent = { tagName: 'DIV', parentElement: null };
      expect(isRectVisible(rect, parent)).toBe(false);
    });
  });
});
