import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Deadline, DeadlineExceededError, OperationAbortedError } from '@cntxt-labs/code-lens-core';
import {
  ChannelRegistry,
  createTransformServices,
  type Embedder,
  Ingester,
  MemoryVectorStore,
  symbolsTransformer,
} from '@cntxt-labs/code-lens-dense';
import {
  parseWExpr,
  StructuralEngine,
  WEXPR_FORMAT_VERSION,
} from '@cntxt-labs/code-lens-structural';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/code-lens-syntax';
import { FactExtractor } from '../extract/extract.ts';
import { EDGE } from '../graph/edges.ts';
import { MemoryIndexStore } from '../store/memory-index-store.ts';
import { SqliteIndexStore } from '../store/sqlite-index-store.ts';
import type { EdgeRecord, IndexStore } from '../store/types.ts';
import { cleanupTrees, makeTree } from '../test-support.ts';
import { defaultConfig } from '../workspace/config.ts';
import { Workspace } from '../workspace/workspace.ts';
import { Indexer, type IndexerOptions } from './indexer.ts';
import type { IndexReport } from './report.ts';

const runtimes: SyntaxRuntime[] = [];
afterAll(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  cleanupTrees();
});

function newRuntime(): SyntaxRuntime {
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  runtimes.push(runtime);
  return runtime;
}

/** Give every file in a tree an old modification time, so the racily-clean rule does not apply. */
function age(root: string, path = ''): void {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  for (const name of readdirSync(join(root, path))) {
    const relative = path === '' ? name : `${path}/${name}`;
    if (statSync(join(root, relative)).isDirectory()) age(root, relative);
    else utimesSync(join(root, relative), past, past);
  }
}

/** An extractor that counts, and can be told to fail. */
class CountingExtractor extends FactExtractor {
  extracted: string[] = [];
  failWith: ((path: string) => Error | undefined) | undefined;
  override async extractWithStructure(...args: Parameters<FactExtractor['extractWithStructure']>) {
    const failure = this.failWith?.(args[0]);
    if (failure) throw failure;
    this.extracted.push(args[0]);
    return super.extractWithStructure(...args);
  }
}

interface Setup {
  readonly root: string;
  readonly store: IndexStore;
  readonly extractor: CountingExtractor;
  readonly indexer: Indexer;
}

async function setup(
  files: Record<string, string>,
  options: Partial<IndexerOptions> & { store?: IndexStore; root?: string } = {},
): Promise<Setup> {
  const root = options.root ?? makeTree(files);
  if (!options.root) age(root);
  const workspace = await Workspace.open({ root, config: defaultConfig() });
  const store = options.store ?? new MemoryIndexStore();
  const extractor = new CountingExtractor(new StructuralEngine({ runtime: newRuntime() }));
  const indexer = new Indexer({ workspace, store, extractor, ...options });
  return { root, store, extractor, indexer };
}

/** Rewrite a file and keep its size, and age it again. */
function write(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  writeFileSync(absolute, text);
  const past = new Date(Date.now() - 30 * 60 * 1000);
  utimesSync(absolute, past, past);
}

async function edges(store: IndexStore): Promise<EdgeRecord[]> {
  const found: EdgeRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.findEdges(cursor === undefined ? {} : { cursor });
    found.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return found;
}

const accounted = (report: IndexReport): number =>
  report.files.unchanged +
  report.files.touched +
  report.files.added +
  report.files.modified +
  report.files.quarantined +
  report.files.stillQuarantined;

const project = {
  'package.json': '{"name":"app"}',
  'src/a.ts': "import { b } from './b';\nexport function a() { b(); }\n",
  'src/b.ts': "import { c } from './c';\nexport function b() { c(); }\n",
  'src/c.ts': 'export function c() {}\n',
  'src/lone.ts': 'export function lone() {}\n',
  'notes.txt': 'not source',
};

describe('a first run', () => {
  test('indexes everything, links it, and accounts for every file', async () => {
    const { indexer, store } = await setup(project);
    const report = await indexer.index();
    expect(report.files.added).toBe(4);
    expect(report.files.seen).toBe(4);
    expect(accounted(report)).toBe(report.files.seen);
    expect(report.files.unsupported.get('.txt')).toBe(1);
    expect(report.files.unsupported.get('.json')).toBe(1);
    expect(report.resumedAfterInterruption).toBe(false);
    expect(report.link?.imports.resolved).toBe(2);
    expect((await store.stats()).files).toBe(4);
    expect((await store.findEdges({ from: 'src/a.ts#a', kind: EDGE.calls })).items).toEqual([
      { from: 'src/a.ts#a', to: 'src/b.ts#b', kind: EDGE.calls },
    ]);
    expect(await store.getMeta('index.dirty')).toBeUndefined();
  });

  test('caches the outline of each file, without source offsets, for structural queries', async () => {
    const { indexer, store } = await setup(project);
    await indexer.index();
    const text = await store.wexpr('src/a.ts', WEXPR_FORMAT_VERSION);
    expect(text).toContain('(program');
    expect(text).toContain('name="a"');
    expect(text).not.toContain('startIndex');
    expect(parseWExpr(text as string).tag).toBe('program');
    expect(await store.wexpr('src/a.ts', WEXPR_FORMAT_VERSION + 1)).toBeUndefined();
  });

  test('reports progress as it goes', async () => {
    const { indexer } = await setup(project);
    const kinds: string[] = [];
    await indexer.index({ onEvent: (event) => kinds.push(event.kind) });
    expect(kinds[0]).toBe('started');
    expect(kinds.filter((kind) => kind === 'file')).toHaveLength(4);
    expect(kinds.at(-1)).toBe('finished');
  });
});

describe('a second run with nothing changed', () => {
  test('reads and parses nothing, and links nothing', async () => {
    const { indexer, extractor } = await setup(project);
    await indexer.index();
    extractor.extracted = [];
    const report = await indexer.index();
    expect(report.files.unchanged).toBe(4);
    expect(accounted(report)).toBe(report.files.seen);
    expect(extractor.extracted).toEqual([]);
    expect(report.link).toBeUndefined();
    expect(report.relinked).toBe(0);
  });
});

describe('when what facts are extracted with changes', () => {
  /** The same extractor under a different signature, as after a mapping or a version change. */
  class Changed extends CountingExtractor {
    override get signature(): string {
      return `changed-${super.signature}`;
    }
  }

  test('every file is read again, though none changed, and only once', async () => {
    const first = await setup(project);
    expect((await first.indexer.index()).reextracted).toBe(false);

    const workspace = await Workspace.open({ root: first.root, config: defaultConfig() });
    const extractor = new Changed(new StructuralEngine({ runtime: newRuntime() }));
    const indexer = new Indexer({ workspace, store: first.store, extractor });
    const report = await indexer.index();
    expect(report.reextracted).toBe(true);
    expect(extractor.extracted.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/lone.ts']);
    expect(report.link).toBeDefined();

    extractor.extracted = [];
    const again = await indexer.index();
    expect(again.reextracted).toBe(false);
    expect(extractor.extracted).toEqual([]);
  });

  test('an index made before the signature was recorded is read again once', async () => {
    const { indexer, extractor, store } = await setup(project);
    await indexer.index();
    await store.deleteMeta('index.extraction');
    extractor.extracted = [];
    const report = await indexer.index();
    expect(report.reextracted).toBe(true);
    expect(extractor.extracted).toHaveLength(4);
  });

  test('a scoped run does not stamp the index as current for the files it left alone', async () => {
    const first = await setup(project);
    await first.indexer.index();
    const workspace = await Workspace.open({ root: first.root, config: defaultConfig() });
    const extractor = new Changed(new StructuralEngine({ runtime: newRuntime() }));
    const indexer = new Indexer({ workspace, store: first.store, extractor });
    await indexer.index({ scope: (path) => path === 'src/c.ts' });
    extractor.extracted = [];
    expect((await indexer.index()).reextracted).toBe(true);
  });
});

describe('incremental runs', () => {
  test('a changed file is parsed again, and the files that depend on it are linked again', async () => {
    const { indexer, extractor, store, root } = await setup(project);
    await indexer.index();
    extractor.extracted = [];
    write(root, 'src/c.ts', 'export function c() {}\nexport function d() {}\n');
    const report = await indexer.index();

    expect(extractor.extracted).toEqual(['src/c.ts']);
    expect(report.files).toMatchObject({ modified: 1, unchanged: 3 });
    // c itself, b (imports c) and a (imports b, but only through b: not a re-exporter).
    expect(report.relinked).toBe(2);
    expect((await store.findSymbols({ path: 'src/c.ts' })).items.map((s) => s.name)).toEqual([
      'c',
      'd',
    ]);
  });

  test('a file rewritten with the same content is re-stamped, not parsed', async () => {
    const { indexer, extractor, root } = await setup(project);
    await indexer.index();
    extractor.extracted = [];
    write(root, 'src/lone.ts', project['src/lone.ts']);
    utimesSync(
      join(root, 'src/lone.ts'),
      new Date(Date.now() - 1000 * 60 * 20),
      new Date(Date.now() - 1000 * 60 * 20),
    );
    const report = await indexer.index();
    expect(report.files.touched).toBe(1);
    expect(extractor.extracted).toEqual([]);
    // The stamp is remembered, so the run after that does not even read it.
    const third = await indexer.index();
    expect(third.files.unchanged).toBe(4);
  });

  test('a deleted file is forgotten, and what imported it now dangles', async () => {
    const { indexer, store, root } = await setup(project);
    await indexer.index();
    rmSync(join(root, 'src/c.ts'));
    const report = await indexer.index();
    expect(report.files.removed).toBe(1);
    expect(await store.fileState('src/c.ts')).toBeUndefined();
    expect((await store.findEdges({ kind: EDGE.importsDangling })).items).toEqual([
      { from: 'src/b.ts', to: './c', kind: EDGE.importsDangling },
    ]);
  });

  test('a file that appears settles the imports that were dangling', async () => {
    const { 'src/c.ts': _c, ...withoutC } = project;
    const { indexer, store, root } = await setup(withoutC);
    await indexer.index();
    expect((await store.findEdges({ kind: EDGE.importsDangling })).items).toHaveLength(1);
    write(root, 'src/c.ts', 'export function c() {}\n');
    await indexer.index();
    expect((await store.findEdges({ kind: EDGE.importsDangling })).items).toEqual([]);
    expect((await store.findEdges({ from: 'src/b.ts#b', kind: EDGE.calls })).items).toHaveLength(1);
  });

  test('a scoped run touches only its scope and forgets nothing outside it', async () => {
    const { indexer, extractor, store, root } = await setup(project);
    await indexer.index();
    write(root, 'src/c.ts', 'export function c() { return 1; }\n');
    write(root, 'src/lone.ts', 'export function lone() { return 2; }\n');
    extractor.extracted = [];
    const report = await indexer.index({ scope: (path) => path === 'src/c.ts' });
    expect(extractor.extracted).toEqual(['src/c.ts']);
    expect(report.files.outOfScope).toBeGreaterThan(0);
    expect(report.files.removed).toBe(0);
    expect((await store.stats()).files).toBe(4);
  });

  test('the language filter leaves other files indexed, not forgotten', async () => {
    const both = { ...project, 'tool.py': 'def run():\n    pass\n' };
    const first = await setup(both);
    await first.indexer.index();
    const second = await setup(both, {
      root: first.root,
      store: first.store,
      only: ['typescript'],
    });
    const report = await second.indexer.index();
    expect(report.files.skippedLanguage).toBe(1);
    expect(report.files.removed).toBe(0);
    expect(await first.store.fileState('tool.py')).toBeDefined();
  });
});

describe('failure isolation', () => {
  test('a file that cannot be indexed is quarantined with the reason, and the rest carry on', async () => {
    const { indexer, store } = await setup({
      ...project,
      'bin.ts': 'export const x = 1;\0\0\0',
      'main.go': 'package main\nfunc main() {}\n',
    });
    const report = await indexer.index();
    const byPath = Object.fromEntries(report.quarantined.map((q) => [q.path, q.reason]));
    expect(byPath['bin.ts']).toBe('binary');
    expect(byPath['main.go']).toBe('parse-failed');
    expect(report.files.added).toBe(4);
    expect(accounted(report)).toBe(report.files.seen);
    expect((await store.quarantinedFiles()).items.map((q) => q.path)).toEqual([
      'bin.ts',
      'main.go',
    ]);
  });

  test('a quarantined file is left alone until it changes, or is retried on request', async () => {
    const { indexer, extractor, root } = await setup({ ...project, 'main.go': 'package main\n' });
    await indexer.index();
    const second = await indexer.index();
    expect(second.files.stillQuarantined).toBe(1);
    extractor.extracted = [];
    const retried = await indexer.index({ retryQuarantined: true });
    expect(retried.files.quarantined).toBe(1);
    expect(root).toBeDefined();
  });

  test('an extractor failure quarantines that file and clears its old facts', async () => {
    const { indexer, extractor, store, root } = await setup(project);
    await indexer.index();
    write(root, 'src/lone.ts', 'export function lone() { return 1; }\n');
    class ExtractorBroke extends Error {}
    extractor.failWith = (path) =>
      path === 'src/lone.ts' ? new ExtractorBroke('boom') : undefined;
    const report = await indexer.index();
    expect(report.quarantined).toMatchObject([{ path: 'src/lone.ts', reason: 'extract-failed' }]);
    expect(await store.facts('src/lone.ts')).toBeUndefined();
    expect((await store.fileState('src/lone.ts'))?.status).toBe('quarantined');
  });
});

describe('a run that is killed', () => {
  test('leaves the index consistent file by file, and the next run rebuilds what it cannot trust', async () => {
    const { indexer, extractor, store, root } = await setup(project);
    await indexer.index();
    write(root, 'src/c.ts', 'export function c() {}\nexport function d() {}\n');
    write(root, 'src/lone.ts', 'export function lone() { return 3; }\n');

    // The process dies while indexing the second changed file.
    let count = 0;
    extractor.failWith = () => (++count === 2 ? new OperationAbortedError('killed') : undefined);
    await expect(indexer.index()).rejects.toBeInstanceOf(OperationAbortedError);
    expect(await store.getMeta('index.dirty')).toBeDefined();
    // Whole files only: c was replaced completely, lone still has its old facts.
    expect((await store.findSymbols({ path: 'src/c.ts' })).items.map((s) => s.name)).toEqual([
      'c',
      'd',
    ]);

    extractor.failWith = undefined;
    const resumed = await indexer.index();
    expect(resumed.resumedAfterInterruption).toBe(true);
    expect(await store.getMeta('index.dirty')).toBeUndefined();

    // The result is what a clean run over the same tree gives.
    const clean = await setup({}, { root });
    await clean.indexer.index();
    expect(await edges(store)).toEqual(await edges(clean.store));
    expect(await store.stats()).toEqual(await clean.store.stats());
  });

  test('a deadline that has passed stops the run with its own error and leaves the marker', async () => {
    const { indexer, store } = await setup(project);
    const controller = new AbortController();
    controller.abort();
    await expect(
      indexer.index({ deadline: Deadline.of({ signal: controller.signal }) }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
    expect(await store.getMeta('index.dirty')).toBeDefined();
    const expired = await setup(project);
    const deadline = Deadline.of({ timeoutMs: 1 });
    await Bun.sleep(20);
    await expect(expired.indexer.index({ deadline })).rejects.toBeInstanceOf(DeadlineExceededError);
  });
});

describe('a file edited just after the previous run', () => {
  test('is read again, because its timestamp cannot be trusted yet', async () => {
    const { indexer, extractor, root } = await setup(project);
    await indexer.index();
    extractor.extracted = [];
    // Same size, and a modification time within the timestamp granularity of the last run.
    writeFileSync(join(root, 'src/lone.ts'), 'export function xone() {}\n');
    const report = await indexer.index();
    expect(extractor.extracted).toEqual(['src/lone.ts']);
    expect(report.files.modified).toBe(1);
  });
});

describe('on SQLite', () => {
  test('gives the same index as memory, and survives a reopen', async () => {
    const memory = await setup(project);
    await memory.indexer.index();
    const sqlite = await setup(project, { store: SqliteIndexStore.open(':memory:') });
    await sqlite.indexer.index();
    expect(await edges(sqlite.store)).toEqual(await edges(memory.store));
    expect(await sqlite.store.stats()).toEqual(await memory.store.stats());
    await sqlite.store.close();
  });
});

describe('with dense channels', () => {
  const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const embedder = (id: string): Embedder => ({
    info: { id, dimensions: 32, maxTokens: 512 },
    count: (text) => words(text).length,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(32);
        for (const word of words(text)) {
          let hash = 7;
          for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 32;
          vector[hash] = (vector[hash] as number) + 1;
        }
        if (vector.every((v) => v === 0)) vector[0] = 1;
        return vector;
      });
    },
  });

  function withDense(modelId = 'model-a') {
    const runtime = newRuntime();
    const registry = new ChannelRegistry([symbolsTransformer()]);
    const vectors = new MemoryVectorStore();
    const ingester = new Ingester({
      registry,
      embedder: embedder(modelId),
      store: vectors,
      services: createTransformServices(new StructuralEngine({ runtime })),
    });
    return { ingester, vectors };
  }

  test('changed files are embedded, unchanged ones are not touched, deleted ones lose their cards', async () => {
    const dense = withDense();
    const first = await setup(project, { ingester: dense.ingester });
    const report = await first.indexer.index();
    expect(report.dense?.ingested).toBe(4);
    expect((await dense.vectors.stats('symbols')).sources).toBe(4);

    const second = await first.indexer.index();
    expect(second.dense).toMatchObject({ ingested: 0, current: 0 });

    rmSync(join(first.root, 'src/lone.ts'));
    await first.indexer.index();
    expect((await dense.vectors.stats('symbols')).sources).toBe(3);
  });

  test('a different model makes every file’s cards stale, even though no file changed', async () => {
    const before = withDense('model-a');
    const first = await setup(project, { ingester: before.ingester });
    await first.indexer.index();

    const after = withDense('model-b');
    const store = first.store;
    const second = await setup({}, { root: first.root, store, ingester: after.ingester });
    const report = await second.indexer.index();
    expect(report.dense?.ingested).toBe(4);
    expect(second.extractor.extracted).toEqual([]);
    expect((await after.vectors.stats('symbols')).sources).toBe(4);
  });

  test('a quarantined file has no cards', async () => {
    const dense = withDense();
    const { indexer } = await setup(
      { ...project, 'bin.ts': 'x\0\0' },
      { ingester: dense.ingester },
    );
    await indexer.index();
    expect(await dense.vectors.sourceState('symbols', 'bin.ts')).toBeUndefined();
  });
});
