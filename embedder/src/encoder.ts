import type { Deadline } from '@sutras/code-lens-core';
import type { Embedder, EmbedderInfo } from '@sutras/code-lens-dense';
import type { InferenceBackend, ModelOutput, TokenBatch } from './backend.ts';
import { InferenceError, InputTooLongError, ModelShapeError } from './errors.ts';
import type { Pooling } from './models.ts';
import type { Tokenizer } from './tokenizer.ts';

export interface EncoderOptions {
  readonly id: string;
  readonly dimensions: number;
  readonly maxTokens: number;
  readonly pooling: Pooling;
  readonly tokenizer: Tokenizer;
  readonly backend: InferenceBackend;
  /**
   * The most padded tokens (rows times the longest row) one batch may hold. It bounds the memory
   * of a batch: derive it from what the machine has (see `batchTokensFor`), do not guess.
   */
  readonly maxBatchTokens: number;
}

/**
 * Memory one token costs while a batch is in flight, in bytes per hidden unit: the live tensors of
 * a transformer layer (attention inputs and outputs, the feed-forward expansion) at 4 bytes each.
 * An estimate from the layer's structure.
 */
const LIVE_FLOATS_PER_HIDDEN_UNIT = 24;
const BYTES_PER_FLOAT = 4;

/**
 * Padded tokens per batch beyond which CPU inference gets slower, not faster. Measured on 100
 * lines of code with 8 cores (Windows x64, onnxruntime-node 1.27): both models were quickest at
 * 240 tokens a batch and about twice as slow at 4000 (MiniLM 181 ms against 433 ms, bge-base
 * 1625 ms against 3850 ms). Bigger batches overflow the caches and buy nothing on a CPU.
 */
export const THROUGHPUT_BATCH_TOKENS = 256;

/**
 * How many padded tokens a batch should hold: the throughput knee, or less if the memory the
 * encoder may spend on activations is smaller. A text longer than this still goes through, alone.
 */
export function batchTokensFor(dimensions: number, budgetBytes: number): number {
  const perToken = dimensions * LIVE_FLOATS_PER_HIDDEN_UNIT * BYTES_PER_FLOAT;
  return Math.max(1, Math.min(THROUGHPUT_BATCH_TOKENS, Math.floor(budgetBytes / perToken)));
}

/**
 * An `Embedder` that runs a local model. The tokenizer that counts a text is the one that feeds
 * the model, so a card that fits by `count` fits the window exactly. A text that does not fit is
 * refused, never cut: a silent cut would leave the tail of a card unsearchable without a trace.
 */
export class LocalEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  readonly #options: EncoderOptions;

  constructor(options: EncoderOptions) {
    this.#options = options;
    this.info = {
      id: options.id,
      dimensions: options.dimensions,
      maxTokens: options.maxTokens,
      specialTokens: options.tokenizer.specialTokens,
    };
  }

  count(text: string): number {
    return this.#options.tokenizer.count(text);
  }

  async embed(
    texts: readonly string[],
    options: { readonly deadline?: Deadline } = {},
  ): Promise<readonly Float32Array[]> {
    const { tokenizer, id, maxTokens, maxBatchTokens } = this.#options;
    const encoded = texts.map((text) => tokenizer.encode(text));
    for (const ids of encoded) {
      if (ids.length > maxTokens) {
        throw new InputTooLongError(id, ids.length - tokenizer.specialTokens, maxTokens);
      }
    }

    // Longest first, so a batch pads to little more than its own longest text.
    const order = encoded
      .map((_, index) => index)
      .sort((a, b) => (encoded[b]?.length ?? 0) - (encoded[a]?.length ?? 0));
    const vectors = new Array<Float32Array>(texts.length);
    let next = 0;
    while (next < order.length) {
      options.deadline?.throwIfExpired(`embed with ${id}`);
      const length = encoded[order[next] as number]?.length as number;
      const rows = Math.max(1, Math.min(order.length - next, Math.floor(maxBatchTokens / length)));
      const members = order.slice(next, next + rows);
      const output = await this.#options.backend.run(
        pad(
          members.map((i) => encoded[i] as number[]),
          length,
          tokenizer.padId,
        ),
      );
      const pooled = this.#pool(
        output,
        members.length,
        length,
        members.map((i) => encoded[i] as number[]),
      );
      members.forEach((original, row) => {
        vectors[original] = pooled[row] as Float32Array;
      });
      next += rows;
    }
    return vectors;
  }

  async dispose(): Promise<void> {
    await this.#options.backend.dispose();
  }

  /** Reduce the model's output to one unit vector per text. */
  #pool(
    output: ModelOutput,
    rows: number,
    length: number,
    ids: readonly (readonly number[])[],
  ): Float32Array[] {
    const { dimensions, pooling, id } = this.#options;
    const { data, dims } = output;
    const width = dims.at(-1);
    if (width !== dimensions) {
      throw new ModelShapeError(
        id,
        `it produces ${width} numbers per text, expected ${dimensions}`,
        {
          context: { dims },
        },
      );
    }

    const result: Float32Array[] = [];
    if (dims.length === 2) {
      // Already one vector per text (a `sentence_embedding` output).
      if (dims[0] !== rows)
        throw new ModelShapeError(id, `it returned ${dims[0]} rows for ${rows} texts`);
      for (let row = 0; row < rows; row += 1)
        result.push(unit(data.slice(row * dimensions, (row + 1) * dimensions), id));
      return result;
    }
    if (dims.length !== 3 || dims[0] !== rows || dims[1] !== length) {
      throw new ModelShapeError(
        id,
        `its output has shape [${dims.join(', ')}], expected [${rows}, ${length}, ${dimensions}]`,
      );
    }

    for (let row = 0; row < rows; row += 1) {
      const base = row * length * dimensions;
      const vector = new Float32Array(dimensions);
      if (pooling === 'cls') {
        vector.set(data.subarray(base, base + dimensions));
      } else {
        // Only real tokens count: padding positions carry states too, and must not shift the mean.
        const real = (ids[row] as readonly number[]).length;
        for (let token = 0; token < real; token += 1) {
          const offset = base + token * dimensions;
          for (let unitIndex = 0; unitIndex < dimensions; unitIndex += 1) {
            vector[unitIndex] =
              (vector[unitIndex] as number) + (data[offset + unitIndex] as number);
          }
        }
        for (let unitIndex = 0; unitIndex < dimensions; unitIndex += 1) {
          vector[unitIndex] = (vector[unitIndex] as number) / real;
        }
      }
      result.push(unit(vector, id));
    }
    return result;
  }
}

/** Ids padded on the right to `length`, with a mask that is 1 over real tokens. */
function pad(rows: readonly (readonly number[])[], length: number, padId: number): TokenBatch {
  const ids = new BigInt64Array(rows.length * length).fill(BigInt(padId));
  const mask = new BigInt64Array(rows.length * length);
  rows.forEach((row, index) => {
    row.forEach((id, position) => {
      ids[index * length + position] = BigInt(id);
      mask[index * length + position] = 1n;
    });
  });
  return { batch: rows.length, length, ids, mask };
}

/** Scale to length one. A vector with no length has no direction and is a broken model. */
function unit(vector: Float32Array, model: string): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new InferenceError(model, `it produced a vector with length ${norm}`, {
      context: { dimensions: vector.length },
    });
  }
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] as number) / norm;
  }
  return vector;
}
