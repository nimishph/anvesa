import { describe, expect, test } from 'bun:test';
import type { CallFact, ImportFact, Resolution, SymbolFact } from '@sutras/code-lens-indexer';
import { type ObservedCall, ratio, scoreCalls, scoreImports, scoreSymbols } from './compare.ts';
import type { TruthCall, TruthImport, TruthSymbol } from './truth.ts';

const symbol = (path: string, name: string, kind = 'function', start = 1, end = 5): SymbolFact => ({
  id: `${path}#${name}`,
  path,
  name,
  baseName: name.split('.').at(-1) as string,
  kind,
  parentId: undefined,
  exported: undefined,
  startLine: start,
  endLine: end,
  signature: undefined,
  doc: undefined,
});

describe('ratios', () => {
  test('a ratio with nothing to measure has no value, not zero', () => {
    expect(ratio(0, 0).value).toBeUndefined();
    expect(ratio(1, 4).value).toBe(0.25);
  });
});

describe('scoring symbols', () => {
  const truth: TruthSymbol[] = [
    { path: 'a.ts', baseName: 'f', group: 'callable', line: 1 },
    { path: 'a.ts', baseName: 'g', group: 'callable', line: 2 },
    { path: 'a.ts', baseName: 'C', group: 'class', line: 3 },
    { path: 'a.ts', baseName: 'C', group: 'class', line: 30 },
  ];

  test('precision and recall over (file, name, kind group), repeats counted', () => {
    const ours = new Map([
      [
        'a.ts',
        [
          symbol('a.ts', 'f'),
          symbol('a.ts', 'C.m', 'method'),
          symbol('a.ts', 'C', 'class'),
          symbol('a.ts', 'extra'),
        ],
      ],
    ]);
    const score = scoreSymbols(truth, ours);
    // Matched: f, C (once). Ours: f, m, C, extra = 4. Truth: 4.
    expect(score.precision).toEqual(ratio(2, 4));
    expect(score.recall).toEqual(ratio(2, 4));
    expect(score.missed).toEqual(['a.ts  callable g', 'a.ts  class C']);
    expect(score.extra).toEqual(['a.ts  callable extra', 'a.ts  callable m']);
  });

  test('kinds with no counterpart are counted apart, not held against precision', () => {
    const ours = new Map([['a.ts', [symbol('a.ts', 'v', 'variable')]]]);
    const score = scoreSymbols([], ours);
    expect(score.notComparable.get('variable')).toBe(1);
    expect(score.precision.value).toBeUndefined();
  });
});

describe('scoring imports', () => {
  const site = (specifier: string, target: TruthImport['target'], line = 1): TruthImport => ({
    path: 'a.ts',
    specifier,
    line,
    target,
  });
  const fact = (specifier: string): ImportFact => ({
    specifier,
    kind: 'static',
    relative: specifier.startsWith('.'),
    typeOnly: false,
    bindings: [],
    line: 1,
  });
  const resolved = (specifier: string, resolution: Resolution) => ({
    fact: fact(specifier),
    resolution,
  });

  test('agreement needs the same class, and for files the same file', () => {
    const truth = [
      site('./x', { kind: 'file', path: 'x.ts' }),
      site('./y', { kind: 'file', path: 'y.ts' }),
      site('react', { kind: 'external' }),
      site('./gone', { kind: 'unresolved' }),
      site('./z', { kind: 'file', path: 'z.ts' }),
    ];
    const ours = new Map([
      [
        'a.ts',
        [
          resolved('./x', { kind: 'file', path: 'x.ts', via: 'relative' }),
          resolved('./y', { kind: 'file', path: 'other.ts', via: 'relative' }),
          resolved('react', { kind: 'external', name: 'react' }),
          resolved('./gone', { kind: 'dangling', reason: 'no such file', tried: [] }),
        ],
      ],
    ]);
    const score = scoreImports(truth, ours);
    expect(score.extracted).toEqual(ratio(4, 5));
    expect(score.agreement).toEqual(ratio(3, 4));
    expect(score.confusion.get('file>file')).toBe(2);
    expect(score.disagreements).toEqual(['a.ts:1  ./y  compiler: y.ts  code-lens: other.ts']);
    expect(score.notExtracted).toEqual(['a.ts:1  ./z']);
  });

  test('two imports of the same module are matched in order', () => {
    const truth = [
      site('./x', { kind: 'file', path: 'x.ts' }, 1),
      site('./x', { kind: 'file', path: 'x.ts' }, 2),
    ];
    const ours = new Map([
      [
        'a.ts',
        [
          resolved('./x', { kind: 'file', path: 'x.ts', via: 'relative' }),
          resolved('./x', { kind: 'file', path: 'x.ts', via: 'relative' }),
        ],
      ],
    ]);
    expect(scoreImports(truth, ours).agreement).toEqual(ratio(2, 2));
  });
});

describe('scoring calls', () => {
  const target = { kind: 'symbol', path: 'lib.ts', name: 'f', line: 2 } as const;
  const truthCall = (over: Partial<TruthCall> = {}): TruthCall => ({
    path: 'a.ts',
    line: 10,
    name: 'f',
    member: false,
    target,
    ...over,
  });
  const observed = (
    resolution: ObservedCall['resolution'],
    over: Partial<CallFact> = {},
  ): ObservedCall => ({
    call: { from: 'a.ts#main', name: 'f', receiver: undefined, kind: 'call', line: 10, ...over },
    resolution,
  });
  const symbols = new Map([['lib.ts', [symbol('lib.ts', 'f', 'function', 1, 4)]]]);
  const score = (truth: TruthCall[], ours: ObservedCall[]) =>
    scoreCalls(truth, new Map([['a.ts', ours]]), symbols, { samplesPerCategory: 5 });

  test('a call resolved to the compiler’s symbol is correct, and a guess is scored apart', () => {
    const result = score(
      [truthCall(), truthCall({ line: 11, member: true }), truthCall({ line: 12 })],
      [
        observed({ kind: 'symbol', ids: ['lib.ts#f'] }),
        observed({ kind: 'byName', ids: ['lib.ts#f', 'lib.ts#other'] }, { line: 11 }),
        observed({ kind: 'symbol', ids: ['lib.ts#wrong'] }, { line: 12 }),
      ],
    );
    expect(result.judged).toBe(3);
    expect(result.recallResolved).toEqual(ratio(1, 3));
    expect(result.recallWithGuesses).toEqual(ratio(2, 3));
    expect(result.precisionResolved).toEqual(ratio(1, 2));
    expect(result.guessPrecision).toEqual(ratio(1, 1));
    expect(result.meanGuessCandidates).toBe(2);
    expect(result.byForm.bare.recallResolved).toEqual(ratio(1, 2));
    expect(result.byForm.member.recallResolved).toEqual(ratio(0, 1));
  });

  test('a declaration is matched to our symbol by name and by containing line', () => {
    const inside = score(
      [truthCall({ target: { ...target, line: 4 } })],
      [observed({ kind: 'symbol', ids: ['lib.ts#f'] })],
    );
    expect(inside.judged).toBe(1);
    const outside = score(
      [truthCall({ target: { ...target, line: 40 } })],
      [observed({ kind: 'symbol', ids: ['lib.ts#f'] })],
    );
    expect(outside.judged).toBe(0);
    expect(outside.outcomes.get('target symbol not extracted')).toBe(1);
  });

  test('calls the compiler cannot resolve are not judged either way', () => {
    const result = score(
      [truthCall({ target: { kind: 'unknown' } })],
      [observed({ kind: 'symbol', ids: ['lib.ts#f'] })],
    );
    expect(result.judged).toBe(0);
    expect(result.outcomes.get('compiler could not tell')).toBe(1);
    expect(result.precisionResolved.total).toBe(0);
  });

  test('external calls: agreeing is credited, linking to a symbol is a false link', () => {
    const result = score(
      [
        truthCall({ target: { kind: 'external' } }),
        truthCall({ line: 11, target: { kind: 'external' } }),
      ],
      [
        observed({ kind: 'external', to: 'global#Map' }),
        observed({ kind: 'symbol', ids: ['lib.ts#f'] }, { line: 11 }),
      ],
    );
    expect(result.externalAgreement).toEqual(ratio(1, 2));
    expect(result.samples.get('external: linked to a symbol')).toHaveLength(1);
    // The false link counts against the precision of resolved links.
    expect(result.precisionResolved).toEqual(ratio(0, 1));
  });

  test('a call site the extractor missed is counted, not skipped', () => {
    const result = score([truthCall()], []);
    expect(result.extracted).toEqual(ratio(0, 1));
    expect(result.outcomes.get('not extracted')).toBe(1);
  });

  test('edges are caller to callee, counted once however many calls make them', () => {
    const result = score(
      [truthCall(), truthCall({ line: 11 })],
      [
        observed({ kind: 'symbol', ids: ['lib.ts#f'] }),
        observed({ kind: 'symbol', ids: ['lib.ts#f'] }, { line: 11 }),
      ],
    );
    expect(result.edgePrecision).toEqual(ratio(1, 1));
    expect(result.edgeRecall).toEqual(ratio(1, 1));
  });
});
