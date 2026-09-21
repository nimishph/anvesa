import { type Deadline, toCodeLensError } from '@sutras/code-lens-core';
import type { BudgetSource } from './budget.ts';
import { EmbedFailedError } from './errors.ts';
import { isUsableVector } from './vectors.ts';

export interface EmbedderInfo {
  /** Identifies the model, including anything that changes its vectors. Vectors are stored under it. */
  readonly id: string;
  readonly dimensions: number;
  /** The encoder's input window, in tokens. */
  readonly maxTokens: number;
  /** Tokens the encoder adds around the text itself. Defaults to 2. */
  readonly specialTokens?: number;
  /** How many texts it likes to receive at once. Absent means "all of them". */
  readonly preferredBatchSize?: number;
}

/**
 * Turns text into vectors. The framework needs nothing more than this, so any backend fits: a
 * local ONNX model, a hosted API, or a fake in a test.
 */
export interface Embedder {
  readonly info: EmbedderInfo;
  /** Tokens `text` occupies for this model. Must use the model's own tokenizer. */
  count(text: string): number;
  embed(
    texts: readonly string[],
    options?: { readonly deadline?: Deadline },
  ): Promise<readonly Float32Array[]>;
}

/** Make an `Embedder` a `BudgetSource` without repeating its window. */
export function budgetSourceOf(embedder: Embedder): BudgetSource {
  return {
    maxTokens: embedder.info.maxTokens,
    ...(embedder.info.specialTokens === undefined
      ? {}
      : { specialTokens: embedder.info.specialTokens }),
    count: (text) => embedder.count(text),
  };
}

/**
 * Embed many texts in the embedder's preferred batch size, and check what comes back: one finite
 * vector of the right size per text. A model that returns the wrong thing fails here, loudly,
 * rather than corrupting the index.
 */
export async function embedAll(
  embedder: Embedder,
  texts: readonly string[],
  options: { readonly deadline?: Deadline } = {},
): Promise<Float32Array[]> {
  const { info } = embedder;
  const size = info.preferredBatchSize ?? Math.max(1, texts.length);
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += size) {
    options.deadline?.throwIfExpired(`embed with ${info.id}`);
    const batch = texts.slice(start, start + size);
    let result: readonly Float32Array[];
    try {
      result = await embedder.embed(batch, options);
    } catch (failure) {
      options.deadline?.throwIfExpired(`embed with ${info.id}`);
      throw new EmbedFailedError(info.id, `a batch of ${batch.length} texts failed`, {
        cause: toCodeLensError(failure, `embed with ${info.id}`),
        context: { batchStart: start, batchSize: batch.length },
      });
    }
    if (result.length !== batch.length) {
      throw new EmbedFailedError(
        info.id,
        `returned ${result.length} vectors for ${batch.length} texts`,
        {
          context: { batchStart: start },
        },
      );
    }
    result.forEach((vector, index) => {
      if (vector.length !== info.dimensions || !isUsableVector(vector)) {
        throw new EmbedFailedError(
          info.id,
          `vector ${start + index} has ${vector.length} dimensions or non-finite values, expected ${info.dimensions}`,
          { context: { textIndex: start + index } },
        );
      }
      vectors.push(vector);
    });
  }
  return vectors;
}
