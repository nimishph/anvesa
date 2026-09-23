import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deadline, OperationAbortedError } from '@cntxt-labs/anvesa-core';
import { type FetchLike, ModelCache, modelsDirectory } from './cache.ts';
import {
  ModelInstallError,
  ModelIntegrityError,
  ModelUnavailableError,
  NetworkForbiddenError,
} from './errors.ts';
import type { ModelSpec } from './models.ts';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'code-lens-models-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const MODEL_BYTES = new TextEncoder().encode('pretend this is an onnx graph'.repeat(100));
const TOKENIZER_BYTES = new TextEncoder().encode('{"pretend":"tokenizer"}');

const spec: ModelSpec = {
  id: 'test-model',
  tier: undefined,
  repo: 'acme/test-model',
  model: { path: 'onnx/model.onnx', bytes: MODEL_BYTES.length, sha256: sha(MODEL_BYTES) },
  tokenizer: {
    path: 'tokenizer.json',
    bytes: TOKENIZER_BYTES.length,
    sha256: sha(TOKENIZER_BYTES),
  },
  dimensions: 4,
  maxTokens: 16,
  pooling: 'mean',
  paramsM: 1,
  license: 'MIT',
  notes: 'a test model',
};

/** A directory holding the files as upstream lays them out, or flat. */
function source(layout: 'upstream' | 'flat', overrides: { model?: Uint8Array } = {}): string {
  const dir = scratch();
  if (layout === 'upstream') {
    mkdirSync(join(dir, 'onnx'));
    writeFileSync(join(dir, 'onnx/model.onnx'), overrides.model ?? MODEL_BYTES);
  } else {
    writeFileSync(join(dir, 'model.onnx'), overrides.model ?? MODEL_BYTES);
  }
  writeFileSync(join(dir, 'tokenizer.json'), TOKENIZER_BYTES);
  return dir;
}

const leftovers = (root: string): string[] =>
  existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('.installing')) : [];

describe('where models live', () => {
  test('an explicit directory, then the home directory, then the user’s', () => {
    expect(modelsDirectory({ ANVESA_MODELS: '/m', ANVESA_HOME: '/h' })).toBe('/m');
    expect(modelsDirectory({ ANVESA_HOME: '/h' })).toBe(join('/h', 'models'));
    expect(modelsDirectory({})).toMatch(/\.anvesa[\\/]models$/);
  });
});

describe('installing from a local directory, with no network', () => {
  for (const layout of ['upstream', 'flat'] as const) {
    test(`finds the files in a ${layout} layout, verifies them and keeps them`, async () => {
      const cache = new ModelCache(scratch());
      const installed = await cache.installFromDirectory(spec, source(layout));
      expect(installed.id).toBe('test-model');
      expect(existsSync(installed.modelPath)).toBe(true);
      expect(existsSync(installed.tokenizerPath)).toBe(true);
      expect(await cache.find(spec)).toEqual(installed);
      expect(await cache.list()).toEqual(['test-model']);
      expect(leftovers(cache.root)).toEqual([]);
    });
  }

  test('a file that is not the pinned one is refused, and nothing is kept', async () => {
    const cache = new ModelCache(scratch());
    const wrong = new TextEncoder().encode('some other model entirely');
    const failure = await cache
      .installFromDirectory(spec, source('flat', { model: wrong }))
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ModelIntegrityError);
    expect(failure.context).toMatchObject({
      model: 'test-model',
      file: 'model.onnx',
      expected: spec.model.sha256,
    });
    expect(failure.context.actual).toBe(sha(wrong));
    expect(await cache.find(spec)).toBeUndefined();
    expect(await cache.list()).toEqual([]);
    expect(leftovers(cache.root)).toEqual([]);
  });

  test('a directory missing a file says what it looked for', async () => {
    const cache = new ModelCache(scratch());
    const empty = scratch();
    const failure = await cache.installFromDirectory(spec, empty).catch((e) => e);
    expect(failure).toBeInstanceOf(ModelInstallError);
    expect(failure.context.searched).toEqual([
      join(empty, 'onnx/model.onnx'),
      join(empty, 'model.onnx'),
    ]);
  });

  test('a failed reinstall leaves the working model in place', async () => {
    const cache = new ModelCache(scratch());
    await cache.installFromDirectory(spec, source('flat'));
    const wrong = new TextEncoder().encode('corrupt');
    await expect(
      cache.installFromDirectory(spec, source('flat', { model: wrong })),
    ).rejects.toBeInstanceOf(ModelIntegrityError);
    expect(await cache.find(spec)).toBeDefined();
  });

  test('a cancelled install stops with its own error and leaves nothing', async () => {
    const cache = new ModelCache(scratch());
    const controller = new AbortController();
    controller.abort();
    await expect(
      cache.installFromDirectory(spec, source('flat'), {
        deadline: Deadline.of({ signal: controller.signal }),
      }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
    expect(leftovers(cache.root)).toEqual([]);
    expect(await cache.find(spec)).toBeUndefined();
  });
});

describe('finding, verifying and removing', () => {
  test('a model that is not installed is unavailable, and says where it looked', async () => {
    const cache = new ModelCache(scratch());
    const failure = await cache.require(spec).catch((e) => e);
    expect(failure).toBeInstanceOf(ModelUnavailableError);
    expect(failure.context.searched).toEqual([cache.directoryOf('test-model')]);
  });

  test('a file that changed size on disk is no longer found', async () => {
    const cache = new ModelCache(scratch());
    const installed = await cache.installFromDirectory(spec, source('flat'));
    writeFileSync(installed.modelPath, 'truncated');
    expect(await cache.find(spec)).toBeUndefined();
  });

  test('verify reads the bytes and catches a change that kept the size', async () => {
    const cache = new ModelCache(scratch());
    const installed = await cache.installFromDirectory(spec, source('flat'));
    await expect(cache.verify(spec)).resolves.toBeDefined();
    const same = new Uint8Array(MODEL_BYTES);
    same[10] = (same[10] as number) ^ 0xff;
    writeFileSync(installed.modelPath, same);
    expect(await cache.find(spec)).toBeDefined();
    await expect(cache.verify(spec)).rejects.toBeInstanceOf(ModelIntegrityError);
  });

  test('a manifest that cannot be read is as good as absent', async () => {
    const cache = new ModelCache(scratch());
    const installed = await cache.installFromDirectory(spec, source('flat'));
    writeFileSync(join(installed.directory, 'manifest.json'), '{oops');
    expect(await cache.find(spec)).toBeUndefined();
  });

  test('remove deletes a model and says whether there was one', async () => {
    const cache = new ModelCache(scratch());
    await cache.installFromDirectory(spec, source('flat'));
    expect(await cache.remove('test-model')).toBe(true);
    expect(await cache.remove('test-model')).toBe(false);
    expect(await cache.list()).toEqual([]);
  });
});

/** A fetch that serves the pinned files, or something else, and records what it was asked. */
function serving(files: Record<string, Uint8Array>, requested: string[] = []): FetchLike {
  return async (url) => {
    requested.push(url);
    const found = Object.entries(files).find(([path]) => url.endsWith(path));
    if (!found) return { ok: false, status: 404, body: null };
    const bytes = found[1];
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // Two chunks, as a real download arrives.
          controller.enqueue(bytes.slice(0, Math.ceil(bytes.length / 2)));
          controller.enqueue(bytes.slice(Math.ceil(bytes.length / 2)));
          controller.close();
        },
      }),
    };
  };
}

describe('downloading', () => {
  const upstream = { 'onnx/model.onnx': MODEL_BYTES, 'tokenizer.json': TOKENIZER_BYTES };

  test('fetches the pinned files from upstream, reports progress, and verifies them', async () => {
    const requested: string[] = [];
    const progress: string[] = [];
    const cache = new ModelCache(scratch());
    await cache.download(spec, {
      allowNetwork: true,
      fetch: serving(upstream, requested),
      onProgress: (file, received, expected) => progress.push(`${file} ${received}/${expected}`),
    });
    expect(requested).toEqual([
      'https://huggingface.co/acme/test-model/resolve/main/tokenizer.json',
      'https://huggingface.co/acme/test-model/resolve/main/onnx/model.onnx',
    ]);
    expect(progress.at(-1)).toBe(`model.onnx ${MODEL_BYTES.length}/${MODEL_BYTES.length}`);
    expect(await cache.find(spec)).toBeDefined();
  });

  test('offline, a missing model is a typed error naming the URL, and the network is not touched', async () => {
    const requested: string[] = [];
    const cache = new ModelCache(scratch());
    const failure = await cache
      .download(spec, { allowNetwork: false, fetch: serving(upstream, requested) })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(NetworkForbiddenError);
    expect(failure.context.url).toContain('huggingface.co/acme/test-model');
    expect(requested).toEqual([]);
    expect(leftovers(cache.root)).toEqual([]);
  });

  test('bytes that are not the pinned ones are refused and not kept', async () => {
    const cache = new ModelCache(scratch());
    const tampered = { ...upstream, 'onnx/model.onnx': new TextEncoder().encode('substituted') };
    await expect(
      cache.download(spec, { allowNetwork: true, fetch: serving(tampered) }),
    ).rejects.toBeInstanceOf(ModelIntegrityError);
    expect(await cache.list()).toEqual([]);
    expect(leftovers(cache.root)).toEqual([]);
  });

  test('a server error is a typed install error with the status', async () => {
    const cache = new ModelCache(scratch());
    const failure = await cache
      .download(spec, { allowNetwork: true, fetch: serving({}) })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ModelInstallError);
    expect(failure.context.status).toBe(404);
  });

  test('an unreachable network keeps its cause', async () => {
    const cache = new ModelCache(scratch());
    class Unreachable extends Error {}
    const failure = await cache
      .download(spec, {
        allowNetwork: true,
        fetch: async () => {
          throw new Unreachable('getaddrinfo ENOTFOUND');
        },
      })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ModelInstallError);
    expect(failure.cause).toBeDefined();
  });
});
