import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidArgumentError, type Page } from '@sutras/code-lens-core';
import type { VectorStore } from '@sutras/code-lens-dense';
import {
  inputFile,
  MemoryVectorStore,
  makeCard,
  vectorStoreContract,
} from '@sutras/code-lens-dense';
import { FragmentAssigner, validateManifest } from '../fragments/manifest.ts';
import { cleanupTrees, makeTree } from '../test-support.ts';
import { indexStoreContract } from './index-store-contract.ts';
import { MemoryIndexStore } from './memory-index-store.ts';
import { ShardSet } from './shard-set.ts';
import {
  ShardedIndexStore,
  ShardedVectorStore,
  type ShardProvider,
  sourcePathOf,
} from './sharded.ts';
import type { EdgeRecord, IndexedFile, IndexStore } from './types.ts';

afterAll(cleanupTrees);

const kit = { describe, test, expect };

/** Paths the store contracts use, spread over three fragments so most tests cross shards. */
const manifest = validateManifest({
  manifestVersion: 1,
  algorithm: { id: 'test', version: 1 },
  fallback: 'root',
  fragments: {
    root: {},
    src: { roots: ['src'] },
    docs: { roots: ['docs'], files: ['b.md', 'b.ts', 'c.ts'] },
  },
});
const assigner = new FragmentAssigner(manifest);

function memoryShards<T>(make: () => T): ShardProvider<T> & { readonly made: Map<string, T> } {
  const made = new Map<string, T>();
  return {
    made,
    existing: () => [...made.keys()].sort(),
    get: (id) => {
      let held = made.get(id);
      if (!held) {
        held = make();
        made.set(id, held);
      }
      return held;
    },
  };
}

indexStoreContract(kit, 'sharded over memory stores', {
  make: () =>
    new ShardedIndexStore({
      assigner,
      shards: memoryShards<IndexStore>(() => new MemoryIndexStore()),
      meta: new MemoryIndexStore(),
    }),
});

const sets = new WeakMap<object, ShardSet>();
indexStoreContract(kit, 'sharded over sqlite files', {
  make: async () => {
    const set = await ShardSet.open({ directory: join(makeTree({}), 'shards'), manifest });
    sets.set(set.index, set);
    return set.index;
  },
});

vectorStoreContract(kit, 'sharded over memory stores', {
  make: () =>
    new ShardedVectorStore({
      assigner,
      shards: memoryShards<VectorStore>(() => new MemoryVectorStore()),
    }),
});
vectorStoreContract(kit, 'sharded over sqlite files', {
  make: async () => {
    const set = await ShardSet.open({ directory: join(makeTree({}), 'shards'), manifest });
    sets.set(set.vectors, set);
    return set.vectors;
  },
  dispose: async (store) => {
    await sets.get(store)?.close();
  },
});

const file = (path: string, over: Partial<IndexedFile> = {}): IndexedFile => ({
  path,
  language: 'typescript',
  packageRoot: undefined,
  repo: '',
  size: 10,
  mtimeMs: 1,
  contentHash: `hash-${path}`,
  facts: {
    path,
    language: 'typescript',
    symbols: [
      {
        id: `${path}#one`,
        path,
        name: 'one',
        baseName: 'one',
        kind: 'function',
        parentId: undefined,
        exported: true,
        startLine: 1,
        endLine: 2,
        signature: undefined,
        doc: undefined,
      },
      {
        id: `${path}#two`,
        path,
        name: 'two',
        baseName: 'two',
        kind: 'function',
        parentId: undefined,
        exported: false,
        startLine: 3,
        endLine: 4,
        signature: undefined,
        doc: undefined,
      },
    ],
    calls: [{ from: `${path}#one`, name: 'two', receiver: undefined, kind: 'call', line: 2 }],
    imports: [
      { specifier: './x', kind: 'static', relative: true, typeOnly: false, bindings: [], line: 1 },
    ],
    exports: [],
    hasSyntaxErrors: false,
    importsSupported: true,
    gaps: { unnamedCalls: 0, computedImports: 0 },
  },
  ...over,
});

async function everything<T>(read: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

describe('reading across shards gives what one store would', () => {
  // 30 files spread over three fragments, so every query interleaves them.
  const paths = [
    ...Array.from({ length: 12 }, (_, i) => `src/m${String(i).padStart(2, '0')}.ts`),
    ...Array.from({ length: 10 }, (_, i) => `docs/n${String(i).padStart(2, '0')}.md`),
    ...Array.from({ length: 8 }, (_, i) => `z${String(i).padStart(2, '0')}.ts`),
  ];

  async function pair() {
    const shards = memoryShards<IndexStore>(() => new MemoryIndexStore());
    const sharded = new ShardedIndexStore({ assigner, shards, meta: new MemoryIndexStore() });
    const single = new MemoryIndexStore();
    for (const path of paths) {
      const stored = file(path);
      await sharded.replaceFile(stored);
      await single.replaceFile(stored);
      const edges: EdgeRecord[] = [
        {
          from: `${path}#one`,
          to: `${paths[(paths.indexOf(path) + 1) % paths.length]}#two`,
          kind: 'calls',
        },
        { from: path, to: 'src/m00.ts', kind: 'imports' },
      ];
      await sharded.replaceEdges(path, edges);
      await single.replaceEdges(path, edges);
    }
    return { sharded, single, shards };
  }

  test('files, symbols, calls, imports and edges come in the same order, page by page', async () => {
    const { sharded, single, shards } = await pair();
    expect(shards.made.size).toBeGreaterThan(1);
    for (const size of [1, 4, 7, 100]) {
      expect(
        (
          await everything((cursor) =>
            sharded.files({ limit: size, ...(cursor ? { cursor } : {}) }),
          )
        ).map((f) => f.path),
      ).toEqual(
        (
          await everything((cursor) => single.files({ limit: size, ...(cursor ? { cursor } : {}) }))
        ).map((f) => f.path),
      );
    }
    const pageBy = <T>(
      store: IndexStore,
      read: (limit: number, cursor: string | undefined) => Promise<Page<T>>,
      limit: number,
    ) => everything((cursor) => read(limit, cursor)).then((items) => ({ items, store }));

    for (const limit of [5, 9]) {
      const symbols = await pageBy(
        sharded,
        (l, c) => sharded.findSymbols({ limit: l, ...(c ? { cursor: c } : {}) }),
        limit,
      );
      const expected = await pageBy(
        single,
        (l, c) => single.findSymbols({ limit: l, ...(c ? { cursor: c } : {}) }),
        limit,
      );
      expect(symbols.items.map((s) => s.id)).toEqual(expected.items.map((s) => s.id));
      expect(symbols.items).toHaveLength(paths.length * 2);

      const calls = await pageBy(
        sharded,
        (l, c) => sharded.findCalls({ limit: l, ...(c ? { cursor: c } : {}) }),
        limit,
      );
      expect(calls.items.map((x) => `${x.path}:${x.line}`)).toEqual(
        (
          await pageBy(
            single,
            (l, c) => single.findCalls({ limit: l, ...(c ? { cursor: c } : {}) }),
            limit,
          )
        ).items.map((x) => `${x.path}:${x.line}`),
      );
      const imports = await pageBy(
        sharded,
        (l, c) => sharded.findImports({ limit: l, ...(c ? { cursor: c } : {}) }),
        limit,
      );
      expect(imports.items.map((x) => x.path)).toEqual(paths.slice().sort());
      const edges = await pageBy(
        sharded,
        (l, c) => sharded.findEdges({ limit: l, ...(c ? { cursor: c } : {}) }),
        limit,
      );
      const expectedEdges = await pageBy(
        single,
        (l, c) => single.findEdges({ limit: l, ...(c ? { cursor: c } : {}) }),
        limit,
      );
      expect(edges.items.map((e) => `${e.from}>${e.to}:${e.kind}`).sort()).toEqual(
        expectedEdges.items.map((e) => `${e.from}>${e.to}:${e.kind}`).sort(),
      );
    }
  });

  test('the total is the sum over shards, and a page says whether it stopped short', async () => {
    const { sharded } = await pair();
    const first = await sharded.files({ limit: 7 });
    expect(first.total).toBe(paths.length);
    expect(first.items).toHaveLength(7);
    expect(first.nextCursor).not.toBeNull();
    expect(first.limit).toEqual({ name: 'limit', applied: 7, source: 'caller', reached: true });
    const all = await sharded.files({ limit: 100 });
    expect(all.nextCursor).toBeNull();
    expect(all.limit.reached).toBe(false);
  });

  test('a cursor keeps its place when the next page asks for a different size', async () => {
    const { sharded, single } = await pair();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (const limit of [3, 10, 1, 6, 4, 100]) {
      const page = await sharded.files({ limit, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((f) => f.path));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual((await single.files({ limit: 1000 })).items.map((f) => f.path));
  });

  test('a cursor that is not one is refused', async () => {
    const { sharded } = await pair();
    await expect(sharded.files({ cursor: 'nonsense' })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(
      sharded.files({ cursor: Buffer.from('{"v":2}').toString('base64url') }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  test('a query that names a file asks one shard; one that does not asks them all', async () => {
    const { sharded, shards } = await pair();
    const hit = await sharded.findSymbols({ path: 'docs/n03.md' });
    expect(hit.items.map((s) => s.name)).toEqual(['one', 'two']);
    expect(await sharded.facts('src/m01.ts')).toBeDefined();
    expect((await sharded.symbol('z02.ts#one'))?.path).toBe('z02.ts');
    expect(await sharded.symbol('nowhere.ts#one')).toBeUndefined();
    const stats = await sharded.stats();
    expect(stats.files).toBe(paths.length);
    expect(stats.symbols).toBe(paths.length * 2);
    expect(stats.byLanguage).toEqual([{ language: 'typescript', files: paths.length }]);
    expect(shards.made.has('docs')).toBe(true);
  });

  test('a file that sits in a shard the manifest no longer sends it to is still found and removed', async () => {
    const shards = memoryShards<IndexStore>(() => new MemoryIndexStore());
    const sharded = new ShardedIndexStore({ assigner, shards, meta: new MemoryIndexStore() });
    await shards.get('docs').replaceFile(file('src/strayed.ts'));
    await shards.get('src').replaceFile(file('src/here.ts'));
    expect(await sharded.fileState('src/strayed.ts')).toMatchObject({ path: 'src/strayed.ts' });
    expect(await sharded.facts('src/strayed.ts')).toBeDefined();
    expect(await sharded.removeFile('src/strayed.ts')).toBe(true);
    expect(await sharded.fileState('src/strayed.ts')).toBeUndefined();
    expect(await sharded.removeFile('src/strayed.ts')).toBe(false);
  });

  test('a graph node names its file: a path is itself, a symbol id is cut at the name', () => {
    expect(sourcePathOf('src/a.ts')).toBe('src/a.ts');
    expect(sourcePathOf('src/a.ts#Outer.run')).toBe('src/a.ts');
    expect(sourcePathOf('src/c#/x.ts#f')).toBe('src/c#/x.ts');
  });
});

describe('shards on disk follow the manifest', () => {
  const layout = (directory: string, roots: Record<string, string[]>) =>
    ShardSet.open({
      directory,
      manifest: validateManifest({
        manifestVersion: 1,
        algorithm: { id: 'test', version: 1 },
        fallback: 'root',
        fragments: {
          root: {},
          ...Object.fromEntries(Object.entries(roots).map(([id, r]) => [id, { roots: r }])),
        },
      }),
    });

  const card = (path: string, id: string) =>
    makeCard(
      {
        name: 'demo',
        version: '1',
        channel: 'demo',
        categoryId: 'custom.demo',
        categoryLabel: 'Demo',
        trust: 'third-party',
        claim: () => true,
        transform: () => [],
      },
      inputFile(path, 'x'),
      { key: id, text: `words ${id}` },
    );

  test('each fragment gets its own database, created when it first holds something', async () => {
    const dir = join(makeTree({}), 'shards');
    const set = await layout(dir, { a: ['a'], b: ['b'] });
    try {
      await set.index.replaceFile(file('a/x.ts'));
      await set.index.replaceFile(file('a/y.ts'));
      await set.index.replaceFile(file('b/z.ts'));
      expect(existsSync(join(dir, 'a.db'))).toBe(true);
      expect(existsSync(join(dir, 'b.db'))).toBe(true);
      expect(existsSync(join(dir, 'root.db'))).toBe(false);
      const drift = await set.drift();
      expect(drift.shards.map((s) => [s.id, s.files])).toEqual([
        ['a', 2],
        ['b', 1],
      ]);
      expect(drift.misplacedFiles).toEqual([]);
      expect(drift.orphanShards).toEqual([]);
      expect(await set.index.files({ limit: 10 }).then((p) => p.items.map((f) => f.path))).toEqual([
        'a/x.ts',
        'a/y.ts',
        'b/z.ts',
      ]);
    } finally {
      await set.close();
    }
  });

  test('the same files land in the same shards on two machines given the same manifest', async () => {
    const one = await layout(join(makeTree({}), 'shards'), { a: ['a'], b: ['b'] });
    const two = await layout(join(makeTree({}), 'shards'), { b: ['b'], a: ['a'] });
    try {
      for (const set of [one, two]) {
        for (const path of ['a/x.ts', 'b/y.ts', 'c.ts', 'a/deep/z.ts'])
          await set.index.replaceFile(file(path));
      }
      expect((await one.drift()).shards).toEqual((await two.drift()).shards);
      expect(one.manifestSha256).toBe(two.manifestSha256);
    } finally {
      await one.close();
      await two.close();
    }
  });

  test('a changed manifest leaves files behind; drift says which, and settling makes them be indexed again where they belong', async () => {
    const dir = join(makeTree({}), 'shards');
    const before = await layout(dir, { a: ['a'], b: ['b'] });
    for (const path of ['a/x.ts', 'a/y.ts', 'b/z.ts']) {
      await before.index.replaceFile(file(path));
      await before.vectors.replaceSource({
        channel: 'demo',
        path,
        model: 'm',
        contentHash: 'h',
        transformerVersion: '1',
        cards: [{ card: card(path, 'c1'), vector: Float32Array.from([1, 0, 0]) }],
        quarantined: [],
      });
    }
    await before.recordManifest();
    await before.close();

    // `a/y.ts` now belongs with b; fragment a is gone entirely; c is new.
    const after = await layout(dir, { b: ['b', 'a/y.ts'.replace('/y.ts', '')], c: ['c'] });
    try {
      expect(await after.needsSettling()).toBe(true);
      const drift = await after.drift(['demo']);
      expect(drift.manifestChanged).toBe(true);
      // Fragment a is gone, so its database has no owner: it is reported as such, and what is in it is
      // not counted as misplaced (nothing can be read from a shard that is not there to be read).
      expect(drift.misplacedFiles).toEqual([]);
      expect(drift.orphanShards).toEqual(['a']);

      const settled = await after.settle(['demo']);
      expect(settled).toMatchObject({ movedFiles: 0, removedShards: ['a'] });
      expect(existsSync(join(dir, 'a.db'))).toBe(false);
      expect(await after.needsSettling()).toBe(false);
      const clean = await after.drift(['demo']);
      expect(clean.manifestChanged).toBe(false);
      expect(clean.misplacedFiles).toEqual([]);
      // What was in the vanished shard is gone from every view, so a run indexes it afresh.
      expect((await after.index.files({ limit: 10 })).items.map((f) => f.path)).toEqual(['b/z.ts']);
      expect(await after.vectors.sourcePaths('demo')).toEqual(['b/z.ts']);
      await after.index.replaceFile(file('a/x.ts'));
      expect(await after.index.fileState('a/x.ts')).toBeDefined();
      expect((await after.drift()).shards.map((s) => s.id)).toEqual(['b']);
    } finally {
      await after.close();
    }
  });

  test('a file the manifest now sends elsewhere is forgotten in the shard it was left in', async () => {
    const dir = join(makeTree({}), 'shards');
    const before = await layout(dir, { a: ['a'], b: ['b'] });
    await before.index.replaceFile(file('a/x.ts'));
    await before.index.replaceFile(file('b/y.ts'));
    await before.vectors.replaceSource({
      channel: 'demo',
      path: 'a/x.ts',
      model: 'm',
      contentHash: 'h',
      transformerVersion: '1',
      cards: [{ card: card('a/x.ts', 'c1'), vector: Float32Array.from([1, 0]) }],
      quarantined: [],
    });
    await before.recordManifest();
    await before.close();

    // The manifest that moves a/x.ts into b.
    const moved = await ShardSet.open({
      directory: dir,
      manifest: validateManifest({
        manifestVersion: 1,
        algorithm: { id: 'test', version: 1 },
        fallback: 'root',
        fragments: { root: {}, a: { roots: ['a'] }, b: { roots: ['b'], files: ['a/x.ts'] } },
      }),
    });
    try {
      const drift = await moved.drift(['demo']);
      expect(drift.misplacedFiles).toEqual([{ path: 'a/x.ts', in: 'a', belongsIn: 'b' }]);
      expect(drift.misplacedSources).toEqual([
        { path: 'a/x.ts', in: 'a', belongsIn: 'b', channel: 'demo' },
      ]);
      const settled = await moved.settle(['demo']);
      expect(settled).toMatchObject({ movedFiles: 1, movedSources: 1, removedShards: [] });
      expect(await moved.index.fileState('a/x.ts')).toBeUndefined();
      expect(await moved.vectors.sourcePaths('demo')).toEqual([]);
      expect(await moved.index.fileState('b/y.ts')).toBeDefined();
    } finally {
      await moved.close();
    }
  });
});
