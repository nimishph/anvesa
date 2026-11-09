import { describe, expect, test } from 'bun:test';
import { WEXPR_FORMAT_VERSION } from '@cntxt-labs/anvesa-structural';
import type { SymbolFact } from '../../extract/facts.ts';
import { MemoryIndexStore } from '../../store/index.ts';
import type { IndexedFile } from '../../store/types.ts';
import { SCIP_ROLE, type ScipDocument } from './decode.ts';
import { applyScipOverlay } from './overlay.ts';

const symbol = (
  path: string,
  name: string,
  startLine: number,
  endLine: number,
  kind = 'function',
): SymbolFact => ({
  id: `${path}#${name}`,
  path,
  name,
  baseName: name.split('.').at(-1) as string,
  kind,
  parentId: undefined,
  exported: true,
  startLine,
  endLine,
  signature: `${name}()`,
  doc: undefined,
});

function file(path: string, symbols: SymbolFact[], wexpr: string): IndexedFile {
  return {
    path,
    language: 'typescript',
    packageRoot: undefined,
    repo: '',
    size: 100,
    mtimeMs: 1000,
    contentHash: `hash-${path}`,
    facts: {
      path,
      language: 'typescript',
      symbols,
      calls: [],
      imports: [],
      exports: [],
      hasSyntaxErrors: false,
      importsSupported: true,
      gaps: { unnamedCalls: 0, computedImports: 0 },
    },
    wexpr: { formatVersion: WEXPR_FORMAT_VERSION, text: wexpr },
  };
}

const sym = (descriptor: string) => `scip-typescript npm shop 1.0.0 ${descriptor}`;
const ADD = sym('src/`cart.ts`/addItem().');
const CART = sym('src/`types.ts`/Cart#');

// src/cart.ts:  1-3 addItem.  src/types.ts: 1 Cart.  src/page.tsx: 1 import, 3-6 Page (calls addItem, names Cart).
const documents: ScipDocument[] = [
  {
    path: 'src/cart.ts',
    occurrences: [{ range: [0, 16, 23], symbol: ADD, roles: SCIP_ROLE.definition }],
    symbols: [],
  },
  {
    path: 'src/types.ts',
    occurrences: [{ range: [0, 12, 16], symbol: CART, roles: SCIP_ROLE.definition }],
    symbols: [],
  },
  {
    path: 'src/page.tsx',
    occurrences: [
      { range: [0, 9, 16], symbol: ADD, roles: 0 }, // the import: no import role, as scip-typescript writes it
      { range: [3, 2, 9], symbol: ADD, roles: 0 },
      { range: [4, 10, 14], symbol: CART, roles: 0 },
      { range: [3, 0, 4], symbol: 'local 3', roles: 0 },
    ],
    symbols: [],
  },
];

async function store(): Promise<MemoryIndexStore> {
  const s = new MemoryIndexStore();
  await s.replaceFile(file('src/cart.ts', [symbol('src/cart.ts', 'addItem', 1, 3)], '(program)'));
  await s.replaceFile(
    file('src/types.ts', [symbol('src/types.ts', 'Cart', 1, 1, 'type')], '(program)'),
  );
  await s.replaceFile(
    file(
      'src/page.tsx',
      [symbol('src/page.tsx', 'Page', 3, 6)],
      '(program (import name="\\"./cart\\"" line="1" endLine="1") (function name="Page" line="3" endLine="6"))',
    ),
  );
  // What the linker wrote: a guessed call, an unresolved one, and an import edge.
  await s.replaceEdges('src/page.tsx', [
    { from: 'src/page.tsx', to: 'src/cart.ts', kind: 'imports' },
    {
      from: 'src/page.tsx#Page',
      to: 'src/cart.ts#addItem',
      kind: 'calls:name',
      confidence: 'guess',
    },
    { from: 'src/page.tsx#Page', to: 'mystery', kind: 'calls:unresolved', confidence: 'none' },
  ]);
  return s;
}

const edgesFrom = async (s: MemoryIndexStore, from: string) =>
  (await s.findEdges({ from })).items.map(({ to, kind, lines }) => ({ to, kind, lines }));

describe('experimental: a SCIP index over the graph', () => {
  test('references become edges from the enclosing symbol; imports are not uses', async () => {
    const s = await store();
    const report = await applyScipOverlay(s, documents);
    expect(await edgesFrom(s, 'src/page.tsx#Page')).toEqual([
      { to: 'src/cart.ts#addItem', kind: 'calls', lines: [4] },
      { to: 'src/types.ts#Cart', kind: 'references:type', lines: [5] },
    ]);
    expect(report).toMatchObject({
      documents: 3,
      skipped: 0,
      definitions: 2,
      mapped: 2,
      edges: { calls: 1, types: 1, values: 0 },
      replaced: 2,
    });
  });

  test('import edges stay as the linker wrote them', async () => {
    const s = await store();
    await applyScipOverlay(s, documents);
    expect(await edgesFrom(s, 'src/page.tsx')).toEqual([
      { to: 'src/cart.ts', kind: 'imports', lines: undefined },
    ]);
  });

  test('applying it again gives the same graph', async () => {
    const s = await store();
    await applyScipOverlay(s, documents);
    const once = await edgesFrom(s, 'src/page.tsx#Page');
    await applyScipOverlay(s, documents);
    expect(await edgesFrom(s, 'src/page.tsx#Page')).toEqual(once);
  });

  test('a file changed since the SCIP index was written is left to the linker', async () => {
    const s = await store();
    const report = await applyScipOverlay(s, documents, { indexedAtMs: 500 });
    expect(report.skipped).toBe(3);
    expect((await edgesFrom(s, 'src/page.tsx#Page')).map((e) => e.kind)).toEqual([
      'calls:name',
      'calls:unresolved',
    ]);
  });
});
