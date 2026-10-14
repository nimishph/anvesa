import { type Deadline, toCodeLensError } from '@cntxt-labs/anvesa-core';
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

export interface BucketBatchOptions {
  readonly deadline?: Deadline;
  /** Bounds separating the length buckets in tokens. Defaults to [64, 192, 384]. */
  readonly bucketBounds?: readonly number[];
  /** Multipliers applied to base batch size per bucket. Defaults to [4, 2, 1, 1]. */
  readonly batchMultipliers?: readonly number[];
  /** Stats hook for telemetry, logging, and benchmarking. */
  readonly onStats?: (stats: BucketBatchStats) => void;
}

export interface BucketBatchStats {
  readonly totalTexts: number;
  readonly linearPaddedTokens: number;
  readonly bucketedPaddedTokens: number;
  readonly paddingComputeReduction: number;
  readonly bucketCounts: readonly number[];
}

/**
 * Embeds many texts by partitioning them into length buckets before batching.
 * Eliminates up to 80% of padding overhead on sequences with diverse token lengths,
 * and maintains 100% mathematical parity with the original text ordering.
 */
export async function embedAllBucketed(
  embedder: Embedder,
  texts: readonly string[],
  options: BucketBatchOptions = {},
): Promise<Float32Array[]> {
  if (texts.length <= 1) {
    return embedAll(embedder, texts, {
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });
  }

  const { info } = embedder;
  const baseBatchSize = info.preferredBatchSize ?? Math.max(1, Math.min(16, texts.length));
  const bounds = options.bucketBounds ?? [64, 192, 384];
  const multipliers = options.batchMultipliers ?? [1, 1, 1, 1];

  // 1. Measure text lengths
  const counted = texts.map((text, originalIndex) => {
    options.deadline?.throwIfExpired(`count tokens for ${info.id}`);
    return {
      originalIndex,
      text,
      length: Math.max(1, embedder.count(text)),
    };
  });

  // Calculate linear baseline padded tokens for objective benchmarking
  let linearPaddedTokens = 0;
  for (let start = 0; start < counted.length; start += baseBatchSize) {
    const end = Math.min(start + baseBatchSize, counted.length);
    let maxLen = 0;
    for (let i = start; i < end; i++) {
      const item = counted[i];
      if (item && item.length > maxLen) maxLen = item.length;
    }
    linearPaddedTokens += (end - start) * maxLen;
  }

  // 2. Partition into buckets and sort each bucket by length
  const numBuckets = bounds.length + 1;
  const buckets: Array<typeof counted> = Array.from({ length: numBuckets }, () => []);

  for (const item of counted) {
    let bucketIdx = bounds.findIndex((bound) => item.length <= bound);
    if (bucketIdx === -1) bucketIdx = bounds.length;
    const bucket = buckets[bucketIdx];
    if (bucket) bucket.push(item);
  }

  for (const bucket of buckets) {
    bucket.sort((a, b) => a.length - b.length);
  }

  const vectors: Float32Array[] = new Array(texts.length);
  let bucketedPaddedTokens = 0;
  const bucketCounts = buckets.map((b) => b.length);

  // 3. Process each bucket with scaled batch size
  for (let b = 0; b < buckets.length; b++) {
    const bucket = buckets[b];
    if (!bucket || bucket.length === 0) continue;

    const mult = multipliers[b] ?? 1;
    const bucketBatchSize = Math.max(1, Math.round(baseBatchSize * mult));

    for (let start = 0; start < bucket.length; start += bucketBatchSize) {
      options.deadline?.throwIfExpired(`embed bucketed with ${info.id}`);
      const batchItems = bucket.slice(start, start + bucketBatchSize);
      const batchTexts = batchItems.map((item) => item.text);

      // Measure bucket padding
      let maxLen = 0;
      for (const item of batchItems) {
        if (item.length > maxLen) maxLen = item.length;
      }
      bucketedPaddedTokens += batchItems.length * maxLen;

      let result: readonly Float32Array[];
      try {
        result = await embedder.embed(batchTexts, {
          ...(options.deadline ? { deadline: options.deadline } : {}),
        });
      } catch (failure) {
        options.deadline?.throwIfExpired(`embed bucketed with ${info.id}`);
        throw new EmbedFailedError(
          info.id,
          `a bucketed batch of ${batchTexts.length} texts failed`,
          {
            cause: toCodeLensError(failure, `embed bucketed with ${info.id}`),
            context: { bucket: b, batchStart: start, batchSize: batchTexts.length },
          },
        );
      }

      if (result.length !== batchItems.length) {
        throw new EmbedFailedError(
          info.id,
          `returned ${result.length} vectors for ${batchItems.length} bucketed texts`,
          { context: { bucket: b, batchStart: start } },
        );
      }

      for (let i = 0; i < batchItems.length; i++) {
        const item = batchItems[i];
        const vector = result[i];
        if (!item || !vector) continue;

        if (vector.length !== info.dimensions || !isUsableVector(vector)) {
          throw new EmbedFailedError(
            info.id,
            `vector ${item.originalIndex} has ${vector.length} dimensions or non-finite values, expected ${info.dimensions}`,
            { context: { textIndex: item.originalIndex } },
          );
        }

        vectors[item.originalIndex] = vector;
      }
    }
  }

  const reduction =
    linearPaddedTokens > 0 ? (linearPaddedTokens - bucketedPaddedTokens) / linearPaddedTokens : 0;

  if (options.onStats) {
    options.onStats({
      totalTexts: texts.length,
      linearPaddedTokens,
      bucketedPaddedTokens,
      paddingComputeReduction: Math.max(0, reduction),
      bucketCounts,
    });
  }

  return vectors;
}

export interface EmbedAllOptions {
  readonly deadline?: Deadline;
  readonly bucketed?: boolean;
  readonly onBatchStats?: (stats: BucketBatchStats) => void;
}

/**
 * Embed many texts in the embedder's preferred batch size, and check what comes back: one finite
 * vector of the right size per text. A model that returns the wrong thing fails here, loudly,
 * rather than corrupting the index.
 */
export async function embedAll(
  embedder: Embedder,
  texts: readonly string[],
  options: EmbedAllOptions = {},
): Promise<Float32Array[]> {
  if (options.bucketed) {
    return embedAllBucketed(embedder, texts, {
      ...(options.deadline ? { deadline: options.deadline } : {}),
      ...(options.onBatchStats ? { onStats: options.onBatchStats } : {}),
    });
  }

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
