import { StructuralEngine } from '@cntxt-labs/anvesa-structural';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import type { Embedder } from './embedder.ts';

/** Test-only helpers. Not exported from the package. */

const runtimes: SyntaxRuntime[] = [];

export function makeEngine(): StructuralEngine {
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  runtimes.push(runtime);
  return new StructuralEngine({ runtime });
}

export async function disposeEngines(): Promise<void> {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
}

const TOKEN = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/** Tokens the way a small wordpiece model might count them: words and punctuation marks. */
export function countTokens(text: string): number {
  return (text.match(TOKEN) ?? []).length;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface WordEmbedderOptions {
  readonly id?: string;
  readonly dimensions?: number;
  readonly maxTokens?: number;
  readonly preferredBatchSize?: number;
  /** Called with each batch, so tests can see how work was divided. */
  readonly onBatch?: (batch: readonly string[]) => void;
}

/**
 * A bag-of-words embedder: each lowercase word hashes to a dimension. Texts sharing words get
 * similar vectors, which is enough to test retrieval end to end without a model. It is a test
 * double, not a semantic model, and is deliberately not exported from the package.
 */
export function wordEmbedder(options: WordEmbedderOptions = {}): Embedder {
  const dimensions = options.dimensions ?? 128;
  return {
    info: {
      id: options.id ?? 'test-words',
      dimensions,
      maxTokens: options.maxTokens ?? 256,
      ...(options.preferredBatchSize === undefined
        ? {}
        : { preferredBatchSize: options.preferredBatchSize }),
    },
    count: countTokens,
    async embed(texts) {
      options.onBatch?.(texts);
      return texts.map((text) => {
        const vector = new Float32Array(dimensions);
        for (const word of text.toLowerCase().match(WORD) ?? []) {
          vector[fnv1a(word) % dimensions] = (vector[fnv1a(word) % dimensions] as number) + 1;
        }
        if (vector.every((value) => value === 0)) vector[0] = 1;
        return vector;
      });
    },
  };
}

/** A repeatable pseudo-random source for property-style tests. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
