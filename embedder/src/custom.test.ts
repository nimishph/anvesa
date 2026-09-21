import { afterAll, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import { ModelCache } from './cache.ts';
import { installCustomModel, planCustomModel } from './custom.ts';
import { InferenceError, ModelInstallError, ModelIntegrityError } from './errors.ts';
import { openLocalEmbedder, resolveModel } from './open.ts';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'code-lens-custom-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

/** A model folder as upstream lays one out, with a stand-in for the graph. */
function modelFolder(
  files: Record<string, string> = {},
  options: { onnx?: string | null } = {},
): string {
  const dir = scratch();
  const put = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  if (options.onnx !== null) put('onnx/model.onnx', options.onnx ?? 'not really a graph');
  cpSync(fixture('bpe.tokenizer.json'), join(dir, 'tokenizer.json'));
  for (const [path, text] of Object.entries(files)) put(path, text);
  return dir;
}

describe('deciding what a custom model is from its own files', () => {
  test('pooling and window are read from the model’s configuration', async () => {
    const dir = modelFolder({
      '1_Pooling/config.json': JSON.stringify({ pooling_mode_cls_token: true }),
      'sentence_bert_config.json': JSON.stringify({ max_seq_length: 384 }),
    });
    const plan = await planCustomModel({ id: 'mine', from: dir });
    expect(plan).toMatchObject({ pooling: 'cls', maxTokens: 384 });
    expect(plan.model.endsWith(join('onnx', 'model.onnx'))).toBe(true);
    expect(plan.tokenizer.endsWith('tokenizer.json')).toBe(true);
  });

  test('the window falls back to the tokenizer config, then the position table', async () => {
    const mean = { '1_Pooling/config.json': JSON.stringify({ pooling_mode_mean_tokens: true }) };
    expect(
      (
        await planCustomModel({
          id: 'a',
          from: modelFolder({ ...mean, 'tokenizer_config.json': '{"model_max_length": 8192}' }),
        })
      ).maxTokens,
    ).toBe(8192);
    // "Unset" is written as a huge number and is not a window.
    const roberta = modelFolder({
      ...mean,
      'tokenizer_config.json': '{"model_max_length": 1e30}',
      'config.json': '{"max_position_embeddings": 514, "model_type": "xlm-roberta"}',
    });
    expect((await planCustomModel({ id: 'b', from: roberta })).maxTokens).toBe(512);
    const bert = modelFolder({
      ...mean,
      'config.json': '{"max_position_embeddings": 512, "model_type": "bert"}',
    });
    expect((await planCustomModel({ id: 'c', from: bert })).maxTokens).toBe(512);
  });

  test('what it cannot find out it asks for, and never guesses', async () => {
    const bare = modelFolder();
    await expect(planCustomModel({ id: 'mine', from: bare })).rejects.toThrow(/--pooling/);
    await expect(planCustomModel({ id: 'mine', from: bare, pooling: 'mean' })).rejects.toThrow(
      /--max-tokens/,
    );
    const plan = await planCustomModel({ id: 'mine', from: bare, pooling: 'mean', maxTokens: 512 });
    expect(plan).toMatchObject({ pooling: 'mean', maxTokens: 512 });
    await expect(
      planCustomModel({ id: 'mine', from: bare, pooling: 'mean', maxTokens: 2 }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    const other = modelFolder({ '1_Pooling/config.json': '{"pooling_mode_max_tokens": true}' });
    await expect(planCustomModel({ id: 'mine', from: other })).rejects.toThrow(/other than mean/);
  });

  test('an id is a plain name, and not one a built-in already has', async () => {
    const dir = modelFolder();
    for (const id of ['', 'a b', '../x', '.hidden', 'all-MiniLM-L6-v2']) {
      await expect(
        planCustomModel({ id, from: dir, pooling: 'mean', maxTokens: 512 }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    }
  });

  test('a folder without a model or tokenizer says where it looked', async () => {
    const empty = scratch();
    await expect(planCustomModel({ id: 'mine', from: empty })).rejects.toBeInstanceOf(
      ModelInstallError,
    );
    const noTokenizer = scratch();
    mkdirSync(join(noTokenizer, 'onnx'));
    writeFileSync(join(noTokenizer, 'onnx', 'model.onnx'), 'x');
    await expect(
      planCustomModel({ id: 'mine', from: noTokenizer, pooling: 'mean', maxTokens: 512 }),
    ).rejects.toThrow(/tokenizer\.json/);
  });

  test('one unnamed .onnx file is used; several must be chosen between', async () => {
    const one = scratch();
    writeFileSync(join(one, 'embed.onnx'), 'x');
    cpSync(fixture('bpe.tokenizer.json'), join(one, 'tokenizer.json'));
    const plan = await planCustomModel({ id: 'mine', from: one, pooling: 'mean', maxTokens: 512 });
    expect(plan.model.endsWith('embed.onnx')).toBe(true);

    writeFileSync(join(one, 'other.onnx'), 'y');
    await expect(
      planCustomModel({ id: 'mine', from: one, pooling: 'mean', maxTokens: 512 }),
    ).rejects.toThrow(/several/);
    const named = await planCustomModel({
      id: 'mine',
      from: join(one, 'other.onnx'),
      pooling: 'mean',
      maxTokens: 512,
    });
    expect(named.model.endsWith('other.onnx')).toBe(true);
  });
});

describe('keeping a model the user brought', () => {
  const install = (
    cache: ModelCache,
    source: string,
    over: { replace?: boolean; dimensions?: number; fail?: boolean } = {},
  ) =>
    cache.installCustom({
      id: 'mine',
      maxTokens: 256,
      pooling: 'mean',
      source,
      files: {
        model: join(source, 'onnx', 'model.onnx'),
        tokenizer: join(source, 'tokenizer.json'),
      },
      ...(over.replace ? { replace: true } : {}),
      validate: async () => {
        if (over.fail) throw new InferenceError('mine', 'it does not run');
        return over.dimensions ?? 8;
      },
    });

  test('is found again, listed, and intact by size and checksum', async () => {
    const cache = new ModelCache(scratch());
    const spec = await install(cache, modelFolder());
    expect(spec).toMatchObject({ id: 'mine', dimensions: 8, maxTokens: 256, pooling: 'mean' });
    expect(spec.tier).toBeUndefined();
    expect(await cache.find(spec)).toBeDefined();
    expect((await cache.findCustom('mine'))?.model.sha256).toBe(spec.model.sha256);
    expect((await cache.customModels()).map((model) => model.id)).toEqual(['mine']);
    await expect(cache.verify(spec)).resolves.toBeDefined();
  });

  test('installing the same files again is fine, and other files are refused', async () => {
    const cache = new ModelCache(scratch());
    const source = modelFolder();
    const first = await install(cache, source);
    const again = await install(cache, source);
    expect(again.model.sha256).toBe(first.model.sha256);

    const changed = modelFolder({}, { onnx: 'a different graph' });
    const refused = await install(cache, changed).catch((failure) => failure);
    expect(refused).toBeInstanceOf(ModelIntegrityError);
    expect(refused.hint).toContain('--force');
    // What was pinned is still what is there.
    expect((await cache.findCustom('mine'))?.model.sha256).toBe(first.model.sha256);

    const replaced = await install(cache, changed, { replace: true });
    expect(replaced.model.sha256).not.toBe(first.model.sha256);
  });

  test('a model that does not run is not installed, and nothing existing is touched', async () => {
    const cache = new ModelCache(scratch());
    const source = modelFolder();
    await expect(install(cache, source, { fail: true })).rejects.toBeInstanceOf(InferenceError);
    expect(await cache.findCustom('mine')).toBeUndefined();
    expect(readdirSync(cache.root).filter((name) => name.startsWith('.installing'))).toEqual([]);

    const spec = await install(cache, source);
    await expect(
      install(cache, modelFolder({}, { onnx: 'other' }), { replace: true, fail: true }),
    ).rejects.toBeInstanceOf(InferenceError);
    expect((await cache.findCustom('mine'))?.model.sha256).toBe(spec.model.sha256);
  });

  test('a record that cannot be read is not trusted', async () => {
    const cache = new ModelCache(scratch());
    await install(cache, modelFolder());
    writeFileSync(join(cache.directoryOf('mine'), 'custom.json'), '{broken');
    expect(await cache.findCustom('mine')).toBeUndefined();
  });

  test('is chosen by name when a project asks for it, and an unknown name lists the choices', async () => {
    const cache = new ModelCache(scratch());
    await install(cache, modelFolder());
    const resolved = await resolveModel(cache, { model: 'mine' });
    expect(resolved.spec.id).toBe('mine');
    await expect(resolveModel(cache, { model: 'nope' })).rejects.toThrow(/mine/);
  });

  test('a graph that cannot run is refused by the real installer, with nothing left behind', async () => {
    const cache = new ModelCache(scratch());
    const source = modelFolder(
      {
        '1_Pooling/config.json': '{"pooling_mode_mean_tokens": true}',
        'sentence_bert_config.json': '{"max_seq_length": 128}',
      },
      { onnx: 'not an onnx graph' },
    );
    await expect(installCustomModel(cache, { id: 'mine', from: source })).rejects.toBeInstanceOf(
      InferenceError,
    );
    expect(existsSync(cache.directoryOf('mine'))).toBe(false);
  });
});

/**
 * The real thing, when a MiniLM is at hand: it is brought in under another name, its dimensions
 * are read from the model, and it works. Needs `CODE_LENS_TEST_MODELS`, as the other model tests.
 */
const modelsDirectory = process.env.CODE_LENS_TEST_MODELS;
const maybe = modelsDirectory ? describe : describe.skip;

maybe('a real model brought in by the user', () => {
  test('is installed under its own name, with dimensions read from the model, and embeds', async () => {
    const cache = new ModelCache(scratch());
    const source = join(modelsDirectory as string, 'all-MiniLM-L6-v2');
    const spec = await installCustomModel(cache, {
      id: 'my-minilm',
      from: source,
      pooling: 'mean',
      maxTokens: 256,
    });
    expect(spec.dimensions).toBe(384);

    const embedder = await openLocalEmbedder(spec, { cache });
    try {
      const [a, b, c] = await embedder.embed([
        'load the configuration settings from a file',
        'Parses the config file and returns validated settings.',
        'render a user interface widget on the screen',
      ]);
      const cosine = (x: Float32Array, y: Float32Array) =>
        x.reduce((s, v, i) => s + v * (y[i] as number), 0);
      expect(cosine(a as Float32Array, b as Float32Array)).toBeGreaterThan(
        cosine(a as Float32Array, c as Float32Array) + 0.1,
      );
    } finally {
      await embedder.dispose();
    }

    // The same folder again is the same model; the id is pinned to those bytes.
    await expect(
      installCustomModel(cache, { id: 'my-minilm', from: source, pooling: 'mean', maxTokens: 256 }),
    ).resolves.toBeDefined();
  });
});
