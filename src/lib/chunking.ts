/**
 * Chunking Utilities for Large Flow Transfer
 *
 * Chrome extension message passing has a 64MB limit. Base64 encoding adds ~33% overhead,
 * so we use 32MB binary chunks which become ~43MB when base64 encoded.
 */

// Maximum chunk size for message passing (binary bytes)
// 32MB binary → ~43MB base64 (safely under 64MB limit)
export const MAX_CHUNK_SIZE = 32 * 1024 * 1024;

/**
 * Determine if a flow needs chunked transfer
 */
export function needsChunkedTransfer(totalBytes: number): boolean {
  return totalBytes > MAX_CHUNK_SIZE;
}

/**
 * Calculate the number of chunks needed for a given byte size
 */
export function calculateChunkCount(totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.ceil(totalBytes / MAX_CHUNK_SIZE);
}

/**
 * Calculate the byte range for a specific chunk
 */
export function getChunkRange(chunkIndex: number, totalBytes: number): { start: number; end: number } {
  const start = chunkIndex * MAX_CHUNK_SIZE;
  const end = Math.min(start + MAX_CHUNK_SIZE, totalBytes);
  return { start, end };
}

/**
 * Check if a chunk is the last one
 */
export function isLastChunk(chunkIndex: number, totalBytes: number): boolean {
  const { end } = getChunkRange(chunkIndex, totalBytes);
  return end >= totalBytes;
}

/**
 * Get chunk size for a specific chunk
 */
export function getChunkSize(chunkIndex: number, totalBytes: number): number {
  const { start, end } = getChunkRange(chunkIndex, totalBytes);
  return end - start;
}
