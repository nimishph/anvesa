import { afterAll, describe, expect, test } from 'bun:test';
import type { IndexStore } from '../store/types.ts';
import { cleanupTrees, disposeExtractors, indexFixture } from '../test-support.ts';
import { EDGE } from './edges.ts';

afterAll(async () => {
  cleanupTrees();
  await disposeExtractors();
});

const callsOf = async (store: IndexStore, from: string) =>
  (await store.findEdges({ from, kind: EDGE.calls })).items.map((e) => e.to).sort();

describe('a name that is only another name', () => {
  const files = {
    'package.json': '{"name":"r"}',
    'lib.ts': `export function real() {}
/** Renamed. */
export const experimental: typeof real = real;
export const second = experimental;
export const notAlias = real();
export const viaMember = Object.keys;
`,
    'app.ts': `import { experimental as old, second } from './lib';
export function run() { old(); }
export function again() { second(); }
`,
    'same.ts': `function target() {}
const local = target;
export function go() { local(); }
`,
    'cycle.ts': `const a = b;
const b = a;
export function spin() { a(); }
`,
  };

  test('is followed to what it names, through a chain, across files and within one', async () => {
    const fixture = await indexFixture(files);
    await fixture.linker.linkAll();
    expect(await callsOf(fixture.store, 'app.ts#run')).toEqual(['lib.ts#real']);
    expect(await callsOf(fixture.store, 'app.ts#again')).toEqual(['lib.ts#real']);
    expect(await callsOf(fixture.store, 'same.ts#go')).toEqual(['same.ts#target']);
  });

  test('is recorded on the symbol, and only for a bare name', async () => {
    const fixture = await indexFixture(files);
    const lib = await fixture.store.facts('lib.ts');
    const byName = new Map(lib?.symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get('experimental')?.aliasOf).toBe('real');
    expect(byName.get('second')?.aliasOf).toBe('experimental');
    expect(byName.get('notAlias')?.aliasOf).toBeUndefined();
    expect(byName.get('viaMember')?.aliasOf).toBeUndefined();
    // The alias is still a symbol you can find and read about.
    expect((await fixture.store.symbol('lib.ts#experimental'))?.aliasOf).toBe('real');
  });

  test('a chain that comes back on itself stops, and the call lands on one of its names', async () => {
    const fixture = await indexFixture(files);
    await fixture.linker.linkAll();
    const [only] = await callsOf(fixture.store, 'cycle.ts#spin');
    expect(['cycle.ts#a', 'cycle.ts#b']).toContain(only as string);
  });
});
