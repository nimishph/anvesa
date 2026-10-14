import { watch } from 'node:fs';
import {
  type CodeLensError,
  OperationAbortedError,
  toCodeLensError,
} from '@cntxt-labs/anvesa-core';
import type { IndexReport, RunOptions } from '@cntxt-labs/anvesa-indexer';

export interface WatchTarget {
  readonly workspace: { readonly root: string };
  index(options?: RunOptions): Promise<{ readonly report: IndexReport }>;
}

export const DEFAULT_WATCH_DEBOUNCE_MS = 300;

export const DEFAULT_WATCH_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.anvesa',
  '.sutra',
  '.medha',
  'node_modules',
  'dist',
  'target',
  'out',
  'build',
  '__pycache__',
  '.turbo',
  '.next',
  '.nuxt',
]);

/** Checks whether a path relative to the workspace root should be ignored by the file watcher. */
export function isWatchIgnored(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.?\//, '');
  if (!normalized) return true;
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (DEFAULT_WATCH_IGNORED_SEGMENTS.has(seg)) return true;
  }
  const filename = segments.at(-1) ?? '';
  if (
    filename.endsWith('~') ||
    filename.endsWith('.swp') ||
    filename.endsWith('.tmp') ||
    filename.endsWith('.bak') ||
    filename.startsWith('.#') ||
    filename === '.DS_Store' ||
    filename === 'Thumbs.db'
  ) {
    return true;
  }
  return false;
}

export type WatchEvent =
  | { readonly kind: 'ready'; readonly root: string; readonly debounceMs: number }
  | { readonly kind: 'change-detected'; readonly paths: readonly string[] }
  | {
      readonly kind: 'index-start';
      readonly trigger: 'initial' | 'change';
      readonly paths?: readonly string[];
    }
  | {
      readonly kind: 'index-complete';
      readonly trigger: 'initial' | 'change';
      readonly report: IndexReport;
      readonly elapsedMs: number;
    }
  | { readonly kind: 'index-error'; readonly error: CodeLensError }
  | { readonly kind: 'closed' };

export interface WatchOptions {
  /** Debounce window in milliseconds. Defaults to 300ms. */
  readonly debounceMs?: number;
  /** Run an initial index pass when starting. Defaults to true. */
  readonly initialIndex?: boolean;
  /** Force re-indexing all files on initial pass. Defaults to false. */
  readonly force?: boolean;
  /** Filter to only index files matching this scope. */
  readonly scope?: (path: string) => boolean;
  /** Event callback for watch and indexing events. */
  readonly onEvent?: (event: WatchEvent) => void;
  /** Abort signal for graceful cancellation. */
  readonly signal?: AbortSignal;
  /** Exit after the first index pass completes. */
  readonly once?: boolean;
  /** Custom fs.watch implementation (for unit testing/mocking). */
  readonly watchFn?: (
    path: string,
    options: { recursive?: boolean; signal?: AbortSignal },
    listener: (eventType: string, filename: string | null) => void,
  ) => { close: () => void };
}

export interface ProjectWatcher {
  readonly root: string;
  readonly active: boolean;
  close(): Promise<void>;
  waitForNextIndex(): Promise<IndexReport>;
}

class ActiveProjectWatcher implements ProjectWatcher {
  readonly root: string;
  private isWatcherActive = true;
  private isIndexing = false;
  private hasPendingReindex = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changedPaths = new Set<string>();
  private readonly indexWaiters: Array<{
    resolve: (report: IndexReport) => void;
    reject: (error: Error) => void;
  }> = [];
  private fsWatcher: { close: () => void } | undefined;
  private inFlightIndex: Promise<void> | undefined;

  constructor(
    private readonly target: WatchTarget,
    private readonly options: WatchOptions,
  ) {
    this.root = target.workspace.root;
  }

  get active(): boolean {
    return this.isWatcherActive;
  }

  async start(): Promise<void> {
    const debounceMs = this.options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    const emit = this.options.onEvent ?? (() => undefined);

    if (this.options.signal?.aborted) {
      await this.close();
      return;
    }

    if (this.options.signal) {
      this.options.signal.addEventListener('abort', () => {
        void this.close();
      });
    }

    // 1. Initial index pass (unless disabled)
    if (this.options.initialIndex !== false) {
      emit({ kind: 'ready', root: this.root, debounceMs });
      await this.runIndex('initial');
      if (this.options.once || !this.isWatcherActive) {
        await this.close();
        return;
      }
    } else {
      emit({ kind: 'ready', root: this.root, debounceMs });
    }

    // 2. Start file system watcher
    try {
      const watchFunc = this.options.watchFn ?? watch;
      this.fsWatcher = watchFunc(
        this.root,
        { recursive: true, ...(this.options.signal ? { signal: this.options.signal } : {}) },
        (_eventType: string, filename: string | null) => {
          this.handleFsEvent(filename);
        },
      );
    } catch (failure) {
      const err = toCodeLensError(failure, `watch ${this.root}`);
      emit({ kind: 'index-error', error: err });
      await this.close();
    }
  }

  private handleFsEvent(filename: string | null): void {
    if (!this.isWatcherActive || !filename) return;
    const normalized = filename.replaceAll('\\', '/').replace(/^\.?\//, '');
    if (isWatchIgnored(normalized)) return;
    if (this.options.scope && !this.options.scope(normalized)) return;

    this.changedPaths.add(normalized);
    const emit = this.options.onEvent ?? (() => undefined);
    emit({ kind: 'change-detected', paths: [normalized] });

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const debounceMs = this.options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.debounceTimer = setTimeout(() => {
      this.onDebounceFired();
    }, debounceMs);
  }

  private onDebounceFired(): void {
    if (!this.isWatcherActive) return;
    if (this.isIndexing) {
      this.hasPendingReindex = true;
      return;
    }
    const batch = [...this.changedPaths];
    this.changedPaths.clear();
    void this.runIndex('change', batch);
  }

  private async runIndex(
    trigger: 'initial' | 'change',
    paths?: readonly string[],
  ): Promise<IndexReport | undefined> {
    if (!this.isWatcherActive && trigger !== 'initial') return undefined;
    this.isIndexing = true;
    const emit = this.options.onEvent ?? (() => undefined);
    emit({ kind: 'index-start', trigger, ...(paths ? { paths } : {}) });

    const started = performance.now();
    try {
      const task = this.target.index({
        ...(this.options.scope ? { scope: this.options.scope } : {}),
        ...(trigger === 'initial' && this.options.force ? { force: true } : {}),
      });
      this.inFlightIndex = task.then(() => undefined);
      const { report } = await task;
      const elapsedMs = performance.now() - started;

      emit({ kind: 'index-complete', trigger, report, elapsedMs });

      const waiters = this.indexWaiters.splice(0, this.indexWaiters.length);
      for (const waiter of waiters) {
        waiter.resolve(report);
      }

      if (this.options.once && trigger === 'change') {
        await this.close();
      }

      return report;
    } catch (failure) {
      const error = toCodeLensError(failure, `index during watch (${trigger})`);
      emit({ kind: 'index-error', error });

      const waiters = this.indexWaiters.splice(0, this.indexWaiters.length);
      for (const waiter of waiters) {
        waiter.reject(error);
      }
      return undefined;
    } finally {
      this.isIndexing = false;
      this.inFlightIndex = undefined;
      if (this.isWatcherActive && this.hasPendingReindex) {
        this.hasPendingReindex = false;
        const debounceMs = this.options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
        this.debounceTimer = setTimeout(() => {
          this.onDebounceFired();
        }, debounceMs);
      }
    }
  }

  waitForNextIndex(): Promise<IndexReport> {
    if (!this.isWatcherActive) {
      return Promise.reject(
        new OperationAbortedError('waitForNextIndex', { hint: 'Watcher is already closed' }),
      );
    }
    return new Promise<IndexReport>((resolve, reject) => {
      this.indexWaiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (!this.isWatcherActive) return;
    this.isWatcherActive = false;
    const emit = this.options.onEvent ?? (() => undefined);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch (failure) {
        emit({ kind: 'index-error', error: toCodeLensError(failure, 'close fsWatcher') });
      }
      this.fsWatcher = undefined;
    }

    if (this.inFlightIndex) {
      try {
        await this.inFlightIndex;
      } catch (failure) {
        emit({ kind: 'index-error', error: toCodeLensError(failure, 'await inFlightIndex') });
      }
    }

    const waiters = this.indexWaiters.splice(0, this.indexWaiters.length);
    for (const waiter of waiters) {
      waiter.reject(new OperationAbortedError('waitForNextIndex', { hint: 'Watcher closed' }));
    }

    emit({ kind: 'closed' });
  }
}

/**
 * Watches the workspace directory for file changes and triggers incremental indexing.
 */
export function watchProject(target: WatchTarget, options: WatchOptions = {}): ProjectWatcher {
  const watcher = new ActiveProjectWatcher(target, options);
  void watcher.start();
  return watcher;
}
