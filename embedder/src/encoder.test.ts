import { describe, expect, test } from 'bun:test';
import { Deadline, DeadlineExceededError } from '@cntxt-labs/anvesa-core';
import { embedAll } from '@cntxt-labs/anvesa-dense';
import type { InferenceBackend, ModelOutput, TokenBatch } from './backend.ts';
import { batchTokensFor, LocalEmbedder, THROUGHPUT_BATCH_TOKENS } from './encoder.ts';
import { InferenceError, InputTooLongError, ModelShapeError } from './errors.ts';
import type { Pooling } from './models.ts';
import { tokenizerFromVocabulary } from './tokenizer.ts';

const DIMENSIONS = 4;
const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', 'world', 'foo', 'bar', 'baz', 'qux'];
const tokenizer = tokenizerFromVocabulary(vocab.join('\n'), 'test vocab', { lowercase: true });

/** A backend whose token states are a function of the id, so pooling can be checked by hand. */
class FakeBackend implements InferenceBackend {
  readonly batches: { rows: number; length: number }[] = [];
  disposed = false;
  constructor(
    private readonly shape: (batch: TokenBatch) => ModelOutput = (batch) => states(batch),
  ) {}
  async run(input: TokenBatch): Promise<ModelOutput> {
    this.batches.push({ rows: input.batch, length: input.length });
    return this.shape(input);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** State of token `id` at unit `d` is `(id + 1) * (d + 1)`; padding is loud, so it shows if used. */
function states(batch: TokenBatch): ModelOutput {
  const data = new Float32Array(batch.batch * batch.length * DIMENSIONS);
  for (let row = 0; row < batch.batch; row += 1) {
    for (let token = 0; token < batch.length; token += 1) {
      const at = row * batch.length + token;
      const real = batch.mask[at] === 1n;
      for (let unit = 0; unit < DIMENSIONS; unit += 1) {
        data[at * DIMENSIONS + unit] = real ? (Number(batch.ids[at]) + 1) * (unit + 1) : 1000;
      }
    }
  }
  return { data, dims: [batch.batch, batch.length, DIMENSIONS] };
}

function embedder(
  options: {
    pooling?: Pooling;
    backend?: FakeBackend;
    maxBatchTokens?: number;
    maxTokens?: number;
  } = {},
) {
  const backend = options.backend ?? new FakeBackend();
  return {
    backend,
    embedder: new LocalEmbedder({
      id: 'fake',
      dimensions: DIMENSIONS,
      maxTokens: options.maxTokens ?? 16,
      pooling: options.pooling ?? 'mean',
      tokenizer,
      backend,
      maxBatchTokens: options.maxBatchTokens ?? 1000,
    }),
  };
}

const norm = (v: readonly number[]): number[] => {
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
};

describe('what the embedder says about itself', () => {
  test('reports the model, its window and the tokens it adds', () => {
    expect(embedder().embedder.info).toEqual({
      id: 'fake',
      dimensions: DIMENSIONS,
      maxTokens: 16,
      specialTokens: 2,
    });
  });

  test('count is the tokenizer that feeds the model: exact, and without the special tokens', () => {
    const { embedder: e } = embedder();
    expect(e.count('hello world')).toBe(2);
    expect(e.count('')).toBe(0);
    expect(e.count('zzz')).toBe(1);
  });
});

describe('pooling', () => {
  test('mean pooling averages the real tokens, [CLS] and [SEP] included, and never the padding', async () => {
    const { embedder: e } = embedder();
    // ids: [CLS]=2, hello=4, [SEP]=3  ->  states (id+1)*(d+1): mean of 3, 5, 4 = 4 per unit scale.
    const [vector] = await e.embed(['hello']);
    expect(Array.from(vector as Float32Array)).toEqual(
      norm([1, 2, 3, 4].map((scale) => 4 * scale)).map((x) => Math.fround(x)),
    );
  });

  test('a short text in a batch with a long one is not affected by the padding', async () => {
    const { embedder: e } = embedder();
    const [alone] = await e.embed(['hello']);
    const [together] = await e.embed(['hello', 'hello world foo bar baz qux']);
    expect(Array.from(together as Float32Array)).toEqual(Array.from(alone as Float32Array));
  });

  test('cls pooling takes the first token’s state', async () => {
    const { embedder: e } = embedder({ pooling: 'cls' });
    const [vector] = await e.embed(['hello world']);
    // [CLS] is id 2, state (2 + 1) * (d + 1).
    expect(Array.from(vector as Float32Array)).toEqual(
      norm([3, 6, 9, 12]).map((x) => Math.fround(x)),
    );
  });

  test('a model that already pools (one vector per text) is used as it is', async () => {
    const backend = new FakeBackend((batch) => ({
      data: Float32Array.from({ length: batch.batch * DIMENSIONS }, (_, i) => i + 1),
      dims: [batch.batch, DIMENSIONS],
    }));
    const { embedder: e } = embedder({ backend });
    const [first, second] = await e.embed(['hello', 'world foo']);
    expect(first?.length).toBe(DIMENSIONS);
    // Rows come back in the order of the texts, however they were batched.
    expect(Math.abs(Math.hypot(...(first as Float32Array)) - 1)).toBeLessThan(1e-6);
    expect(second).not.toEqual(first);
  });

  test('every vector has length one', async () => {
    const { embedder: e } = embedder();
    for (const vector of await e.embed(['a', 'hello', 'hello world foo'])) {
      expect(Math.abs(Math.hypot(...vector) - 1)).toBeLessThan(1e-6);
    }
  });
});

describe('batching', () => {
  test('results come back in the order the texts were given, whatever the batches were', async () => {
    const { embedder: e, backend } = embedder({ maxBatchTokens: 12 });
    const texts = ['hello', 'hello world foo bar', 'world', 'foo bar baz', 'baz'];
    const vectors = await e.embed(texts);
    const separately = await Promise.all(texts.map(async (t) => (await e.embed([t]))[0]));
    vectors.forEach((vector, index) => {
      expect(Array.from(vector)).toEqual(Array.from(separately[index] as Float32Array));
    });
    expect(backend.batches.length).toBeGreaterThan(1);
  });

  test('a batch pads to its own longest text, longest texts first, within the token budget', async () => {
    const { embedder: e, backend } = embedder({ maxBatchTokens: 20 });
    await e.embed(['hello', 'hello world foo bar', 'world foo', 'baz', 'qux qux qux']);
    for (const { rows, length } of backend.batches) expect(rows * length).toBeLessThanOrEqual(20);
    const lengths = backend.batches.map((batch) => batch.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  test('a text longer than the batch budget still goes through, alone', async () => {
    const { embedder: e, backend } = embedder({ maxBatchTokens: 3 });
    await e.embed(['hello world foo bar baz']);
    expect(backend.batches).toEqual([{ rows: 1, length: 7 }]);
  });

  test('the batch budget is the throughput knee, or less when memory is short', () => {
    expect(batchTokensFor(768, 10 * 1024 ** 3)).toBe(THROUGHPUT_BATCH_TOKENS);
    expect(batchTokensFor(768, 768 * 24 * 4 * 40)).toBe(40);
    expect(batchTokensFor(768, 1)).toBe(1);
  });

  test('no texts is no batches', async () => {
    const { embedder: e, backend } = embedder();
    expect(await e.embed([])).toEqual([]);
    expect(backend.batches).toEqual([]);
  });
});

describe('what it refuses', () => {
  test('a text over the window is refused with the count, never truncated', async () => {
    const { embedder: e, backend } = embedder({ maxTokens: 6 });
    const failure = await e.embed(['hello world foo bar baz qux']).catch((thrown) => thrown);
    expect(failure).toBeInstanceOf(InputTooLongError);
    expect(failure.context).toMatchObject({ tokens: 6, window: 6 });
    // Refused before anything ran.
    expect(backend.batches).toEqual([]);
    // Exactly the window is fine: 4 tokens plus [CLS] and [SEP].
    await expect(e.embed(['hello world foo bar'])).resolves.toHaveLength(1);
  });

  test('a model with the wrong number of dimensions is a shape error', async () => {
    const backend = new FakeBackend((batch) => ({
      data: new Float32Array(batch.batch * batch.length * 8).fill(1),
      dims: [batch.batch, batch.length, 8],
    }));
    const { embedder: e } = embedder({ backend });
    await expect(e.embed(['hello'])).rejects.toBeInstanceOf(ModelShapeError);
  });

  test('an output of the wrong shape is a shape error', async () => {
    const wrongRows = new FakeBackend(() => ({
      data: new Float32Array(DIMENSIONS),
      dims: [1, DIMENSIONS],
    }));
    await expect(
      embedder({ backend: wrongRows }).embedder.embed(['a', 'b']),
    ).rejects.toBeInstanceOf(ModelShapeError);
    const wrongLength = new FakeBackend(() => ({
      data: new Float32Array(2 * 99 * DIMENSIONS),
      dims: [1, 99, DIMENSIONS],
    }));
    await expect(embedder({ backend: wrongLength }).embedder.embed(['a'])).rejects.toBeInstanceOf(
      ModelShapeError,
    );
  });

  test('a vector with no length is a broken model, not a vector', async () => {
    const zeros = new FakeBackend((batch) => ({
      data: new Float32Array(batch.batch * batch.length * DIMENSIONS),
      dims: [batch.batch, batch.length, DIMENSIONS],
    }));
    await expect(embedder({ backend: zeros }).embedder.embed(['a'])).rejects.toBeInstanceOf(
      InferenceError,
    );
  });
});

describe('cancellation and the dense framework', () => {
  test('an expired deadline stops between batches with its own error', async () => {
    const { embedder: e, backend } = embedder({ maxBatchTokens: 8 });
    const deadline = Deadline.of({ timeoutMs: 1 });
    await Bun.sleep(15);
    await expect(
      e.embed(['hello world', 'foo bar', 'baz qux'], { deadline }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(backend.batches).toEqual([]);
  });

  test('embedAll accepts what it returns: one finite vector of the right size per text', async () => {
    const { embedder: e } = embedder({ maxBatchTokens: 10 });
    const vectors = await embedAll(e, ['hello', 'world foo', 'bar', 'baz qux hello']);
    expect(vectors).toHaveLength(4);
    for (const vector of vectors) expect(vector).toHaveLength(DIMENSIONS);
  });

  test('dispose releases the runtime', async () => {
    const { embedder: e, backend } = embedder();
    await e.dispose();
    expect(backend.disposed).toBe(true);
  });
});
