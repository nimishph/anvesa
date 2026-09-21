import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Deadline } from '@sutras/code-lens-core';
import { GrammarInstallError, GrammarIntegrityError, NetworkForbiddenError } from './errors.ts';
import { isNotFound, looksLikeWasm, sha256Hex, writeFileAtomic } from './files.ts';
import type { GrammarRef, LanguageRegistry } from './languages.ts';
import { type GrammarLock, LOCAL_VERSION } from './lockfile.ts';

export type InstallSource =
  /** A directory holding the wasm file, or an unpacked npm package (`package/<file>`). */
  | { readonly kind: 'directory'; readonly path: string }
  /** A single wasm file. */
  | { readonly kind: 'file'; readonly path: string }
  /** An npm tarball (`npm pack`), gzipped. */
  | { readonly kind: 'tarball'; readonly path: string }
  /** The npm registry mirror. Needs the network. */
  | { readonly kind: 'registry'; readonly version?: string; readonly baseUrl?: string };

export interface InstallOptions {
  readonly registry: LanguageRegistry;
  readonly language: string;
  readonly source: InstallSource;
  /** Where the wasm is written: `<destinationDir>/<grammar.file>`. */
  readonly destinationDir: string;
  readonly lock: GrammarLock;
  /** When true a registry install is refused before any I/O. */
  readonly offline?: boolean;
  /** Accept bytes that differ from the locked checksum and rewrite the lock entry. */
  readonly updateLock?: boolean;
  /** Version to record for a local install whose npm version cannot be determined. */
  readonly version?: string;
  readonly fetch?: typeof fetch;
  readonly deadline?: Deadline;
}

export interface InstallResult {
  readonly grammarId: string;
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
  readonly origin: string;
  /** The bytes matched a checksum that was already recorded. */
  readonly matchedExistingLock: boolean;
}

const DEFAULT_REGISTRY_URL = 'https://unpkg.com';

/**
 * Install a grammar wasm and record its checksum. Nothing is written unless the bytes are a wasm
 * module and agree with any checksum already in the lock; the write itself is atomic.
 */
export async function installGrammar(options: InstallOptions): Promise<InstallResult> {
  const definition = options.registry.require(options.language);
  const { grammar } = definition;
  const existing = options.lock.get(grammar.id);

  const obtained = await obtain(grammar, options);
  if (!looksLikeWasm(obtained.bytes)) {
    throw new GrammarInstallError(grammar.id, 'validate', 'the file is not a WebAssembly module', {
      context: { origin: obtained.origin, byteLength: obtained.bytes.byteLength },
    });
  }

  const sha256 = sha256Hex(obtained.bytes);
  const matchedExistingLock = existing?.sha256 === sha256;
  if (existing && !matchedExistingLock && !options.updateLock) {
    throw new GrammarIntegrityError(grammar.id, obtained.origin, existing.sha256, sha256, {
      hint: 'If this grammar change is intended, install again with updateLock to re-pin it.',
    });
  }

  const destination = join(options.destinationDir, grammar.file);
  try {
    await writeFileAtomic(destination, obtained.bytes);
  } catch (writeFailure) {
    throw new GrammarInstallError(grammar.id, 'write', `could not write ${destination}`, {
      cause: writeFailure,
    });
  }

  const version = obtained.version ?? options.version ?? existing?.version ?? LOCAL_VERSION;
  options.lock.set({
    id: grammar.id,
    npmPackage: grammar.npmPackage,
    version,
    file: grammar.file,
    sha256,
  });
  try {
    await options.lock.save();
  } catch (saveFailure) {
    throw new GrammarInstallError(
      grammar.id,
      'lock',
      `${destination} was written but its checksum could not be recorded in ${options.lock.path}`,
      { cause: saveFailure },
    );
  }

  return {
    grammarId: grammar.id,
    path: destination,
    sha256,
    version,
    origin: obtained.origin,
    matchedExistingLock,
  };
}

interface Obtained {
  readonly bytes: Uint8Array;
  readonly origin: string;
  /** The npm version the bytes belong to, when the source can tell. */
  readonly version?: string;
}

async function obtain(grammar: GrammarRef, options: InstallOptions): Promise<Obtained> {
  const { source } = options;
  switch (source.kind) {
    case 'file':
      return { bytes: await readLocal(grammar, source.path), origin: source.path };
    case 'directory':
      return fromDirectory(grammar, source.path);
    case 'tarball':
      return fromTarball(grammar, source.path);
    case 'registry':
      return fromRegistry(grammar, source, options);
  }
}

async function readLocal(grammar: GrammarRef, path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (readFailure) {
    throw new GrammarInstallError(
      grammar.id,
      'locate',
      isNotFound(readFailure) ? `${path} does not exist` : `${path} could not be read`,
      { cause: readFailure },
    );
  }
}

async function fromDirectory(grammar: GrammarRef, directory: string): Promise<Obtained> {
  const candidates = [join(directory, grammar.file), join(directory, 'package', grammar.file)];
  const tried: string[] = [];
  for (const candidate of candidates) {
    try {
      return { bytes: new Uint8Array(await readFile(candidate)), origin: candidate };
    } catch (readFailure) {
      if (!isNotFound(readFailure)) {
        throw new GrammarInstallError(grammar.id, 'locate', `${candidate} could not be read`, {
          cause: readFailure,
        });
      }
      tried.push(candidate);
    }
  }
  throw new GrammarInstallError(grammar.id, 'locate', `${grammar.file} not found in ${directory}`, {
    context: { tried },
  });
}

async function fromTarball(grammar: GrammarRef, path: string): Promise<Obtained> {
  const compressed = await readLocal(grammar, path);
  let tar: Uint8Array;
  try {
    tar = gunzipSync(compressed);
  } catch (gzipFailure) {
    throw new GrammarInstallError(grammar.id, 'extract', `${path} is not a gzip archive`, {
      cause: gzipFailure,
    });
  }
  const wanted = `/${grammar.file}`;
  const bytes = findTarEntry(
    grammar,
    tar,
    (name) => name === grammar.file || name.endsWith(wanted),
  );
  if (!bytes) {
    throw new GrammarInstallError(grammar.id, 'extract', `${grammar.file} is not in ${path}`);
  }
  return { bytes, origin: `${path}#${grammar.file}` };
}

async function fromRegistry(
  grammar: GrammarRef,
  source: Extract<InstallSource, { kind: 'registry' }>,
  options: InstallOptions,
): Promise<Obtained> {
  const existing = options.lock.get(grammar.id);
  const pinned = existing && existing.version !== LOCAL_VERSION ? existing.version : undefined;
  const requested = source.version ?? pinned ?? 'latest';
  const base = source.baseUrl ?? DEFAULT_REGISTRY_URL;
  const url = `${base}/${grammar.npmPackage}@${requested}/${grammar.file}`;

  if (options.offline) throw new NetworkForbiddenError(grammar.id, url);
  options.deadline?.throwIfExpired(`fetching grammar ${grammar.id}`);

  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      redirect: 'follow',
      ...(options.deadline ? { signal: options.deadline.signal } : {}),
    });
  } catch (fetchFailure) {
    options.deadline?.throwIfExpired(`fetching grammar ${grammar.id}`);
    throw new GrammarInstallError(grammar.id, 'fetch', `request to ${url} failed`, {
      cause: fetchFailure,
    });
  }
  if (!response.ok) {
    throw new GrammarInstallError(
      grammar.id,
      'fetch',
      `${url} answered HTTP ${response.status} ${response.statusText}`,
      { context: { url, status: response.status } },
    );
  }

  const version = concreteVersion(requested, response.url);
  if (version === undefined) {
    throw new GrammarInstallError(
      grammar.id,
      'fetch',
      `cannot tell which version "${requested}" resolved to, so it cannot be pinned`,
      { context: { url, finalUrl: response.url } },
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, origin: response.url || url, version };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const VERSION_IN_URL = /@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)\//;

/** The exact version a request resolved to: the request itself if exact, else what the redirect says. */
function concreteVersion(requested: string, finalUrl: string): string | undefined {
  if (EXACT_VERSION.test(requested)) return requested;
  return VERSION_IN_URL.exec(finalUrl)?.[1];
}

// --- tar ---------------------------------------------------------------------------------------
// Fixed widths from the ustar format. These describe the file format, not a policy limit.
const TAR_BLOCK = 512;
const TAR_NAME_LENGTH = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_TYPE_OFFSET = 156;
const TAR_MAGIC_OFFSET = 257;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LENGTH = 155;
const TAR_REGULAR_FILE = [0x00, 0x30];

/** Return the bytes of the first regular file whose path satisfies `matches`. */
function findTarEntry(
  grammar: GrammarRef,
  tar: Uint8Array,
  matches: (name: string) => boolean,
): Uint8Array | undefined {
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) return undefined;

    const sizeText = cString(header, TAR_SIZE_OFFSET, TAR_SIZE_LENGTH).trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GrammarInstallError(
        grammar.id,
        'extract',
        'the tarball has a corrupt entry header',
        {
          context: { offset, sizeText },
        },
      );
    }
    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new GrammarInstallError(grammar.id, 'extract', 'the tarball is truncated', {
        context: { offset, entrySize: size, archiveSize: tar.length },
      });
    }

    const isUstar = cString(header, TAR_MAGIC_OFFSET, 5) === 'ustar';
    const prefix = isUstar ? cString(header, TAR_PREFIX_OFFSET, TAR_PREFIX_LENGTH) : '';
    const name = cString(header, 0, TAR_NAME_LENGTH);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const type = header[TAR_TYPE_OFFSET] ?? 0;
    if (TAR_REGULAR_FILE.includes(type) && matches(fullName)) {
      return new Uint8Array(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return undefined;
}

function cString(buffer: Uint8Array, start: number, length: number): string {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}
