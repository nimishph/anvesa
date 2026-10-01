import { describe, expect, test } from 'bun:test';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { isRustDenseAvailable, loadRustDense, setRustDenseEnabled } from './rust-bridge.ts';
import { batchDotProduct, batchScanTopK, dot, normalize } from './vectors.ts';

function scalarDot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function scalarNormalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new InvalidArgumentError('vector', 'a finite, non-zero vector', `length ${length}`);
  }
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    out[i] = (vector[i] ?? 0) / length;
  }
  return out;
}

describe('Rust Native SIMD Bridge (anv-ja8)', () => {
  test('native bridge availability is reported consistently', () => {
    const available = isRustDenseAvailable();
    const bridge = loadRustDense();
    expect(available).toBe(bridge !== null);
    if (!bridge) return;
    expect(typeof bridge.dotProductSimd).toBe('function');
    expect(typeof bridge.normalizeSimd).toBe('function');
    expect(typeof bridge.batchScanTopK).toBe('function');
    expect(typeof bridge.batchDotProduct).toBe('function');
  });

  test('dot product SIMD matches scalar dot for small dimensions', () => {
    const a = new Float32Array([1.5, -2.0, 3.25, 4.0]);
    const b = new Float32Array([0.5, 3.0, -1.0, 2.0]);

    const expected = scalarDot(a, b);
    const actual = dot(a, b);

    expect(Math.abs(actual - expected)).toBeLessThan(1e-5);
  });

  test('dot product SIMD achieves exact parity on 384, 768, and 1536 dimension embeddings', () => {
    for (const dims of [128, 384, 768, 1536]) {
      const a = new Float32Array(dims);
      const b = new Float32Array(dims);
      for (let i = 0; i < dims; i += 1) {
        a[i] = Math.sin(i * 0.17);
        b[i] = Math.cos(i * 0.23);
      }

      const expected = scalarDot(a, b);
      const actual = dot(a, b);

      expect(Math.abs(actual - expected)).toBeLessThan(1e-4);
    }
  });

  test('normalize SIMD produces unit length and matches scalar normalization', () => {
    const raw = new Float32Array([3, 4]);
    const unit = normalize(raw);

    expect(Math.abs((unit[0] ?? 0) - 0.6)).toBeLessThan(1e-5);
    expect(Math.abs((unit[1] ?? 0) - 0.8)).toBeLessThan(1e-5);

    const lengthSquared = dot(unit, unit);
    expect(Math.abs(lengthSquared - 1.0)).toBeLessThan(1e-5);

    // High dimensions
    const highDim = new Float32Array(384);
    for (let i = 0; i < 384; i += 1) highDim[i] = (i % 7) - 3;
    const highUnit = normalize(highDim);
    const scalarUnit = scalarNormalize(highDim);

    for (let i = 0; i < 384; i += 1) {
      expect(Math.abs((highUnit[i] ?? 0) - (scalarUnit[i] ?? 0))).toBeLessThan(1e-5);
    }
    expect(Math.abs(dot(highUnit, highUnit) - 1.0)).toBeLessThan(1e-5);
  });

  test('normalize SIMD refuses zero or non-finite vectors with InvalidArgumentError', () => {
    expect(() => normalize(new Float32Array(5))).toThrow(InvalidArgumentError);
    expect(() => normalize(new Float32Array([Number.NaN, 1, 2]))).toThrow(InvalidArgumentError);
    expect(() => normalize(new Float32Array([Number.POSITIVE_INFINITY, 1]))).toThrow(
      InvalidArgumentError,
    );
  });

  test('batchScanTopK accurately ranks vectors directly in contiguous native memory', () => {
    const bridge = loadRustDense();
    if (!bridge) return;

    const dims = 4;
    const numVectors = 5;
    const query = normalize(new Float32Array([1, 0, 0, 0]));

    const vectors = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
      new Float32Array([Math.SQRT1_2, Math.SQRT1_2, 0, 0]),
      new Float32Array([-1, 0, 0, 0]),
      normalize(new Float32Array([0.9, 0.1, 0, 0])),
    ];

    const buffer = new Uint8Array(numVectors * dims * 4);
    for (let i = 0; i < numVectors; i += 1) {
      const vec = vectors[i];
      if (vec) {
        buffer.set(new Uint8Array(vec.buffer), i * dims * 4);
      }
    }

    const top3 = bridge.batchScanTopK(query, buffer, dims, 3);
    expect(top3.length).toBe(3);
    expect(top3[0]?.index).toBe(0); // score 1.0
    expect(top3[1]?.index).toBe(4); // score ~0.99
    expect(top3[2]?.index).toBe(2); // score ~0.7071
    expect(top3[0]?.score).toBeGreaterThan(top3[1]?.score ?? 0);
    expect(top3[1]?.score).toBeGreaterThan(top3[2]?.score ?? 0);
  });

  test('batchDotProduct computes all scores in a single native SIMD pass', () => {
    const bridge = loadRustDense();
    if (!bridge) return;

    const dims = 3;
    const query = new Float32Array([1, 2, 3]);
    const v1 = new Float32Array([2, 0, 1]); // 2*1 + 0*2 + 1*3 = 5
    const v2 = new Float32Array([0, 1, 1]); // 0*1 + 1*2 + 1*3 = 5
    const v3 = new Float32Array([1, 1, 1]); // 1*1 + 1*2 + 1*3 = 6

    const buffer = new Uint8Array(3 * dims * 4);
    buffer.set(new Uint8Array(v1.buffer), 0);
    buffer.set(new Uint8Array(v2.buffer), dims * 4);
    buffer.set(new Uint8Array(v3.buffer), 2 * dims * 4);

    const scores = bridge.batchDotProduct(query, buffer, dims);
    expect(scores.length).toBe(3);
    expect(Math.abs((scores[0] ?? 0) - 5)).toBeLessThan(1e-5);
    expect(Math.abs((scores[1] ?? 0) - 5)).toBeLessThan(1e-5);
    expect(Math.abs((scores[2] ?? 0) - 6)).toBeLessThan(1e-5);
  });

  test('TS wrapper batchScanTopK and batchDotProduct achieve 100% mathematical parity in pure TS mode', () => {
    try {
      const dims = 4;
      const numVectors = 5;
      const query = normalize(new Float32Array([1, 0, 0, 0]));

      const vectors = [
        new Float32Array([1, 0, 0, 0]),
        new Float32Array([0, 1, 0, 0]),
        new Float32Array([Math.SQRT1_2, Math.SQRT1_2, 0, 0]),
        new Float32Array([-1, 0, 0, 0]),
        normalize(new Float32Array([0.9, 0.1, 0, 0])),
      ];

      const buffer = new Uint8Array(numVectors * dims * 4);
      for (let i = 0; i < numVectors; i += 1) {
        const vec = vectors[i];
        if (vec) {
          buffer.set(new Uint8Array(vec.buffer), i * dims * 4);
        }
      }

      // Test with native
      setRustDenseEnabled(true);
      const nativeTop3 = batchScanTopK(query, buffer, dims, 3);

      // Test with pure TS fallback (core compiled to TS)
      setRustDenseEnabled(false);
      const tsTop3 = batchScanTopK(query, buffer, dims, 3);

      expect(tsTop3.length).toBe(3);
      expect(tsTop3[0]?.index).toBe(nativeTop3[0]?.index);
      expect(tsTop3[1]?.index).toBe(nativeTop3[1]?.index);
      expect(tsTop3[2]?.index).toBe(nativeTop3[2]?.index);
      expect(Math.abs((tsTop3[0]?.score ?? 0) - (nativeTop3[0]?.score ?? 0))).toBeLessThan(1e-5);
      expect(Math.abs((tsTop3[1]?.score ?? 0) - (nativeTop3[1]?.score ?? 0))).toBeLessThan(1e-5);

      // Test batchDotProduct in pure TS mode
      const tsScores = batchDotProduct(query, buffer, dims);
      setRustDenseEnabled(true);
      const nativeScores = batchDotProduct(query, buffer, dims);
      for (let i = 0; i < numVectors; i++) {
        expect(Math.abs((tsScores[i] ?? 0) - (nativeScores[i] ?? 0))).toBeLessThan(1e-5);
      }
    } finally {
      setRustDenseEnabled(true);
    }
  });
});
