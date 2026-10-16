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

/** The mean of a set of vectors, component by component. */
export function computeCentroid(
  vectors: readonly Float32Array[],
  dimensions?: number,
): Float32Array {
  if (vectors.length === 0) {
    throw new InvalidArgumentError(
      'vectors',
      'at least one vector to compute centroid',
      '0 vectors',
    );
  }
  const dims = dimensions ?? vectors[0]?.length ?? 0;
  if (dims <= 0) {
    throw new InvalidArgumentError('dimensions', 'a positive integer', String(dims));
  }

  const centroid = new Float32Array(dims);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) {
      centroid[i] = (centroid[i] ?? 0) + (v[i] ?? 0);
    }
  }

  const invN = 1 / vectors.length;
  for (let i = 0; i < dims; i++) {
    centroid[i] = (centroid[i] ?? 0) * invN;
  }

  return centroid;
}

/**
 * A vector with the corpus centroid subtracted, back at unit length. Sentence encoders put most
 * vectors in a narrow cone; removing the shared direction spreads them out. Whether that ranks
 * the right card higher is a separate question, which `eval:real` measures: a query must be
 * calibrated against the same centroid as the cards it is compared with. A vector that equals the
 * centroid has no direction left and is only normalised.
 */
export function calibrateCentroid(vector: Float32Array, centroid: Float32Array): Float32Array {
  const dims = vector.length;
  const centered = new Float32Array(dims);
  let sumSq = 0;

  for (let i = 0; i < dims; i++) {
    const diff = (vector[i] ?? 0) - (centroid[i] ?? 0);
    centered[i] = diff;
    sumSq += diff * diff;
  }

  const norm = Math.sqrt(sumSq);
  if (norm > 1e-12 && Number.isFinite(norm)) {
    const invNorm = 1 / norm;
    for (let i = 0; i < dims; i++) {
      centered[i] = (centered[i] ?? 0) * invNorm;
    }
    return centered;
  }

  return normalize(vector);
}

/** `calibrateCentroid` over many vectors. */
export function calibrateBatchCentroid(
  vectors: readonly Float32Array[],
  centroid: Float32Array,
): Float32Array[] {
  return vectors.map((v) => calibrateCentroid(v, centroid));
}

export interface AnisotropyMetrics {
  readonly count: number;
  readonly meanCosine: number;
  readonly stdCosine: number;
  readonly minCosine: number;
  readonly maxCosine: number;
  readonly centroidNorm: number;
}

/**
 * How spread out a set of unit vectors is: the cosine between pairs (over an even sample of at most
 * `sampleLimit` vectors) and the length of the centroid. A mean cosine near 0 means the vectors are
 * spread evenly; near 1, that they share one direction. It describes the space, not search quality.
 */
export function measureAnisotropy(
  vectors: readonly Float32Array[],
  sampleLimit = 200,
): AnisotropyMetrics {
  if (vectors.length < 2) {
    return {
      count: vectors.length,
      meanCosine: 1,
      stdCosine: 0,
      minCosine: 1,
      maxCosine: 1,
      centroidNorm: 1,
    };
  }

  const centroid = computeCentroid(vectors);
  let centroidSq = 0;
  for (const val of centroid) centroidSq += val * val;
  const centroidNorm = Math.sqrt(centroidSq);

  const n = Math.min(vectors.length, sampleLimit);
  const step = Math.max(1, Math.floor(vectors.length / n));
  const samples: Float32Array[] = [];
  for (let i = 0; i < vectors.length && samples.length < n; i += step) {
    const v = vectors[i];
    if (v) samples.push(v);
  }

  let totalSim = 0;
  let totalSimSq = 0;
  let minSim = 1;
  let maxSim = -1;
  let pairs = 0;

  for (let i = 0; i < samples.length; i++) {
    const vi = samples[i];
    if (!vi) continue;
    for (let j = i + 1; j < samples.length; j++) {
      const vj = samples[j];
      if (!vj) continue;
      const sim = dot(vi, vj);
      totalSim += sim;
      totalSimSq += sim * sim;
      if (sim < minSim) minSim = sim;
      if (sim > maxSim) maxSim = sim;
      pairs++;
    }
  }

  if (pairs === 0) {
    return {
      count: vectors.length,
      meanCosine: 1,
      stdCosine: 0,
      minCosine: 1,
      maxCosine: 1,
      centroidNorm,
    };
  }

  const mean = totalSim / pairs;
  const variance = Math.max(0, totalSimSq / pairs - mean * mean);

  return {
    count: vectors.length,
    meanCosine: mean,
    stdCosine: Math.sqrt(variance),
    minCosine: minSim,
    maxCosine: maxSim,
    centroidNorm,
  };
}
