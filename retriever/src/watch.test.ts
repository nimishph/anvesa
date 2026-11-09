import { describe, expect, it } from 'bun:test';
import type { IndexReport } from '@cntxt-labs/anvesa-indexer';
import type { Retriever } from './retriever.ts';
import { isWatchIgnored, type WatchEvent, watchProject } from './watch.ts';

describe('file watcher & debounced indexing (anvesa watch)', () => {
  describe('isWatchIgnored path rules', () => {
    it('ignores version control and system directories', () => {
      expect(isWatchIgnored('.git/HEAD')).toBe(true);
      expect(isWatchIgnored('.git/objects/123')).toBe(true);
      expect(isWatchIgnored('.anvesa/index.sqlite')).toBe(true);
      expect(isWatchIgnored('.sutra/cache.json')).toBe(true);
      expect(isWatchIgnored('.medha/workspace.json')).toBe(true);
      expect(isWatchIgnored('node_modules/bun/index.js')).toBe(true);
      expect(isWatchIgnored('dist/index.js')).toBe(true);
      expect(isWatchIgnored('target/debug/build')).toBe(true);
      expect(isWatchIgnored('out/main.js')).toBe(true);
      expect(isWatchIgnored('build/main.js')).toBe(true);
      expect(isWatchIgnored('__pycache__/mod.cpython-310.pyc')).toBe(true);
      expect(isWatchIgnored('.turbo/cache')).toBe(true);
      expect(isWatchIgnored('.next/server/pages')).toBe(true);
    });

    it('ignores temporary and swap files', () => {
      expect(isWatchIgnored('src/index.ts~')).toBe(true);
      expect(isWatchIgnored('src/index.ts.swp')).toBe(true);
      expect(isWatchIgnored('src/index.ts.tmp')).toBe(true);
      expect(isWatchIgnored('src/index.ts.bak')).toBe(true);
      expect(isWatchIgnored('src/.#index.ts')).toBe(true);
      expect(isWatchIgnored('src/.DS_Store')).toBe(true);
      expect(isWatchIgnored('Thumbs.db')).toBe(true);
    });

    it('allows valid code and document source paths', () => {
      expect(isWatchIgnored('src/index.ts')).toBe(false);
      expect(isWatchIgnored('lib/core/util.rs')).toBe(false);
      expect(isWatchIgnored('pkg/api/router.go')).toBe(false);
      expect(isWatchIgnored('README.md')).toBe(false);
      expect(isWatchIgnored('docs/design.txt')).toBe(false);
    });
  });

  describe('watchProject coordinator', () => {
    const dummyReport: IndexReport = {
      complete: true,
      resumedAfterInterruption: false,
      reextracted: false,
      files: {
        seen: 5,
        unchanged: 5,
        touched: 0,
        added: 0,
        modified: 0,
        quarantined: 0,
        stillQuarantined: 0,
        removed: 0,
        skippedLanguage: 0,
        unsupported: new Map(),
        outOfScope: 0,
        unreadable: [],
        ignored: 0,
      },
      quarantined: [],
      link: undefined,
      relinked: 0,
      dense: undefined,
      elapsedMs: 12,
    };

    it('runs initial index and reports ready', async () => {
      const events: WatchEvent[] = [];
      let indexCount = 0;

      const mockRetriever = {
        workspace: { root: '/test/workspace' },
        index: async () => {
          indexCount++;
          return { report: dummyReport, synced: [] };
        },
      } as unknown as Retriever;

      let listenerCallback: ((eventType: string, filename: string | null) => void) | undefined;
      let closed = false;

      const watcher = watchProject(mockRetriever, {
        debounceMs: 50,
        onEvent: (event) => events.push(event),
        watchFn: (_path, _options, listener) => {
          listenerCallback = listener;
          return {
            close: () => {
              closed = true;
            },
          };
        },
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(events.some((e) => e.kind === 'ready')).toBe(true);
      expect(events.some((e) => e.kind === 'index-complete' && e.trigger === 'initial')).toBe(true);
      expect(indexCount).toBe(1);
      expect(watcher.active).toBe(true);

      // Trigger a change
      listenerCallback?.('change', 'src/hello.ts');

      // Wait for debounce to fire
      await new Promise((r) => setTimeout(r, 80));

      expect(indexCount).toBe(2);
      expect(events.some((e) => e.kind === 'change-detected')).toBe(true);
      expect(events.some((e) => e.kind === 'index-complete' && e.trigger === 'change')).toBe(true);

      await watcher.close();
      expect(watcher.active).toBe(false);
      expect(closed).toBe(true);
      expect(events.some((e) => e.kind === 'closed')).toBe(true);
    });

    it('collapses rapid burst modifications into single debounced index run', async () => {
      let indexCount = 0;
      const mockRetriever = {
        workspace: { root: '/test/workspace' },
        index: async () => {
          indexCount++;
          return { report: dummyReport, synced: [] };
        },
      } as unknown as Retriever;

      let listenerCallback: ((eventType: string, filename: string | null) => void) | undefined;

      const watcher = watchProject(mockRetriever, {
        debounceMs: 60,
        initialIndex: false,
        watchFn: (_path, _options, listener) => {
          listenerCallback = listener;
          return { close: () => undefined };
        },
      });

      // Fire 5 file changes in rapid succession
      listenerCallback?.('change', 'src/a.ts');
      listenerCallback?.('change', 'src/b.ts');
      listenerCallback?.('change', 'src/c.ts');
      listenerCallback?.('change', 'src/d.ts');
      listenerCallback?.('change', 'src/e.ts');

      // Before debounce window
      expect(indexCount).toBe(0);

      // Wait for debounce window to fire
      await new Promise((r) => setTimeout(r, 100));

      // Must only index once for the entire batch
      expect(indexCount).toBe(1);

      await watcher.close();
    });

    it('exits after single index if once is true', async () => {
      let indexCount = 0;
      const mockRetriever = {
        workspace: { root: '/test/workspace' },
        index: async () => {
          indexCount++;
          return { report: dummyReport, synced: [] };
        },
      } as unknown as Retriever;

      const watcher = watchProject(mockRetriever, {
        once: true,
        initialIndex: true,
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(indexCount).toBe(1);
      expect(watcher.active).toBe(false);
    });

    it('aborts cleanly when signal is aborted', async () => {
      const controller = new AbortController();
      let closed = false;

      const mockRetriever = {
        workspace: { root: '/test/workspace' },
        index: async () => ({ report: dummyReport, synced: [] }),
      } as unknown as Retriever;

      const watcher = watchProject(mockRetriever, {
        initialIndex: false,
        signal: controller.signal,
        watchFn: () => ({
          close: () => {
            closed = true;
          },
        }),
      });

      expect(watcher.active).toBe(true);
      controller.abort();

      await new Promise((r) => setTimeout(r, 20));
      expect(watcher.active).toBe(false);
      expect(closed).toBe(true);
    });
  });
});
