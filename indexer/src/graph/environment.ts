import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceReadError } from '../errors.ts';
import type { ResolverEnvironment } from './tsconfig.ts';

/** Errors that mean "there is no file there", as opposed to "something is wrong". */
const ABSENT: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

function code(failure: unknown): string | undefined {
  const value = (failure as { code?: unknown } | null)?.code;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The resolver's view of the workspace on disk. Absent files are the ordinary answer to "does
 * this exist"; any other failure (permissions, I/O) is not, and is raised with the path.
 */
export class DiskEnvironment implements ResolverEnvironment {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async exists(path: string): Promise<boolean> {
    try {
      return (await stat(join(this.#root, path))).isFile();
    } catch (failure) {
      const reason = code(failure);
      if (reason !== undefined && ABSENT.has(reason)) return false;
      throw new SourceReadError(path, { cause: failure });
    }
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.#root, path), 'utf8');
    } catch (failure) {
      const reason = code(failure);
      if (reason !== undefined && (ABSENT.has(reason) || reason === 'EISDIR')) return undefined;
      throw new SourceReadError(path, { cause: failure });
    }
  }
}
