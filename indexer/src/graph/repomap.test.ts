import { describe, expect, test } from 'bun:test';
import type { FileFacts, SymbolFact } from '../extract/facts.ts';
import { MemoryIndexStore } from '../store/index.ts';
import { computeGraphPageRank, generateRepoMap } from './repomap.ts';

describe('GraphPageRank', () => {
  test('ranks nodes by in-degree and transitive influence', () => {
    // A -> B -> C, and D -> C
    // C should have the highest rank
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'D', to: 'C' },
    ];
    const ranks = computeGraphPageRank(['A', 'B', 'C', 'D'], edges);

    const rankA = ranks.get('A') ?? 0;
    const rankB = ranks.get('B') ?? 0;
    const rankC = ranks.get('C') ?? 0;
    expect(rankC).toBeGreaterThan(rankA);
    expect(rankC).toBeGreaterThan(rankB);
    expect(rankC).toBe(1.0); // Normalized max
  });
});

function symFact(props: {
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
}): SymbolFact {
  const path = props.id.split('#')[0] ?? '';
  return {
    path,
    baseName: props.name.split('.').pop() ?? props.name,
    parentId: undefined,
    exported: true,
    signature: undefined,
    doc: undefined,
    ...props,
  };
}

function makeFacts(path: string, symbols: SymbolFact[]): FileFacts {
  return {
    path,
    language: 'typescript',
    symbols,
    calls: [],
    imports: [],
    exports: [],
    hasSyntaxErrors: false,
    importsSupported: true,
    gaps: { unnamedCalls: 0, computedImports: 0 },
  };
}

describe('generateRepoMap', () => {
  test('builds hierarchical tree with symbols and ranks', async () => {
    const store = new MemoryIndexStore();

    await store.replaceFile({
      path: 'src/core/engine.ts',
      language: 'typescript',
      packageRoot: undefined,
      repo: '',
      size: 100,
      mtimeMs: 1,
      contentHash: 'h1',
      facts: makeFacts('src/core/engine.ts', [
        symFact({
          id: 'src/core/engine.ts#Engine',
          name: 'Engine',
          kind: 'class',
          startLine: 10,
          endLine: 50,
        }),
        symFact({
          id: 'src/core/engine.ts#run',
          name: 'run',
          kind: 'function',
          startLine: 60,
          endLine: 80,
          signature: 'run(): void',
        }),
      ]),
    });

    await store.replaceFile({
      path: 'src/index.ts',
      language: 'typescript',
      packageRoot: undefined,
      repo: '',
      size: 50,
      mtimeMs: 1,
      contentHash: 'h2',
      facts: makeFacts('src/index.ts', [
        symFact({
          id: 'src/index.ts#main',
          name: 'main',
          kind: 'function',
          startLine: 1,
          endLine: 10,
        }),
      ]),
    });

    // src/index.ts calls Engine.run
    await store.replaceEdges('src/index.ts', [
      {
        from: 'src/index.ts#main',
        to: 'src/core/engine.ts#run',
        kind: 'calls',
      },
      {
        from: 'src/index.ts',
        to: 'src/core/engine.ts',
        kind: 'imports',
      },
    ]);

    const result = await generateRepoMap(store);
    expect(result.totalFiles).toBe(2);
    expect(result.totalSymbols).toBe(3);

    // engine.ts should have higher score than index.ts because it is called and imported
    const engineFile = result.files.find((f) => f.path === 'src/core/engine.ts');
    const indexFile = result.files.find((f) => f.path === 'src/index.ts');
    expect(engineFile).toBeDefined();
    expect(indexFile).toBeDefined();
    if (engineFile && indexFile) {
      expect(engineFile.score).toBeGreaterThan(indexFile.score);
      expect(engineFile.importers).toBe(1);

      const runSymbol = engineFile.symbols.find((s) => s.name === 'run');
      expect(runSymbol).toBeDefined();
      if (runSymbol) {
        expect(runSymbol.callers).toBe(1);
      }
    }

    // Tree structure
    expect(result.tree.children).toBeDefined();
    const srcDir = result.tree.children?.find((c) => c.name === 'src');
    expect(srcDir).toBeDefined();
    expect(srcDir?.isDir).toBe(true);
  });

  describe('budget, scope and depth (#51)', () => {
    /** `count` files under src/pkg/, each with a few symbols, the first one imported by all. */
    async function storeOf(count: number): Promise<MemoryIndexStore> {
      const store = new MemoryIndexStore();
      for (let i = 0; i < count; i++) {
        const path = `src/pkg/file${i}.ts`;
        await store.replaceFile({
          path,
          language: 'typescript',
          packageRoot: undefined,
          repo: '',
          size: 10,
          mtimeMs: 1,
          contentHash: `h${i}`,
          facts: makeFacts(
            path,
            [0, 1, 2].map((s) =>
              symFact({
                id: `${path}#fn${s}`,
                name: `functionNumber${s}`,
                kind: 'function',
                startLine: s * 10 + 1,
                endLine: s * 10 + 5,
              }),
            ),
          ),
        });
        if (i > 0) {
          await store.replaceEdges(path, [{ from: path, to: 'src/pkg/file0.ts', kind: 'imports' }]);
        }
      }
      return store;
    }

    test('a budget keeps the highest-ranked files and says how many it left out', async () => {
      const store = await storeOf(30);
      const whole = await generateRepoMap(store);
      expect(whole.budget).toBeUndefined();
      expect(whole.files).toHaveLength(30);

      const cut = await generateRepoMap(store, { budget: 200 });
      expect(cut.budget?.tokens).toBe(200);
      expect(cut.budget?.used).toBeLessThanOrEqual(200);
      expect(cut.budget?.shownFiles).toBe(cut.files.length);
      expect((cut.budget?.shownFiles ?? 0) + (cut.budget?.omittedFiles ?? 0)).toBe(30);
      expect(cut.budget?.omittedFiles).toBeGreaterThan(0);
      // The most central file is kept first.
      expect(cut.files[0]?.path).toBe('src/pkg/file0.ts');
      expect(cut.totalFiles).toBe(30);
    });

    test('a directory with no indexed files is an error, not an empty map', async () => {
      const store = await storeOf(2);
      await expect(generateRepoMap(store, { scope: 'nonexistent/dir' })).rejects.toThrow(
        /nonexistent\/dir/,
      );
    });

    test('--depth counts from the directory asked for', async () => {
      const store = await storeOf(2);
      const scoped = await generateRepoMap(store, { scope: 'src/pkg', depth: 1 });
      const pkg = scoped.tree.children?.[0]?.children?.[0];
      expect(pkg?.path).toBe('src/pkg');
      expect(pkg?.children?.map((child) => child.name).sort()).toEqual(['file0.ts', 'file1.ts']);
    });
  });
});
