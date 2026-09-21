import {
  type CodeLensError,
  Deadline,
  DeadlineExceededError,
  OperationAbortedError,
  toCodeLensError,
} from '@sutras/code-lens-core';
import { type Ingester, inputFile } from '@sutras/code-lens-dense';
import { WEXPR_FORMAT_VERSION } from '@sutras/code-lens-structural';
import type { LanguageRegistry } from '@sutras/code-lens-syntax';
import { SourceReadError } from '../errors.ts';
import type { FactExtractor, FileFacts } from '../extract/index.ts';
import {
  DiskEnvironment,
  type FileChange,
  GraphLinker,
  GraphQueries,
  ImportResolver,
  summarize,
} from '../graph/index.ts';
import type { FileQuarantine, IndexStore, QuarantineReason } from '../store/index.ts';
import { readSource } from '../workspace/content.ts';
import { DOCUMENT_LANGUAGE, walkSources } from '../workspace/walk.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { DenseReport, IndexEvent, IndexReport } from './report.ts';

/** Set while a run is writing, cleared when it has finished. Found set, a run did not finish. */
const DIRTY_KEY = 'index.dirty';
/** What the dense channels were built with (transformer versions, model), after a complete run. */
const DENSE_KEY = 'dense.signature';

/** When the previous run began, so files touched around then can be told from files left alone. */
const STARTED_KEY = 'index.lastStartMs';

/**
 * A file changed within this long of the previous run starting might have been changed again
 * without its timestamp moving: file systems record modification times coarsely, the worst of
 * them (FAT) to two seconds. Such a file is read and hashed rather than trusted to its stamp,
 * the same "racily clean" rule git applies to its index.
 */
const TIMESTAMP_GRANULARITY_MS = 2000;

export interface IndexerOptions {
  readonly workspace: Workspace;
  readonly store: IndexStore;
  readonly extractor: FactExtractor;
  /**
   * Dense channels to feed. Without it the index holds facts and the graph only, which is
   * everything structural retrieval and graph queries need.
   */
  readonly ingester?: Ingester;
  /** Which languages to index. Defaults to every language the syntax registry knows. */
  readonly languages?: LanguageRegistry;
  /** Index only these language keys, and leave the rest of the files alone. */
  readonly only?: readonly string[];
}

export interface RunOptions {
  /** Only these files (see `Workspace.scope`). Nothing outside it is visited, or removed. */
  readonly scope?: (path: string) => boolean;
  /** Redo every file, and every card, even where nothing changed. */
  readonly force?: boolean;
  /** Look at quarantined files again even if they have not changed (a grammar was installed). */
  readonly retryQuarantined?: boolean;
  readonly deadline?: Deadline;
  readonly onEvent?: (event: IndexEvent) => void;
}

/**
 * Brings the index up to date with the workspace, touching only what changed.
 *
 * A file that has not changed (same size and modification time) is not even read. One whose
 * content is unchanged is only re-stamped. A changed one is parsed once, and its facts, graph
 * edges and dense cards are replaced. Files that depend on a changed file are linked again, since
 * what they call may have moved.
 *
 * Every file's rows are written as a unit, and a marker is set before the first write and cleared
 * after the last. If a run is killed, the index is consistent file by file, and the next run sees
 * the marker and rebuilds what it cannot trust (all edges, all cards) instead of assuming.
 * One file failing does not stop the run: it is quarantined with the reason, and reported.
 */
export class Indexer {
  readonly #workspace: Workspace;
  readonly #store: IndexStore;
  readonly #extractor: FactExtractor;
  readonly #ingester: Ingester | undefined;
  readonly #languages: LanguageRegistry | undefined;
  readonly #only: ReadonlySet<string> | undefined;

  constructor(options: IndexerOptions) {
    this.#workspace = options.workspace;
    this.#store = options.store;
    this.#extractor = options.extractor;
    this.#ingester = options.ingester;
    this.#languages = options.languages;
    this.#only = options.only === undefined ? undefined : new Set(options.only);
  }

  async index(options: RunOptions = {}): Promise<IndexReport> {
    const started = performance.now();
    const deadline = options.deadline ?? Deadline.unbounded();
    const emit = options.onEvent ?? (() => undefined);
    const wholeWorkspace = options.scope === undefined;

    const interrupted = (await this.#store.getMeta(DIRTY_KEY)) !== undefined;
    const previousSignature = await this.#store.getMeta(DENSE_KEY);
    const signature = this.#ingester?.signature;
    // What cannot be trusted after an interrupted run or a change of model or transformer.
    const denseStale =
      this.#ingester !== undefined && (interrupted || previousSignature !== signature);
    const rebuildEverything = options.force === true;

    const previousStart = Number(await this.#store.getMeta(STARTED_KEY));
    emit({ kind: 'started', interrupted });
    await this.#store.setMeta(DIRTY_KEY, new Date().toISOString());
    await this.#store.setMeta(STARTED_KEY, String(Date.now()));

    const counts = {
      unchanged: 0,
      touched: 0,
      added: 0,
      modified: 0,
      quarantined: 0,
      stillQuarantined: 0,
      removed: 0,
      skippedLanguage: 0,
    };
    const changes = new Map<string, FileChange>();
    const quarantined: { path: string; reason: QuarantineReason; message: string }[] = [];
    const dense: DenseReport = {
      ingested: 0,
      current: 0,
      cards: 0,
      quarantinedCards: 0,
      failed: [],
    };
    const seen = new Set<string>();
    const offered = new Set<string>();

    const ingester = this.#ingester;
    const walk = walkSources(this.#workspace, {
      ...(ingester ? { alsoOffer: (path: string) => ingester.claims(path) } : {}),
      ...(this.#languages ? { languages: this.#languages } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      deadline,
    });

    for await (const entry of walk) {
      deadline.throwIfExpired(`index ${entry.path}`);
      // Offered by the walk, whether or not this run looks at it, so it is not taken for gone.
      offered.add(entry.path);
      if (this.#only && entry.language !== DOCUMENT_LANGUAGE && !this.#only.has(entry.language)) {
        counts.skippedLanguage += 1;
        continue;
      }
      seen.add(entry.path);
      const state = await this.#store.fileState(entry.path);
      const sameStamp =
        state !== undefined && state.size === entry.size && state.mtimeMs === entry.mtimeMs;

      const retry = options.retryQuarantined === true && state?.status === 'quarantined';
      const racy = !(entry.mtimeMs < previousStart - TIMESTAMP_GRANULARITY_MS);
      if (
        sameStamp &&
        !racy &&
        !rebuildEverything &&
        !retry &&
        !(denseStale && state.status === 'indexed')
      ) {
        if (state.status === 'indexed') counts.unchanged += 1;
        else counts.stillQuarantined += 1;
        emit({ kind: 'file', path: entry.path, outcome: 'unchanged' });
        continue;
      }

      let content: Awaited<ReturnType<typeof readSource>>;
      try {
        content = await readSource(this.#workspace.root, entry.path, { deadline });
      } catch (failure) {
        rethrowIfStopped(failure);
        const error = toCodeLensError(failure, `read ${entry.path}`);
        await this.#quarantine(entry, error, undefined, changes, counts, quarantined, emit);
        continue;
      }
      if (content.kind === 'binary') {
        await this.#quarantineWith(
          entry,
          'binary',
          'the file is binary, so it is not source',
          undefined,
          undefined,
          changes,
          counts,
          quarantined,
          emit,
        );
        continue;
      }

      const unchangedContent =
        state?.status === 'indexed' && state.contentHash === content.hash && !rebuildEverything;
      if (unchangedContent) {
        // Same bytes, new timestamp: remember the timestamp so the next run can skip the read.
        await this.#store.touchFile(entry.path, entry.size, entry.mtimeMs);
        counts.touched += 1;
        emit({ kind: 'file', path: entry.path, outcome: 'touched' });
      } else {
        try {
          const { facts, wexpr } =
            entry.language === DOCUMENT_LANGUAGE
              ? documentFacts(entry.path)
              : await this.#extractor.extractWithStructure(entry.path, content.content, {
                  deadline,
                });
          await this.#store.replaceFile({
            path: entry.path,
            language: entry.language,
            packageRoot: entry.package?.root,
            repo: entry.repo,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            contentHash: content.hash,
            facts,
            wexpr: { formatVersion: WEXPR_FORMAT_VERSION, text: wexpr },
          });
        } catch (failure) {
          rethrowIfStopped(failure);
          const error = toCodeLensError(failure, `index ${entry.path}`);
          await this.#quarantine(entry, error, content.hash, changes, counts, quarantined, emit);
          await this.#dropCards(entry.path);
          continue;
        }
        const outcome = state?.status === 'indexed' ? 'modified' : 'added';
        counts[outcome] += 1;
        changes.set(entry.path, outcome === 'added' ? 'added' : 'modified');
        emit({ kind: 'file', path: entry.path, outcome });
      }

      if (this.#ingester) {
        await this.#ingest(entry.path, content.content, entry.language, dense, {
          deadline,
          force: rebuildEverything,
        });
      }
    }

    if (wholeWorkspace) {
      await this.#prune(offered, changes, counts);
    }

    const link = await this.#link(changes, interrupted || rebuildEverything, deadline, emit);

    if (this.#ingester && signature !== undefined) await this.#store.setMeta(DENSE_KEY, signature);
    await this.#store.deleteMeta(DIRTY_KEY);

    const summary = walk.summary;
    const report: IndexReport = {
      complete: true,
      resumedAfterInterruption: interrupted,
      files: {
        seen: seen.size,
        unchanged: counts.unchanged,
        touched: counts.touched,
        added: counts.added,
        modified: counts.modified,
        quarantined: counts.quarantined,
        stillQuarantined: counts.stillQuarantined,
        removed: counts.removed,
        skippedLanguage: counts.skippedLanguage,
        unsupported: summary.unsupported,
        outOfScope: summary.outOfScope,
        unreadable: summary.unreadable.map((entry) => ({
          path: entry.path,
          message: entry.error.message,
        })),
        ignored: summary.traversal.ignoredFiles,
      },
      quarantined,
      link: link ? summarize(link) : undefined,
      relinked: link?.length ?? 0,
      dense: this.#ingester ? dense : undefined,
      elapsedMs: performance.now() - started,
    };
    emit({ kind: 'finished', report });
    return report;
  }

  async #quarantine(
    entry: { path: string; size: number; mtimeMs: number },
    error: CodeLensError,
    hash: string | undefined,
    changes: Map<string, FileChange>,
    counts: { quarantined: number },
    into: { path: string; reason: QuarantineReason; message: string }[],
    emit: (event: IndexEvent) => void,
  ): Promise<void> {
    await this.#quarantineWith(
      entry,
      reasonFor(error),
      error.message,
      error.code,
      hash,
      changes,
      counts,
      into,
      emit,
    );
  }

  async #quarantineWith(
    entry: { path: string; size: number; mtimeMs: number },
    reason: QuarantineReason,
    message: string,
    errorCode: string | undefined,
    hash: string | undefined,
    changes: Map<string, FileChange>,
    counts: { quarantined: number },
    into: { path: string; reason: QuarantineReason; message: string }[],
    emit: (event: IndexEvent) => void,
  ): Promise<void> {
    const record: FileQuarantine = {
      path: entry.path,
      reason,
      message,
      ...(errorCode === undefined ? {} : { errorCode }),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ...(hash === undefined ? {} : { contentHash: hash }),
    };
    await this.#store.quarantineFile(record);
    await this.#dropCards(entry.path);
    counts.quarantined += 1;
    changes.set(entry.path, 'modified');
    into.push({ path: entry.path, reason, message });
    emit({ kind: 'file', path: entry.path, outcome: 'quarantined', reason });
  }

  /** A file that is no longer indexed has no cards either. */
  async #dropCards(path: string): Promise<void> {
    await this.#ingester?.remove(path);
  }

  async #ingest(
    path: string,
    content: string,
    language: string,
    report: DenseReport,
    options: { deadline: Deadline; force: boolean },
  ): Promise<void> {
    const ingester = this.#ingester as Ingester;
    const reports = await ingester.ingest(inputFile(path, content, { language }), options);
    for (const entry of reports) {
      if (entry.outcome === 'failed') {
        report.failed.push({
          path,
          channel: entry.channel,
          message: entry.failure?.message ?? 'ingest failed',
        });
      } else if (entry.outcome === 'unchanged') {
        report.current += 1;
      } else {
        report.ingested += 1;
        report.cards += entry.indexed;
        report.quarantinedCards += entry.quarantined.length;
      }
    }
  }

  /** Forget files that are indexed but no longer on disk (or no longer visible). */
  async #prune(
    seen: ReadonlySet<string>,
    changes: Map<string, FileChange>,
    counts: { removed: number },
  ): Promise<void> {
    let cursor: string | undefined;
    const gone: string[] = [];
    do {
      const page = await this.#store.files({ ...(cursor === undefined ? {} : { cursor }) });
      for (const file of page.items) if (!seen.has(file.path)) gone.push(file.path);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    for (const path of gone) {
      // Only files the walk would have offered can be judged gone; an `only` filter hides others.
      await this.#store.removeFile(path);
      await this.#dropCards(path);
      counts.removed += 1;
      changes.set(path, 'removed');
    }
  }

  /**
   * Link what needs it. After an interrupted run, or a forced one, every file: the edges of
   * files this run never reached cannot be trusted. Otherwise the changed files and the files
   * that depend on them.
   */
  async #link(
    changes: ReadonlyMap<string, FileChange>,
    everything: boolean,
    deadline: Deadline,
    emit: (event: IndexEvent) => void,
  ) {
    if (!everything && changes.size === 0) return undefined;
    const resolver = new ImportResolver(
      new DiskEnvironment(this.#workspace.root),
      this.#workspace.packages(),
    );
    const linker = new GraphLinker(this.#store, resolver);
    emit({ kind: 'linking', everything });
    if (everything) return linker.linkAll({ deadline });

    const queries = new GraphQueries(this.#store, (path) => this.#workspace.packageOf(path));
    const dependents = await queries.relinkSet(changes);
    const targets = new Set<string>(dependents);
    for (const [path, change] of changes) if (change !== 'removed') targets.add(path);
    const reports = [];
    for (const path of [...targets].sort()) {
      deadline.throwIfExpired(`link ${path}`);
      const report = await linker.linkFile(path, { deadline });
      if (report) reports.push(report);
    }
    return reports;
  }
}

/** A document has no code to read: it is tracked, and read by the dense channels, and that is all. */
function documentFacts(path: string): { facts: FileFacts; wexpr: string } {
  return {
    facts: {
      path,
      language: DOCUMENT_LANGUAGE,
      symbols: [],
      calls: [],
      imports: [],
      exports: [],
      hasSyntaxErrors: false,
      importsSupported: false,
      gaps: { unnamedCalls: 0, computedImports: 0 },
    },
    // An outline with nothing in it, so structural coverage counts the file as covered.
    wexpr: '(document)',
  };
}

/** Stopping for a deadline or a cancellation is not one file failing; it ends the run. */
function rethrowIfStopped(failure: unknown): void {
  if (failure instanceof DeadlineExceededError || failure instanceof OperationAbortedError) {
    throw failure;
  }
}

function reasonFor(error: CodeLensError): QuarantineReason {
  if (error instanceof SourceReadError) return 'unreadable';
  if (error.subsystem === 'syntax') return 'parse-failed';
  return 'extract-failed';
}
