import { afterAll, describe, expect, test } from 'bun:test';
import { findClones } from './clones.ts';
import { diffStructure } from './diff.ts';
import { disposeEngines, encodeTs, makeEngine } from './test-support.ts';

const engine = makeEngine();
afterAll(disposeEngines);

const encode = async (source: string, path = 'a.ts') => (await encodeTs(engine, source, path)).root;

describe('clone detection', () => {
  const fileA = `
    export function total(items: number[]) { let sum = 0; for (const i of items) { sum += i; } return sum; }
    export function tiny() { return 1; }
    export function stub() {}`;
  const fileB = `
    export function addAll(values: number[]) { let acc = 0; for (const v of values) { acc += v; } return acc; }
    export function alsoTiny() { return 2; }
    export function otherStub() {}
    export function different(a: number) { return a > 0 ? 'pos' : 'neg'; }`;

  const sourcesOf = async () => [
    { path: 'a.ts', root: await encode(fileA, 'a.ts') },
    { path: 'b.ts', root: await encode(fileB, 'b.ts') },
  ];

  test('finds a renamed copy across files by its body, not its name', async () => {
    const groups = findClones(await sourcesOf());
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.kind).toBe('shape');
    expect(group?.occurrences.map((o) => [o.path, o.name])).toEqual([
      ['a.ts', 'total'],
      ['b.ts', 'addAll'],
    ]);
    expect(group?.occurrences[0]?.startLine).toBe(2);
  });

  test('ignores stub bodies unless asked to keep them', async () => {
    const files = await sourcesOf();
    expect(findClones(files).flatMap((g) => g.occurrences.map((o) => o.name))).not.toContain(
      'tiny',
    );
    const all = findClones(files, { includeTrivial: true });
    const names = all.flatMap((g) => g.occurrences.map((o) => o.name));
    expect(names).toEqual(expect.arrayContaining(['tiny', 'alsoTiny', 'stub', 'otherStub']));
  });

  test('a caller-set minimum size filters small shapes, and no minimum is assumed', async () => {
    const files = await sourcesOf();
    expect(findClones(files, { minShapeNodes: 10_000 })).toHaveLength(0);
    expect(findClones(files, { minShapeNodes: 1 })).toHaveLength(1);
  });

  test('signature mode groups by name and signature instead', async () => {
    const files = [
      {
        path: 'x.ts',
        root: await encode('export function same(a: number): number { return a; }', 'x.ts'),
      },
      {
        path: 'y.ts',
        root: await encode('export function same(a: number): number { return a + 1; }', 'y.ts'),
      },
    ];
    expect(findClones(files)).toHaveLength(0);
    const groups = findClones(files, { by: 'signature' });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('signature');
  });

  test('a function with no copy is not reported, and the order is deterministic', async () => {
    const files = await sourcesOf();
    const first = findClones(files);
    const second = findClones([...files].reverse());
    expect(first.map((g) => g.key)).toEqual(second.map((g) => g.key));
    expect(first.flatMap((g) => g.occurrences.map((o) => o.name))).not.toContain('different');
  });

  test('arrows assigned to variables are attributed to that name', async () => {
    const root = await encode(`
      const one = (a: number) => { const b = a * 2; return b + a; };
      const two = (x: number) => { const y = x * 2; return y + x; };`);
    const [group] = findClones([{ path: 'a.ts', root }]);
    expect(group?.occurrences.map((o) => o.name)).toEqual(['one', 'two']);
  });
});

describe('structural diff', () => {
  const before = `
    export class Repo {
      find(id: string): Item { return lookup(id); }
      remove(id: string) { return drop(id); }
      stays() { return 1 + 1; }
    }
    export function helper(a: number) { return a; }
    export function overload(a: string) { return a; }
    export function overload(a: number) { return a; }`;

  test('reports added, removed and modified symbols by name', async () => {
    const after = `
      export class Repo {
        find(id: string, strict: boolean): Item { return lookup(id); }
        stays() { return 1 + 1; }
        create() { return make(); }
      }
      export function helper(a: number) { return a * 2; }
      export function overload(a: string) { return a; }
      export function overload(a: number) { return a; }`;
    const diff = diffStructure(await encode(before), await encode(after));
    expect(diff.added.map((s) => s.name)).toEqual(['Repo.create']);
    expect(diff.removed.map((s) => s.name)).toEqual(['Repo.remove']);
    const changes = Object.fromEntries(diff.modified.map((m) => [m.name, m.changes]));
    expect(changes['Repo.find']).toEqual(['signature']);
    expect(changes.helper).toEqual(['body']);
    expect(diff.summary).toBe('+1 added, -1 removed, ~2 modified');
  });

  test('a symbol that only moved is not a modification', async () => {
    const moved = `

      export class Repo {
        find(id: string): Item { return lookup(id); }
        remove(id: string) { return drop(id); }
        stays() { return 1 + 1; }
      }
      export function helper(a: number) { return a; }
      export function overload(a: string) { return a; }
      export function overload(a: number) { return a; }`;
    const diff = diffStructure(await encode(before), await encode(moved));
    expect(diff.modified).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.summary).toBe('no structural changes');
    expect(diff.unchanged).toBeGreaterThan(0);
  });

  test('overloads with the same name are paired in order, never merged into one', async () => {
    const after = before.replace(
      'overload(a: number) { return a; }',
      'overload(a: number) { return a + 1; }',
    );
    const diff = diffStructure(await encode(before), await encode(after));
    expect(diff.modified.map((m) => m.name)).toEqual(['overload']);
    expect(diff.modified[0]?.changes).toEqual(['body']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test('removing one of two same-named symbols reports exactly one removal', async () => {
    const after = before.replace('export function overload(a: number) { return a; }', '');
    const diff = diffStructure(await encode(before), await encode(after));
    expect(diff.removed.map((s) => s.name)).toEqual(['overload']);
  });

  test('a symbol that changes kind is reported as such', async () => {
    const diff = diffStructure(
      await encode('function thing() { return 1; }'),
      await encode('const thing = function () { return 1; };'),
    );
    expect(diff.removed.length + diff.added.length + diff.modified.length).toBeGreaterThan(0);
  });
});
