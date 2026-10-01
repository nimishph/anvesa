import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { loadRustDense, type ScoredIndex } from './rust-bridge.js';

/** A copy of `vector` scaled to unit length. A zero vector cannot be normalised and is refused. */
export function normalize(vector: Float32Array): Float32Array {
  const native = loadRustDense();
  if (native) {
    try {
      return native.normalizeSimd(vector);
    } catch (failure) {
      void failure;
      throw new InvalidArgumentError(
        'vector',
        'a finite, non-zero vector',
        'non-finite or zero length',
      );
    }
  }

  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new InvalidArgumentError('vector', 'a finite, non-zero vector', `length ${length}`);
  }
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1)
    out[index] = (vector[index] as number) / length;
  return out;
}

/** Dot product. Equal to cosine similarity when both vectors are unit length. */
export function dot(a: Float32Array, b: Float32Array): number {
  const native = loadRustDense();
  if (native) {
    return native.dotProductSimd(a, b);
  }

  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] as number) * (b[index] as number);
  }
  return sum;
}

/**
 * Scans a contiguous byte buffer of 32-bit float vectors against a unit query vector,
 * returning the top `limit` results (index and cosine score) sorted descending by score.
 *
 * When the native NAPI module is available, executes via AVX2/NEON SIMD math and in-memory min-heap.
 * When running in pure TypeScript mode (e.g. core compiled to TS), executes via a high-speed
 * typed-array min-heap directly on the buffer's Float32Array view with zero per-vector allocations.
 */
export function batchScanTopK(
  query: Float32Array,
  vectorsBuffer: Uint8Array,
  dims: number,
  limit: number,
): ScoredIndex[] {
  const native = loadRustDense();
  if (native) {
    return native.batchScanTopK(query, vectorsBuffer, dims, limit);
  }

  // Pure TypeScript core fallback
  const numVectors = Math.floor(vectorsBuffer.byteLength / (dims * 4));
  if (numVectors === 0 || limit <= 0) return [];

  const floatView = new Float32Array(
    vectorsBuffer.buffer,
    vectorsBuffer.byteOffset,
    numVectors * dims,
  );

  const k = Math.min(limit, numVectors);
  // Bounded typed-array min-heap for top-k selection
  const heapIndices = new Int32Array(k);
  const heapScores = new Float32Array(k);
  let heapSize = 0;

  function siftUp(from: number): void {
    let i = from;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const scoreI = heapScores[i] ?? 0;
      const scoreP = heapScores[parent] ?? 0;
      if (scoreI >= scoreP) break;
      // Swap
      const tmpIdx = heapIndices[i] ?? 0;
      heapIndices[i] = heapIndices[parent] ?? 0;
      heapIndices[parent] = tmpIdx;
      heapScores[i] = scoreP;
      heapScores[parent] = scoreI;
      i = parent;
    }
  }

  function siftDown(from: number): void {
    let i = from;
    while (true) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      const scoreSmallest = heapScores[smallest] ?? 0;
      if (left < heapSize && (heapScores[left] ?? 0) < scoreSmallest) {
        smallest = left;
      }
      if (right < heapSize && (heapScores[right] ?? 0) < (heapScores[smallest] ?? 0)) {
        smallest = right;
      }
      if (smallest === i) break;

      const tmpIdx = heapIndices[i] ?? 0;
      const tmpScore = heapScores[i] ?? 0;
      heapIndices[i] = heapIndices[smallest] ?? 0;
      heapScores[i] = heapScores[smallest] ?? 0;
      heapIndices[smallest] = tmpIdx;
      heapScores[smallest] = tmpScore;
      i = smallest;
    }
  }

  for (let i = 0; i < numVectors; i++) {
    const offset = i * dims;
    let score = 0;
    for (let d = 0; d < dims; d++) {
      score += (query[d] ?? 0) * (floatView[offset + d] ?? 0);
    }

    if (heapSize < k) {
      heapIndices[heapSize] = i;
      heapScores[heapSize] = score;
      siftUp(heapSize);
      heapSize++;
    } else if (score > (heapScores[0] ?? -Infinity)) {
      heapIndices[0] = i;
      heapScores[0] = score;
      siftDown(0);
    }
  }

  // Extract and sort descending
  const results: ScoredIndex[] = [];
  for (let i = 0; i < heapSize; i++) {
    results.push({
      index: heapIndices[i] ?? 0,
      score: heapScores[i] ?? 0,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Computes dot products for a query vector across a contiguous buffer of vectors.
 */
export function batchDotProduct(
  query: Float32Array,
  vectorsBuffer: Uint8Array,
  dims: number,
): Float32Array {
  const native = loadRustDense();
  if (native) {
    return native.batchDotProduct(query, vectorsBuffer, dims);
  }

  // Pure TypeScript core fallback
  const numVectors = Math.floor(vectorsBuffer.byteLength / (dims * 4));
  const floatView = new Float32Array(
    vectorsBuffer.buffer,
    vectorsBuffer.byteOffset,
    numVectors * dims,
  );
  const results = new Float32Array(numVectors);

  for (let i = 0; i < numVectors; i++) {
    const offset = i * dims;
    let sum = 0;
    for (let d = 0; d < dims; d++) {
      sum += (query[d] ?? 0) * (floatView[offset + d] ?? 0);
    }
    results[i] = sum;
  }

  return results;
}

export function isUsableVector(vector: Float32Array): boolean {
  for (const value of vector) if (!Number.isFinite(value)) return false;
  return vector.length > 0;
}
