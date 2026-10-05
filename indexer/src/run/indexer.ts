import {
  type CodeLensError,
  Deadline,
  DeadlineExceededError,
  InvariantViolationError,
  OperationAbortedError,
  toCodeLensError,
} from '@cntxt-labs/anvesa-core';
import { type Ingester, inputFile } from '@cntxt-labs/anvesa-dense';
import {
  type CorpusAdapter,
  docblockAnnotationAdapter,
  routeEndpointAdapter,
  WEXPR_FORMAT_VERSION,
} from '@cntxt-labs/anvesa-structural';
import type { LanguageRegistry } from '@cntxt-labs/anvesa-syntax';
import { SourceReadError } from '../errors.ts';
import type { Extracted, FactExtractor, FileFacts } from '../extract/index.ts';
import {
  DiskEnvironment,
  type FileChange,
  GraphLinker,
  GraphQueries,
  ImportResolver,
  type LinkReport,
  summarize,
} from '../graph/index.ts';
import type { FileQuarantine, IndexStore, QuarantineReason } from '../store/index.ts';
import { readSource } from '../workspace/content.ts';
import { detectMinified } from '../workspace/minified.ts';
import { DOCUMENT_LANGUAGE, type SourceEntry, walkSources } from '../workspace/walk.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { DenseReport, IndexEvent, IndexReport } from './report.ts';

/** Set while a run is writing, cleared when it has finished. Found set, a run did not finish. */
const DIRTY_KEY = 'index.dirty';
/** What the dense channels were built with (transformer versions, model), after a complete run. */
const DENSE_KEY = 'dense.signature';
/** What the facts were extracted with (see `FactExtractor.signature`), after a complete run. */
const EXTRACTION_KEY = 'index.extraction';

/** When the previous run began, so files touched around then can be told from files left alone. */
const STARTED_KEY = 'index.lastStartMs';

/**
 * A file changed within this long of the previous run starting might have been changed again
 * without its timestamp moving: file systems record modification times coarsely, the worst of
 * them (FAT) to two seconds. Such a file is read and hashed rather than trusted to its stamp,
 * the same "racily clean" rule git applies to its index.
 */
const TIMESTAMP_GRANULARITY_MS = 2000;

/**
 * A window of the walk is read and extracted together. Enough files to keep every core busy; few
 * enough bytes that the two windows held at once stay small.
 */
const WINDOW_FILES = 64;
const WINDOW_BYTES = 8 * 1024 * 1024;

type SourceText = Extract<Awaited<ReturnType<typeof readSource>>, { kind: 'text' }>;

/** What a file needs, decided from reads alone, before anything is written. */
type Prepared =
  | { readonly entry: SourceEntry; readonly kind: 'skip-language' }
  | { readonly entry: SourceEntry; readonly kind: 'unchanged'; readonly indexed: boolean }
  | { readonly entry: SourceEntry; readonly kind: 'unreadable'; readonly failure: unknown }
  | { readonly entry: SourceEntry; readonly kind: 'binary' }
  | {
      readonly entry: SourceEntry;
      readonly kind: 'minified';
      readonly reason: string;
      readonly hash: string;
    }
  | { readonly entry: SourceEntry; readonly kind: 'touch'; readonly content: SourceText }
  | {
      readonly entry: SourceEntry;
      readonly kind: 'extract';
      readonly wasIndexed: boolean;
      readonly content: SourceText;
      readonly outcome?: { readonly extracted: Extracted } | { readonly failure: unknown };
    };

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
  readonly corpora?: readonly CorpusAdapter[];
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
  readonly #corpora: readonly CorpusAdapter[];
  readonly #only: ReadonlySet<string> | undefined;

  constructor(options: IndexerOptions) {
    this.#workspace = options.workspace;
    this.#store = options.store;
    this.#extractor = options.extractor;
    this.#ingester = options.ingester;
    this.#languages = options.languages;
    this.#corpora = options.corpora ?? [docblockAnnotationAdapter, routeEndpointAdapter];
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
    // A different extractor or mapping than the one that made the stored facts: read every file again.
    const previousExtraction = await this.#store.getMeta(EXTRACTION_KEY);
    const extraction = this.#extractor.signature;
    const reextracted =
      previousExtraction === extraction
        ? false
        : previousExtraction !== undefined || (await this.#store.stats()).files > 0;
    const rebuildEverything = options.force === true || reextracted;

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
    const warnings: string[] = [];
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

    // The files' writes reach the disk together, every fraction of a second, not one commit each.
    // Each file still lands whole or not at all; a run cut short commits what it finished.
    const endGroup = this.#store.groupWrites?.();
    let link: LinkReport[] | undefined;
    try {
      // Files go through in windows. A window is read and its facts extracted (on every core,
      // away from this thread) while the window before it is written, so reading, parsing and
      // writing overlap. Everything a file changes in the index, and every event and count, is
      // still applied one file at a time in the order of the walk.
      const prepare = async (entry: SourceEntry): Promise<Prepared> => {
        deadline.throwIfExpired(`index ${entry.path}`);
        if (this.#only && entry.language !== DOCUMENT_LANGUAGE && !this.#only.has(entry.language)) {
          return { entry, kind: 'skip-language' };
        }
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
          return { entry, kind: 'unchanged', indexed: state.status === 'indexed' };
        }

        let content: Awaited<ReturnType<typeof readSource>>;
        try {
          content = await readSource(this.#workspace.root, entry.path, { deadline });
        } catch (failure) {
          rethrowIfStopped(failure);
          return { entry, kind: 'unreadable', failure };
        }
        if (content.kind === 'binary') return { entry, kind: 'binary' };

        const minified = detectMinified(entry.path, content.content, entry.size);
        if (minified.isMinified) {
          return {
            entry,
            kind: 'minified',
            reason: minified.reason ?? 'the file appears to be a minified bundle or generated code',
            hash: content.hash,
          };
        }
        const unchangedContent =
          state?.status === 'indexed' && state.contentHash === content.hash && !rebuildEverything;
        if (unchangedContent) return { entry, kind: 'touch', content };
        return { entry, kind: 'extract', wasIndexed: state?.status === 'indexed', content };
      };

      const prepareWindow = async (entries: readonly SourceEntry[]): Promise<Prepared[]> => {
        const prepared = await Promise.all(entries.map(prepare));
        const code = prepared.filter(
          (p): p is Extract<Prepared, { kind: 'extract' }> =>
            p.kind === 'extract' && p.entry.language !== DOCUMENT_LANGUAGE,
        );
        if (code.length === 0) return prepared;
        const outcomes = await this.#extractor.extractManyWithStructure(
          code.map((p) => ({ path: p.entry.path, source: p.content.content })),
          { deadline },
        );
        const byPath = new Map(code.map((p, index) => [p.entry.path, outcomes[index]]));
        return prepared.map((p) => {
          const outcome = byPath.get(p.entry.path);
          return p.kind === 'extract' && outcome !== undefined ? { ...p, outcome } : p;
        });
      };

      const apply = async (prepared: Prepared): Promise<void> => {
        const entry = prepared.entry;
        deadline.throwIfExpired(`index ${entry.path}`);
        // Offered by the walk, whether or not this run looks at it, so it is not taken for gone.
        offered.add(entry.path);
        if (prepared.kind === 'skip-language') {
          counts.skippedLanguage += 1;
          return;
        }
        seen.add(entry.path);
        let content: SourceText;
        switch (prepared.kind) {
          case 'unchanged':
            if (prepared.indexed) counts.unchanged += 1;
            else counts.stillQuarantined += 1;
            emit({ kind: 'file', path: entry.path, outcome: 'unchanged' });
            return;
          case 'unreadable': {
            const error = toCodeLensError(prepared.failure, `read ${entry.path}`);
            await this.#quarantine(entry, error, undefined, changes, counts, quarantined, emit);
            return;
          }
          case 'binary':
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
            return;
          case 'minified':
            await this.#quarantineWith(
              entry,
              'minified',
              prepared.reason,
              undefined,
              prepared.hash,
              changes,
              counts,
              quarantined,
              emit,
            );
            return;
          case 'touch':
            content = prepared.content;
            // Same bytes, new timestamp: remember the timestamp so the next run can skip the read.
            await this.#store.touchFile(entry.path, entry.size, entry.mtimeMs);
            counts.touched += 1;
            emit({ kind: 'file', path: entry.path, outcome: 'touched' });
            break;
          case 'extract': {
            content = prepared.content;
            try {
              const { facts, wexpr } = extractedOf(prepared);
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
              if (entry.size > 1024 * 1024) {
                const sizeMb = (entry.size / (1024 * 1024)).toFixed(1);
                const warning = `outlier: ${entry.path} is ${sizeMb} MB (> 1 MB); large source files may slow indexing`;
                warnings.push(warning);
                emit({ kind: 'warning', message: warning });
              } else if (facts.symbols.length > 2000) {
                const warning = `outlier: ${entry.path} defines ${facts.symbols.length} symbols (> 2,000); dense symbol files may indicate generated code`;
                warnings.push(warning);
                emit({ kind: 'warning', message: warning });
              }
              if (this.#corpora.length > 0) {
                const claimCtx = {
                  path: entry.path,
                  content: content.content,
                  lang: entry.language,
                };
                const records: import('../store/index.ts').StoredCorpusRecord[] = [];
                for (const corpus of this.#corpora) {
                  if (corpus.claim(claimCtx)) {
                    const extracted = corpus.extract({ ...claimCtx, wexpr });
                    for (const rec of extracted) {
                      records.push({
                        corpus: corpus.name,
                        id: rec.id,
                        path: rec.path,
                        attrs: rec.attrs,
                        text: rec.text,
                      });
                    }
                  }
                }
                if (records.length > 0) {
                  await this.#store.putCorpusRecords(records);
                }
              }
            } catch (failure) {
              rethrowIfStopped(failure);
              const error = toCodeLensError(failure, `index ${entry.path}`);
              await this.#quarantine(
                entry,
                error,
                content.hash,
                changes,
                counts,
                quarantined,
                emit,
              );
              await this.#dropCards(entry.path);
              return;
            }
            const outcome = prepared.wasIndexed ? 'modified' : 'added';
            counts[outcome] += 1;
            changes.set(entry.path, outcome === 'added' ? 'added' : 'modified');
            emit({ kind: 'file', path: entry.path, outcome });
            break;
          }
        }

        if (this.#ingester) {
          await this.#ingest(entry.path, content.content, entry.language, dense, {
            deadline,
            force: options.force === true,
          });
        }
      };

      // A window still being prepared holds its outcome, failure included, until it is drained: a
      // failure is raised in the order of the walk, after every file before it has been applied.
      type Settled = { readonly prepared: Prepared[] } | { readonly failure: unknown };
      let window: SourceEntry[] = [];
      let windowBytes = 0;
      let inFlight: Promise<Settled> | undefined;
      const launch = (): Promise<Settled> => {
        const next = prepareWindow(window).then(
          (prepared): Settled => ({ prepared }),
          (failure): Settled => ({ failure }),
        );
        window = [];
        windowBytes = 0;
        return next;
      };
      const drain = async (pending: Promise<Settled>): Promise<void> => {
        const settled = await pending;
        if ('failure' in settled) throw settled.failure;
        for (const prepared of settled.prepared) await apply(prepared);
      };
      for await (const entry of walk) {
        window.push(entry);
        windowBytes += entry.size;
        if (window.length >= WINDOW_FILES || windowBytes >= WINDOW_BYTES) {
          const next = launch();
          if (inFlight) await drain(inFlight);
          inFlight = next;
        }
      }
      const last = window.length > 0 ? launch() : undefined;
      if (inFlight) await drain(inFlight);
      if (last) await drain(last);

      if (wholeWorkspace) {
        await this.#prune(offered, changes, counts);
      }

      link = await this.#link(changes, interrupted || rebuildEverything, deadline, emit);
    } finally {
      endGroup?.();
    }

    if (this.#ingester && signature !== undefined) await this.#store.setMeta(DENSE_KEY, signature);
    if (wholeWorkspace && this.#only === undefined) {
      await this.#store.setMeta(EXTRACTION_KEY, extraction);
    }
    await this.#store.deleteMeta(DIRTY_KEY);

    const summary = walk.summary;
    const report: IndexReport = {
      complete: true,
      resumedAfterInterruption: interrupted,
      reextracted,
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
      ...(warnings.length > 0 ? { warnings } : {}),
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

/** A file's facts: a document has none to read; code has what extraction gave, or what it threw. */
function extractedOf(prepared: Extract<Prepared, { kind: 'extract' }>): Extracted {
  if (prepared.entry.language === DOCUMENT_LANGUAGE) return documentFacts(prepared.entry.path);
  const outcome = prepared.outcome;
  if (outcome === undefined) {
    throw new InvariantViolationError(`${prepared.entry.path} was read but never extracted`);
  }
  if ('failure' in outcome) throw outcome.failure;
  return outcome.extracted;
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
