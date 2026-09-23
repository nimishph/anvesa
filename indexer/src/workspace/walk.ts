import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Deadline, toCodeLensError } from '@cntxt-labs/anvesa-core';
import { LanguageRegistry } from '@cntxt-labs/anvesa-syntax';
import { SourceReadError } from '../errors.ts';
import type { WorkspacePackage } from './discover.ts';
import { Traversal, type TraversalReport } from './traverse.ts';
import type { Workspace } from './workspace.ts';

/** The language key of a document offered to dense channels: prose, not code. */
export const DOCUMENT_LANGUAGE = 'text';

/** A source file found in the workspace. Nothing about its content is known yet. */
export interface SourceEntry {
  /** Relative to the workspace root, `/`-separated. */
  readonly path: string;
  /** The language key from `@cntxt-labs/anvesa-syntax`. */
  readonly language: string;
  readonly package: WorkspacePackage | undefined;
  /** The repository it belongs to: `''` for the workspace's own, else a nested repo's directory. */
  readonly repo: string;
  /**
   * Size and modification time, taken from one `stat`. Together they let a later run skip reading
   * a file that has not changed, without hashing it.
   */
  readonly size: number;
  readonly mtimeMs: number;
}

/** A complete account of a walk. Every file the walk saw is in exactly one of these places. */
export interface WalkSummary {
  files: number;
  bytes: number;
  byLanguage: Map<string, number>;
  /** Files per package root; files outside every package are counted under `''`. */
  byPackage: Map<string, number>;
  /** Extension -> files with a language nobody registered. `''` is "no extension". */
  unsupported: Map<string, number>;
  /** Files that were supported but outside the requested scope. */
  outOfScope: number;
  /** Files that vanished or could not be examined between listing and stat. */
  unreadable: { path: string; error: SourceReadError }[];
  traversal: TraversalReport;
}

export interface WalkOptions {
  /** Which files have a language. Defaults to the built-in registry. */
  readonly languages?: LanguageRegistry;
  /** Only yield files this accepts (see `Workspace.scope`). */
  readonly scope?: (path: string) => boolean;
  /**
   * Also yield files with no language that this accepts, as language `text`: documents and
   * other prose a dense channel reads. They get no symbols and no graph, but are tracked like any
   * file, so they are skipped when unchanged and forgotten when deleted.
   */
  readonly alsoOffer?: (path: string) => boolean;
  readonly deadline?: Deadline;
}

/**
 * The supported source files of a workspace, streamed in a fixed order. It never reads file
 * content; that is `readSource`'s job, done only for files that turn out to have changed.
 *
 * Read `summary` once iteration has finished.
 */
export class SourceWalk implements AsyncIterable<SourceEntry> {
  readonly summary: WalkSummary;
  readonly #workspace: Workspace;
  readonly #options: WalkOptions;
  readonly #traversal: Traversal;

  constructor(workspace: Workspace, options: WalkOptions = {}) {
    this.#workspace = workspace;
    this.#options = options;
    this.#traversal = new Traversal(workspace.traverseOptions(options.deadline));
    this.summary = {
      files: 0,
      bytes: 0,
      byLanguage: new Map(),
      byPackage: new Map(),
      unsupported: new Map(),
      outOfScope: 0,
      unreadable: [],
      traversal: this.#traversal.report,
    };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SourceEntry> {
    const languages = this.#options.languages ?? new LanguageRegistry();
    for await (const visit of this.#traversal) {
      for (const entry of visit.entries) {
        if (entry.kind !== 'file') continue;
        const registered = languages.forPath(entry.path);
        const language =
          registered ??
          (this.#options.alsoOffer?.(entry.path) ? { key: DOCUMENT_LANGUAGE } : undefined);
        if (!language) {
          const extension = extensionOf(entry.name);
          this.summary.unsupported.set(
            extension,
            (this.summary.unsupported.get(extension) ?? 0) + 1,
          );
          continue;
        }
        if (this.#options.scope && !this.#options.scope(entry.path)) {
          this.summary.outOfScope += 1;
          continue;
        }
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(join(this.#workspace.root, entry.path));
        } catch (failure) {
          this.summary.unreadable.push({
            path: entry.path,
            error: new SourceReadError(entry.path, {
              cause: toCodeLensError(failure, `stat ${entry.path}`),
            }),
          });
          continue;
        }
        const owner = this.#workspace.packageOf(entry.path);
        const source: SourceEntry = {
          path: entry.path,
          language: language.key,
          package: owner,
          repo: visit.repo,
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
        this.summary.files += 1;
        this.summary.bytes += info.size;
        bump(this.summary.byLanguage, language.key);
        bump(this.summary.byPackage, owner?.root ?? '');
        yield source;
      }
    }
  }
}

export function walkSources(workspace: Workspace, options: WalkOptions = {}): SourceWalk {
  return new SourceWalk(workspace, options);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** `.ts` for `a.ts`, `''` for a name with no extension or only a leading dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}
