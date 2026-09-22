import { InvalidArgumentError } from '@cntxt-labs/code-lens-core';

/** A copy of `vector` scaled to unit length. A zero vector cannot be normalised and is refused. */
export function normalize(vector: Float32Array): Float32Array {
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
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] as number) * (b[index] as number);
  }
  return sum;
}

export function isUsableVector(vector: Float32Array): boolean {
  for (const value of vector) if (!Number.isFinite(value)) return false;
  return vector.length > 0;
}
