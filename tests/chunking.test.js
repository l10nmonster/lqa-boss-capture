/**
 * Tests for chunking utilities used in large flow transfer
 */

const {
  MAX_CHUNK_SIZE,
  needsChunkedTransfer,
  calculateChunkCount,
  getChunkRange,
  isLastChunk,
  getChunkSize
} = require('../test-dist/lib/chunking.js');

describe('Chunking Utilities', () => {
  describe('MAX_CHUNK_SIZE', () => {
    test('should be 32MB', () => {
      expect(MAX_CHUNK_SIZE).toBe(32 * 1024 * 1024);
    });
  });

  describe('needsChunkedTransfer', () => {
    test('should return false for small flows', () => {
      expect(needsChunkedTransfer(1024)).toBe(false);
      expect(needsChunkedTransfer(10 * 1024 * 1024)).toBe(false);
      expect(needsChunkedTransfer(MAX_CHUNK_SIZE)).toBe(false);
    });

    test('should return true for large flows', () => {
      expect(needsChunkedTransfer(MAX_CHUNK_SIZE + 1)).toBe(true);
      expect(needsChunkedTransfer(50 * 1024 * 1024)).toBe(true);
      expect(needsChunkedTransfer(100 * 1024 * 1024)).toBe(true);
    });

    test('should handle edge cases', () => {
      expect(needsChunkedTransfer(0)).toBe(false);
    });
  });

  describe('calculateChunkCount', () => {
    test('should return 0 for empty data', () => {
      expect(calculateChunkCount(0)).toBe(0);
      expect(calculateChunkCount(-1)).toBe(0);
    });

    test('should return 1 for small flows', () => {
      expect(calculateChunkCount(1)).toBe(1);
      expect(calculateChunkCount(1024)).toBe(1);
      expect(calculateChunkCount(MAX_CHUNK_SIZE)).toBe(1);
    });

    test('should calculate correct chunk count for large flows', () => {
      expect(calculateChunkCount(MAX_CHUNK_SIZE + 1)).toBe(2);
      expect(calculateChunkCount(MAX_CHUNK_SIZE * 2)).toBe(2);
      expect(calculateChunkCount(MAX_CHUNK_SIZE * 2 + 1)).toBe(3);
      expect(calculateChunkCount(MAX_CHUNK_SIZE * 3)).toBe(3);
    });

    test('should handle real-world sizes', () => {
      // 67.8MB flow (from the bug report)
      const flowSize = 67.8 * 1024 * 1024;
      expect(calculateChunkCount(flowSize)).toBe(3);

      // 100MB flow
      expect(calculateChunkCount(100 * 1024 * 1024)).toBe(4);
    });
  });

  describe('getChunkRange', () => {
    test('should return correct range for first chunk', () => {
      const totalSize = 100 * 1024 * 1024;
      const { start, end } = getChunkRange(0, totalSize);
      expect(start).toBe(0);
      expect(end).toBe(MAX_CHUNK_SIZE);
    });

    test('should return correct range for middle chunks', () => {
      const totalSize = 100 * 1024 * 1024;
      const { start, end } = getChunkRange(1, totalSize);
      expect(start).toBe(MAX_CHUNK_SIZE);
      expect(end).toBe(MAX_CHUNK_SIZE * 2);
    });

    test('should clamp end to total size for last chunk', () => {
      const totalSize = MAX_CHUNK_SIZE + 1000;
      const { start, end } = getChunkRange(1, totalSize);
      expect(start).toBe(MAX_CHUNK_SIZE);
      expect(end).toBe(totalSize);
    });

    test('should handle single-chunk flows', () => {
      const totalSize = 1000;
      const { start, end } = getChunkRange(0, totalSize);
      expect(start).toBe(0);
      expect(end).toBe(1000);
    });
  });

  describe('isLastChunk', () => {
    test('should return true for single-chunk flows', () => {
      expect(isLastChunk(0, 1000)).toBe(true);
      expect(isLastChunk(0, MAX_CHUNK_SIZE)).toBe(true);
    });

    test('should return false for non-last chunks', () => {
      const totalSize = MAX_CHUNK_SIZE * 3;
      expect(isLastChunk(0, totalSize)).toBe(false);
      expect(isLastChunk(1, totalSize)).toBe(false);
    });

    test('should return true for last chunk of multi-chunk flow', () => {
      const totalSize = MAX_CHUNK_SIZE * 3;
      expect(isLastChunk(2, totalSize)).toBe(true);
    });

    test('should handle partial last chunk', () => {
      const totalSize = MAX_CHUNK_SIZE * 2 + 1000;
      expect(isLastChunk(0, totalSize)).toBe(false);
      expect(isLastChunk(1, totalSize)).toBe(false);
      expect(isLastChunk(2, totalSize)).toBe(true);
    });
  });

  describe('getChunkSize', () => {
    test('should return full chunk size for non-last chunks', () => {
      const totalSize = 100 * 1024 * 1024;
      expect(getChunkSize(0, totalSize)).toBe(MAX_CHUNK_SIZE);
      expect(getChunkSize(1, totalSize)).toBe(MAX_CHUNK_SIZE);
    });

    test('should return remaining bytes for last chunk', () => {
      const remainder = 1000;
      const totalSize = MAX_CHUNK_SIZE * 2 + remainder;
      expect(getChunkSize(2, totalSize)).toBe(remainder);
    });

    test('should return total size for small flows', () => {
      expect(getChunkSize(0, 1000)).toBe(1000);
    });
  });

  describe('base64 overhead calculation', () => {
    test('32MB binary should encode to ~43MB base64 (under 64MB limit)', () => {
      // Base64 encoding adds ~33% overhead (4 bytes output per 3 bytes input)
      const binarySize = MAX_CHUNK_SIZE;
      const base64Size = Math.ceil(binarySize * 4 / 3);
      const base64SizeMB = base64Size / (1024 * 1024);

      expect(base64SizeMB).toBeLessThan(64);
      expect(base64SizeMB).toBeCloseTo(42.67, 1);
    });
  });
});
