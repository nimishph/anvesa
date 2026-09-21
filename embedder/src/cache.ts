import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Deadline, toCodeLensError } from '@sutras/code-lens-core';
import {
  ModelInstallError,
  ModelIntegrityError,
  ModelUnavailableError,
  NetworkForbiddenError,
} from './errors.ts';
import type { ModelFileSpec, ModelSpec } from './models.ts';

/** A model on disk, ready to load. */
export interface InstalledModel {
  readonly id: string;
  readonly directory: string;
  readonly modelPath: string;
  readonly tokenizerPath: string;
}

interface Manifest {
  readonly id: string;
  readonly files: readonly { name: string; bytes: number; sha256: string }[];
}

const MODEL_FILE = 'model.onnx';
const TOKENIZER_FILE = 'tokenizer.json';
const MANIFEST_FILE = 'manifest.json';

/**
 * Where models live: `CODE_LENS_MODELS`, else `$CODE_LENS_HOME/models`, else `~/.code-lens/models`.
 * The directory is looked up here, once, so tests and installs can point it anywhere.
 */
export function modelsDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env.CODE_LENS_MODELS) return env.CODE_LENS_MODELS;
  if (env.CODE_LENS_HOME) return join(env.CODE_LENS_HOME, 'models');
  return join(homedir(), '.code-lens', 'models');
}

export type FetchLike = (
  url: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}>;

export interface DownloadOptions {
  /** Whether the network may be used at all. Off, a missing model is `NetworkForbiddenError`. */
  readonly allowNetwork: boolean;
  readonly fetch?: FetchLike;
  readonly deadline?: Deadline;
  /** Told how many bytes of a file have arrived, and how many are expected. */
  readonly onProgress?: (file: string, received: number, expected: number) => void;
}

/** The place models are kept. Every install is checked against pinned SHA-256s and is atomic. */
export class ModelCache {
  readonly root: string;

  constructor(root: string = modelsDirectory()) {
    this.root = root;
  }

  directoryOf(id: string): string {
    return join(this.root, id);
  }

  /** The model if it is installed and intact by size; `undefined` if not. */
  async find(spec: ModelSpec): Promise<InstalledModel | undefined> {
    const directory = this.directoryOf(spec.id);
    const manifest = await this.#manifest(directory);
    if (!manifest) return undefined;
    const expected = new Map([
      [MODEL_FILE, spec.model],
      [TOKENIZER_FILE, spec.tokenizer],
    ]);
    for (const [name, pinned] of expected) {
      const recorded = manifest.files.find((file) => file.name === name);
      if (!recorded || recorded.sha256 !== pinned.sha256) return undefined;
      const size = await sizeOf(join(directory, name));
      if (size !== pinned.bytes) return undefined;
    }
    return this.#installed(spec.id, directory);
  }

  /** The model, or `ModelUnavailableError` saying where it looked. */
  async require(spec: ModelSpec): Promise<InstalledModel> {
    const found = await this.find(spec);
    if (found) return found;
    throw new ModelUnavailableError(spec.id, `it is not installed in ${this.root}`, {
      context: { searched: [this.directoryOf(spec.id)] },
    });
  }

  /**
   * Read every file of an installed model and check its SHA-256 against the pinned value. Slow
   * for a large model, so it is for `doctor` and for suspicion, not for every start.
   */
  async verify(spec: ModelSpec, deadline?: Deadline): Promise<InstalledModel> {
    const installed = await this.require(spec);
    for (const [name, pinned] of [
      [MODEL_FILE, spec.model],
      [TOKENIZER_FILE, spec.tokenizer],
    ] as const) {
      deadline?.throwIfExpired(`verify ${spec.id}`);
      const actual = await hashFile(join(installed.directory, name), deadline);
      if (actual !== pinned.sha256) {
        throw new ModelIntegrityError(spec.id, name, pinned.sha256, actual);
      }
    }
    return installed;
  }

  /**
   * Install from a directory on this machine, with no network. The model and tokenizer are found
   * by the names upstream uses (`onnx/model.onnx`) or flat (`model.onnx`), hashed as they are
   * copied, and kept only if they are the files this version pins.
   */
  async installFromDirectory(
    spec: ModelSpec,
    source: string,
    options: { readonly deadline?: Deadline } = {},
  ): Promise<InstalledModel> {
    const located: [string, ModelFileSpec, string][] = [];
    for (const [name, pinned] of [
      [MODEL_FILE, spec.model],
      [TOKENIZER_FILE, spec.tokenizer],
    ] as const) {
      const found = [
        join(source, pinned.path),
        join(source, basename(pinned.path)),
        join(source, name),
      ].find((candidate) => existsSync(candidate));
      if (!found) {
        throw new ModelInstallError(spec.id, `${pinned.path} is not in ${source}`, {
          context: { searched: [join(source, pinned.path), join(source, basename(pinned.path))] },
        });
      }
      located.push([name, pinned, found]);
    }

    return this.#atomically(spec, async (staging) => {
      for (const [name, pinned, from] of located) {
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          await pipeline(
            createReadStream(from),
            async function* (chunks: AsyncIterable<Buffer>) {
              for await (const chunk of chunks) {
                options.deadline?.throwIfExpired(`install ${spec.id}`);
                hash.update(chunk);
                bytes += chunk.length;
                yield chunk;
              }
            },
            createWriteStream(join(staging, name)),
          );
        } catch (failure) {
          options.deadline?.throwIfExpired(`install ${spec.id}`);
          throw new ModelInstallError(spec.id, `cannot copy ${from}`, {
            cause: toCodeLensError(failure, `copy ${from}`),
          });
        }
        this.#check(spec, name, pinned, hash.digest('hex'), bytes);
      }
    });
  }

  /** Fetch the pinned files from upstream, when the network is allowed. */
  async download(spec: ModelSpec, options: DownloadOptions): Promise<InstalledModel> {
    const fetcher = options.fetch ?? (fetch as unknown as FetchLike);
    return this.#atomically(spec, async (staging) => {
      for (const [name, pinned] of [
        [TOKENIZER_FILE, spec.tokenizer],
        [MODEL_FILE, spec.model],
      ] as const) {
        const url = `https://huggingface.co/${spec.repo}/resolve/main/${pinned.path}`;
        if (!options.allowNetwork) throw new NetworkForbiddenError(spec.id, url);
        options.deadline?.throwIfExpired(`download ${spec.id}`);
        const response = await fetcher(
          url,
          options.deadline ? { signal: options.deadline.signal } : {},
        ).catch((failure: unknown) => {
          options.deadline?.throwIfExpired(`download ${spec.id}`);
          throw new ModelInstallError(spec.id, `cannot reach ${url}`, {
            cause: toCodeLensError(failure, `fetch ${url}`),
          });
        });
        if (!response.ok || !response.body) {
          throw new ModelInstallError(spec.id, `${url} answered ${response.status}`, {
            context: { url, status: response.status },
          });
        }
        const hash = createHash('sha256');
        let received = 0;
        const counting = async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            options.deadline?.throwIfExpired(`download ${spec.id}`);
            hash.update(chunk);
            received += chunk.length;
            options.onProgress?.(name, received, pinned.bytes);
            yield chunk;
          }
        };
        try {
          await pipeline(
            Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
            counting,
            createWriteStream(join(staging, name)),
          );
        } catch (failure) {
          options.deadline?.throwIfExpired(`download ${spec.id}`);
          throw new ModelInstallError(spec.id, `the download of ${url} failed`, {
            cause: toCodeLensError(failure, `download ${url}`),
          });
        }
        this.#check(spec, name, pinned, hash.digest('hex'), received);
      }
    });
  }

  async list(): Promise<readonly string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  }

  async remove(id: string): Promise<boolean> {
    const directory = this.directoryOf(id);
    if (!existsSync(directory)) return false;
    await rm(directory, { recursive: true, force: true });
    return true;
  }

  // --- internals --------------------------------------------------------------------------------

  #check(
    spec: ModelSpec,
    file: string,
    pinned: ModelFileSpec,
    actual: string,
    bytes: number,
  ): void {
    if (actual !== pinned.sha256) {
      throw new ModelIntegrityError(spec.id, file, pinned.sha256, actual, {
        context: { bytes, expectedBytes: pinned.bytes },
      });
    }
  }

  /**
   * Build the model in a staging directory beside the destination, and move it into place only
   * when every file has been verified: an interrupted or failed install leaves nothing behind,
   * and never a half-written model that would be trusted next time.
   */
  async #atomically(
    spec: ModelSpec,
    fill: (staging: string) => Promise<void>,
  ): Promise<InstalledModel> {
    await mkdir(this.root, { recursive: true });
    const staging = join(this.root, `.installing-${spec.id}-${process.pid}-${Date.now()}`);
    await mkdir(staging, { recursive: true });
    try {
      await fill(staging);
      const manifest: Manifest = {
        id: spec.id,
        files: [
          { name: MODEL_FILE, bytes: spec.model.bytes, sha256: spec.model.sha256 },
          { name: TOKENIZER_FILE, bytes: spec.tokenizer.bytes, sha256: spec.tokenizer.sha256 },
        ],
      };
      await writeFile(join(staging, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
      const destination = this.directoryOf(spec.id);
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
      return this.#installed(spec.id, destination);
    } catch (failure) {
      await rm(staging, { recursive: true, force: true });
      throw failure;
    }
  }

  #installed(id: string, directory: string): InstalledModel {
    return {
      id,
      directory,
      modelPath: join(directory, MODEL_FILE),
      tokenizerPath: join(directory, TOKENIZER_FILE),
    };
  }

  async #manifest(directory: string): Promise<Manifest | undefined> {
    const path = join(directory, MANIFEST_FILE);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Manifest;
    } catch {
      // A manifest that cannot be read means the model cannot be trusted: as good as absent.
      return undefined;
    }
  }
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

async function hashFile(path: string, deadline?: Deadline): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    deadline?.throwIfExpired(`hash ${basename(path)}`);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
