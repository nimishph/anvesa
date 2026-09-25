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
});
