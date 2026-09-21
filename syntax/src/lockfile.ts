import { readFile } from 'node:fs/promises';
import { GrammarLockError } from './errors.ts';
import { isNotFound, writeFileAtomic } from './files.ts';

/** `local` marks a grammar installed from a local copy whose npm version is not known. */
export const LOCAL_VERSION = 'local';

const LOCKFILE_VERSION = 1;

export interface GrammarLockEntry {
  readonly id: string;
  readonly npmPackage: string;
  readonly version: string;
  readonly file: string;
  readonly sha256: string;
}

/**
 * The record of which grammar bytes are trusted. It is meant to be committed: a teammate or CI job
 * that installs the same grammars gets the same bytes, or a `GrammarIntegrityError`.
 */
export class GrammarLock {
  readonly path: string;
  readonly #entries = new Map<string, GrammarLockEntry>();

  private constructor(path: string) {
    this.path = path;
  }

  static empty(path: string): GrammarLock {
    return new GrammarLock(path);
  }

  /** A missing file is an empty lock. An unreadable or malformed one is an error. */
  static async load(path: string): Promise<GrammarLock> {
    const lock = new GrammarLock(path);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (readFailure) {
      if (isNotFound(readFailure)) return lock;
      throw new GrammarLockError(path, 'the file could not be read', { cause: readFailure });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (parseFailure) {
      throw new GrammarLockError(path, 'the file is not valid JSON', { cause: parseFailure });
    }
    for (const entry of validateLockfile(path, parsed)) lock.#entries.set(entry.id, entry);
    return lock;
  }

  get(id: string): GrammarLockEntry | undefined {
    return this.#entries.get(id);
  }

  set(entry: GrammarLockEntry): void {
    this.#entries.set(entry.id, entry);
  }

  entries(): readonly GrammarLockEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Keys are sorted so the file diffs cleanly in review. */
  async save(): Promise<void> {
    const grammars: Record<string, Omit<GrammarLockEntry, 'id'>> = {};
    for (const { id, ...rest } of this.entries()) grammars[id] = rest;
    const document = { lockfileVersion: LOCKFILE_VERSION, grammars };
    await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`);
  }
}

function validateLockfile(path: string, parsed: unknown): readonly GrammarLockEntry[] {
  if (!isRecord(parsed)) throw new GrammarLockError(path, 'the top level is not an object');
  if (parsed.lockfileVersion !== LOCKFILE_VERSION) {
    throw new GrammarLockError(
      path,
      `lockfileVersion is ${JSON.stringify(parsed.lockfileVersion)}, expected ${LOCKFILE_VERSION}`,
    );
  }
  if (!isRecord(parsed.grammars)) throw new GrammarLockError(path, '"grammars" is not an object');
  return Object.entries(parsed.grammars).map(([id, raw]) => {
    if (!isRecord(raw)) throw new GrammarLockError(path, `entry "${id}" is not an object`);
    const { npmPackage, version, file, sha256 } = raw;
    for (const [field, value] of Object.entries({ npmPackage, version, file, sha256 })) {
      if (typeof value !== 'string' || value === '') {
        throw new GrammarLockError(path, `entry "${id}" has no usable "${field}"`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(sha256 as string)) {
      throw new GrammarLockError(path, `entry "${id}" has a malformed sha256`);
    }
    return { id, npmPackage, version, file, sha256 } as GrammarLockEntry;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
