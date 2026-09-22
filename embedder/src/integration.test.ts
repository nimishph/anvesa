import { afterAll, describe, expect, test } from 'bun:test';
import { embedAll } from '@cntxt-labs/code-lens-dense';
import { ModelCache } from './cache.ts';
import type { LocalEmbedder } from './encoder.ts';
import { chooseTier, probeHardware } from './hardware.ts';
import { BUILTIN_MODELS } from './models.ts';
import { openLocalEmbedder, resolveModel } from './open.ts';

/**
 * Runs the real model. It needs the built-in MiniLM in a model cache, so it only runs where one is
 * named by `CODE_LENS_TEST_MODELS` (install it with `ModelCache.installFromDirectory`).
 */
const modelsDirectory = process.env.CODE_LENS_TEST_MODELS;
const enabled = modelsDirectory !== undefined && modelsDirectory !== '';
const maybe = enabled ? describe : describe.skip;

let embedder: LocalEmbedder | undefined;
afterAll(async () => {
  await embedder?.dispose();
});

const cosine = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
};

maybe('the real MiniLM model', () => {
  const cache = new ModelCache(modelsDirectory);
  const open = async (): Promise<LocalEmbedder> => {
    embedder ??= await openLocalEmbedder(BUILTIN_MODELS.low, { cache });
    return embedder;
  };

  test('opens, and reports what it verified about itself', async () => {
    const e = await open();
    expect(e.info).toMatchObject({ id: 'all-MiniLM-L6-v2', dimensions: 384, maxTokens: 256 });
  });

  test('embeds to unit vectors of the declared size, and ranks by meaning', async () => {
    const e = await open();
    const [query, related, unrelated] = await e.embed([
      'load the configuration settings from a file',
      'Parses the config file and returns validated settings.',
      'render a user interface widget on the screen',
    ]);
    for (const vector of [query, related, unrelated] as Float32Array[]) {
      expect(vector).toHaveLength(384);
      expect(Math.abs(Math.hypot(...vector) - 1)).toBeLessThan(1e-4);
    }
    expect(cosine(query as Float32Array, related as Float32Array)).toBeGreaterThan(
      cosine(query as Float32Array, unrelated as Float32Array) + 0.1,
    );
  });

  test('is repeatable: the same text alone gives the same vector', async () => {
    const e = await open();
    const [first] = await e.embed(['function parseConfig(opts: Options): Result']);
    const [second] = await e.embed(['function parseConfig(opts: Options): Result']);
    expect(cosine(first as Float32Array, second as Float32Array)).toBeGreaterThan(0.99999);
  });

  test('a text that fits by count fits the window, and one that does not is refused', async () => {
    const e = await open();
    let text = '';
    while (e.count(`${text} word`) + (e.info.specialTokens ?? 2) <= e.info.maxTokens)
      text += ' word';
    await expect(e.embed([text])).resolves.toHaveLength(1);
    await expect(e.embed([`${text} word word`])).rejects.toThrow(/window/);
  });

  test('is accepted by the dense framework’s own validation', async () => {
    const e = await open();
    const vectors = await embedAll(e, ['alpha beta', 'gamma delta', 'epsilon']);
    expect(vectors).toHaveLength(3);
  });

  test('is found again through the cache, and chosen for a machine that suits it', async () => {
    const resolved = await resolveModel(cache, {
      probe: { ...probeHardware(), availableMemoryMb: 500 },
    });
    expect(resolved.spec.id).toBe('all-MiniLM-L6-v2');
    expect(chooseTier({ ...probeHardware(), availableMemoryMb: 500 }).tier).toBe('low');
  });
});
