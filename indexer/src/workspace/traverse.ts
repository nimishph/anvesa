import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deadline } from '@cntxt-labs/anvesa-core';
import { toCodeLensError } from '@cntxt-labs/anvesa-core';
import { DirectoryReadError, IgnoreFileError } from '../errors.ts';
import { decideLayer, type IgnoreLayer, IgnoreStack, parseIgnore } from './ignore.ts';

/** Directories that are never indexed and never negotiable: version-control metadata. */
const VERSION_CONTROL = '.git';

/** Excluded unless a project says otherwise (`!node_modules` in `.anvesaignore`). */
export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.anvesa',
  '.sutra',
  '__pycache__',
];

export interface TraverseOptions {
  /** Absolute path of the workspace root. */
  readonly root: string;
  /** Names skipped before any ignore file is read. Defaults to `DEFAULT_EXCLUDES`. */
  readonly defaultExcludes?: readonly string[];
  /** Ignore file names read in every directory, later names winning within a directory. */
  readonly ignoreFiles?: readonly string[];
  /** Extra rules from configuration. They outrank every ignore file. */
  readonly configExclude?: readonly string[];
  readonly caseInsensitive?: boolean;
  /** A directory with its own `.git` is `include`d (with its own ignore context) or `skip`ped. */
  readonly nestedRepos?: 'include' | 'skip';
  /** Follow symbolic links to files. Links to directories are never followed. */
  readonly followSymlinks?: boolean;
  readonly deadline?: Deadline;
}

export type EntryKind = 'file' | 'directory';

export interface TraversedEntry {
  readonly name: string;
  /** Path relative to the root, `/`-separated. */
  readonly path: string;
  readonly kind: EntryKind;
}

export interface DirectoryVisit {
  /** Relative to the root; `''` for the root itself. */
  readonly path: string;
  /** The repository this directory belongs to: `''` for the workspace's own, else the nested repo. */
  readonly repo: string;
  /** The entries that survived ignoring, sorted by name (code point order). */
  readonly entries: readonly TraversedEntry[];
}

/** Everything that went wrong or was set aside during a traversal. Nothing here is silent. */
export interface TraversalReport {
  directories: number;
  /** Entries excluded by ignore rules, split by directory and file. */
  ignoredDirectories: number;
  ignoredFiles: number;
  nestedRepos: string[];
  skippedNestedRepos: string[];
  symlinks: string[];
  unreadableDirectories: { path: string; error: DirectoryReadError }[];
  unreadableIgnoreFiles: { path: string; error: IgnoreFileError }[];
}

/**
 * Walks a workspace directory by directory, in a fixed order, honouring ignore files the way git
 * does. Both the package survey and the file walker are built on it, so the rules for what counts
 * as "in the workspace" live in one place.
 *
 * Read `report` after iteration finishes.
 */
export class Traversal implements AsyncIterable<DirectoryVisit> {
  readonly report: TraversalReport = {
    directories: 0,
    ignoredDirectories: 0,
    ignoredFiles: 0,
    nestedRepos: [],
    skippedNestedRepos: [],
    symlinks: [],
    unreadableDirectories: [],
    unreadableIgnoreFiles: [],
  };
  readonly #options: TraverseOptions;
  readonly #base: IgnoreLayer;
  readonly #config: IgnoreLayer | undefined;
  readonly #ignoreFiles: readonly string[];
  readonly #insensitive: boolean;

  constructor(options: TraverseOptions) {
    this.#options = options;
    this.#insensitive = options.caseInsensitive === true;
    this.#ignoreFiles = options.ignoreFiles ?? ['.gitignore', '.anvesaignore'];
    const defaults = options.defaultExcludes ?? DEFAULT_EXCLUDES;
    this.#base = {
      base: '',
      rules: parseIgnore(defaults.join('\n'), { caseInsensitive: this.#insensitive }),
      origin: 'defaults',
    };
    this.#config = options.configExclude?.length
      ? {
          base: '',
          rules: parseIgnore(options.configExclude.join('\n'), {
            caseInsensitive: this.#insensitive,
          }),
          origin: 'config',
        }
      : undefined;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<DirectoryVisit> {
    const rootStack = await this.#enterRepo('', new IgnoreStack([this.#base]));
    yield* this.#visit('', '', rootStack);
  }

  async *#visit(path: string, repo: string, stack: IgnoreStack): AsyncGenerator<DirectoryVisit> {
    this.#options.deadline?.throwIfExpired(`walk ${path === '' ? 'the workspace' : path}`);
    const absolute = path === '' ? this.#options.root : join(this.#options.root, path);

    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(absolute, { withFileTypes: true });
    } catch (failure) {
      this.report.unreadableDirectories.push({
        path,
        error: new DirectoryReadError(path, { cause: failure }),
      });
      return;
    }
    names.sort((a, b) => compareNames(a.name, b.name));

    // This directory's own ignore files apply to its subtree, on top of what it inherited.
    let here = stack;
    for (const file of this.#ignoreFiles) {
      if (!names.some((entry) => entry.name === file && !entry.isDirectory())) continue;
      const rulePath = path === '' ? file : `${path}/${file}`;
      try {
        const text = await readFile(join(absolute, file), 'utf8');
        here = here.with({
          base: path,
          rules: parseIgnore(text, { caseInsensitive: this.#insensitive }),
          origin: rulePath,
        });
      } catch (failure) {
        this.report.unreadableIgnoreFiles.push({
          path: rulePath,
          error: new IgnoreFileError(rulePath, { cause: failure }),
        });
      }
    }

    const kept: TraversedEntry[] = [];
    const descend: { entry: TraversedEntry; nested: boolean }[] = [];
    for (const dirent of names) {
      const childPath = path === '' ? dirent.name : `${path}/${dirent.name}`;
      let kind: EntryKind | undefined;
      if (dirent.isSymbolicLink()) {
        this.report.symlinks.push(childPath);
        kind = await this.#followedKind(join(absolute, dirent.name));
      } else if (dirent.isDirectory()) {
        kind = 'directory';
      } else if (dirent.isFile()) {
        kind = 'file';
      }
      if (kind === undefined) continue;
      if (dirent.name === VERSION_CONTROL) continue;
      if (this.#ignored(childPath, kind === 'directory', here)) {
        if (kind === 'directory') this.report.ignoredDirectories += 1;
        else this.report.ignoredFiles += 1;
        continue;
      }
      const entry: TraversedEntry = { name: dirent.name, path: childPath, kind };
      kept.push(entry);
      if (kind === 'directory') {
        descend.push({ entry, nested: await this.#hasOwnRepo(join(absolute, dirent.name)) });
      }
    }

    this.report.directories += 1;
    yield { path, repo, entries: kept };

    for (const { entry, nested } of descend) {
      if (nested && this.#options.nestedRepos === 'skip') {
        this.report.skippedNestedRepos.push(entry.path);
        continue;
      }
      if (nested) {
        this.report.nestedRepos.push(entry.path);
        // A nested repository is its own world: the parent's ignore files do not reach into it.
        const inner = await this.#enterRepo(entry.path, new IgnoreStack([this.#base]));
        yield* this.#visit(entry.path, entry.path, inner);
      } else {
        yield* this.#visit(entry.path, repo, here);
      }
    }
  }

  /** Rules a repository brings with it beyond its `.gitignore` files: `.git/info/exclude`. */
  async #enterRepo(path: string, stack: IgnoreStack): Promise<IgnoreStack> {
    const excludePath = join(this.#options.root, path, VERSION_CONTROL, 'info', 'exclude');
    let text: string;
    try {
      text = await readFile(excludePath, 'utf8');
    } catch (failure) {
      if (isMissing(failure)) return stack;
      this.report.unreadableIgnoreFiles.push({
        path: `${path === '' ? '' : `${path}/`}.git/info/exclude`,
        error: new IgnoreFileError(excludePath, { cause: failure }),
      });
      return stack;
    }
    return stack.with({
      base: path,
      rules: parseIgnore(text, { caseInsensitive: this.#insensitive }),
      origin: `${path === '' ? '' : `${path}/`}.git/info/exclude`,
    });
  }

  async #hasOwnRepo(directory: string): Promise<boolean> {
    try {
      await stat(join(directory, VERSION_CONTROL));
      return true;
    } catch (failure) {
      if (isMissing(failure)) return false;
      throw toCodeLensError(failure, `check ${directory} for a repository`);
    }
  }

  async #followedKind(path: string): Promise<EntryKind | undefined> {
    if (this.#options.followSymlinks !== true) return undefined;
    try {
      return (await stat(path)).isFile() ? 'file' : undefined;
    } catch (failure) {
      if (isMissing(failure)) return undefined;
      throw toCodeLensError(failure, `follow symbolic link ${path}`);
    }
  }

  #ignored(path: string, isDirectory: boolean, stack: IgnoreStack): boolean {
    const configured = this.#config ? decideLayer(this.#config, path, isDirectory) : undefined;
    return (configured ?? stack.decide(path, isDirectory)) === 'ignore';
  }
}

/** Names compare by code point so the order is the same on every platform and locale. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isMissing(failure: unknown): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    'code' in failure &&
    (failure.code === 'ENOENT' || failure.code === 'ENOTDIR')
  );
}
