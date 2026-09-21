import { afterAll, describe, expect, test } from 'bun:test';
import type { StructuralEngine } from './engine.ts';
import { ATTR } from './node.ts';
import { outlineSymbols } from './symbols.ts';
import { disposeEngines, makeEngine, nodesTagged } from './test-support.ts';

const engine: StructuralEngine = makeEngine();
afterAll(disposeEngines);

async function outline(source: string, path: string, docs = true) {
  const { root } = await engine.encode(source, { path }, { docs });
  return outlineSymbols(root);
}

describe('outline symbols', () => {
  const source = `/** Owns things. */
export class Outer {
  /** Runs it. */
  run(a: number): void {}
  helper() {}
}
function local() {}
export const arrow = (x: number) => x;
const plain = 3;
/** Documented value. */
const documented = 4;
interface Shape { area(): number }
type Id = string;
`;

  test('lists declarations in document order with their kind, qualified name and parent', async () => {
    const symbols = await outline(source, 'a.ts');
    expect(symbols.map((s) => [s.kind, s.name, s.parentName])).toEqual([
      ['class', 'Outer', ''],
      ['method', 'Outer.run', 'Outer'],
      ['method', 'Outer.helper', 'Outer'],
      ['function', 'local', ''],
      ['function', 'arrow', ''],
      ['variable', 'documented', ''],
      ['interface', 'Shape', ''],
      ['type', 'Id', ''],
    ]);
    expect(symbols.find((s) => s.name === 'Outer.run')?.baseName).toBe('run');
  });

  test('a variable holding a function is a function, and a plain variable is not a symbol', async () => {
    const names = (await outline(source, 'a.ts')).map((s) => s.name);
    expect(names).toContain('arrow');
    expect(names).not.toContain('plain');
  });

  test('carries documentation and signature', async () => {
    const symbols = await outline(source, 'a.ts');
    expect(symbols.find((s) => s.name === 'Outer')?.doc).toBe('/** Owns things. */');
    expect(symbols.find((s) => s.name === 'Outer.run')?.signature).toBe('Outer.run(a):void');
  });

  test('exported means wrapped in an export; a file with no exports says nothing either way', async () => {
    const symbols = await outline(source, 'a.ts');
    const flags = Object.fromEntries(symbols.map((s) => [s.name, s.exported]));
    expect(flags.Outer).toBe(true);
    expect(flags.local).toBe(false);
    expect(flags.arrow).toBe(true);

    const bare = await outline('function f() {}\n', 'b.ts');
    expect(bare[0]?.exported).toBeUndefined();
  });

  test('Python has no export marker, so exported is unknown', async () => {
    const symbols = await outline(
      'class A:\n    def m(self):\n        pass\n\ndef f():\n    pass\n',
      'a.py',
    );
    expect(symbols.map((s) => [s.kind, s.name, s.exported])).toEqual([
      ['class', 'A', undefined],
      ['function', 'A.m', undefined],
      ['function', 'f', undefined],
    ]);
  });
});

describe('what is not a symbol', () => {
  test('type expressions are not symbols; only a type alias declaration is', async () => {
    const symbols = await outline(
      `type Id = string;
function f(a: Maybe<Thing>, b: A | B): Result<void> { return null as any; }
interface Shape { area(): number }
`,
      'a.ts',
    );
    expect(symbols.map((s) => [s.kind, s.name])).toEqual([
      ['type', 'Id'],
      ['function', 'f'],
      ['interface', 'Shape'],
    ]);
  });

  test('a variable is a function only when a function is what it is assigned', async () => {
    const symbols = await outline(
      `const direct = () => 1;
const wrapped = ((x: number) => x) as Fn;
const holder = make({ on: () => 1, nested: { deep: function () {} } });
const list = items.map((item) => item.id);
`,
      'a.ts',
    );
    expect(symbols.map((s) => [s.kind, s.name])).toEqual([
      ['function', 'direct'],
      ['function', 'wrapped'],
    ]);
  });

  test("a callback inside an initializer does not take the variable's name", async () => {
    const { root } = await engine.encode('const holder = make({ on: () => 1 });\n', {
      path: 'a.ts',
    });
    const arrows = nodesTagged(root, 'arrow');
    expect(arrows).toHaveLength(1);
    expect(arrows[0]?.attrs.has(ATTR.assignedTo)).toBe(false);
  });

  test('generator functions are functions, declared or assigned', async () => {
    const symbols = await outline(
      `async function* stream() {}
function* plain() {}
const make = async function* () {};
`,
      'a.ts',
    );
    expect(symbols.map((s) => [s.kind, s.name])).toEqual([
      ['function', 'stream'],
      ['function', 'plain'],
      ['function', 'make'],
    ]);
  });

  test('enums and namespaces are symbols, and their members are not enums', async () => {
    const symbols = await outline(
      `enum Direction { Up, Down }
namespace Util { export function helper() {} }
`,
      'a.ts',
    );
    expect(symbols.map((s) => [s.kind, s.name])).toEqual([
      ['enum', 'Direction'],
      ['module', 'Util'],
      ['function', 'Util.helper'],
    ]);
  });
});

describe('positions', () => {
  test('are absent unless asked for', async () => {
    const { root } = await engine.encode('function f() {}\n', { path: 'a.ts' });
    const fn = nodesTagged(root, 'function')[0];
    expect(fn?.attrs.has(ATTR.startIndex)).toBe(false);
    expect(fn?.attrs.has(ATTR.endIndex)).toBe(false);
  });

  test('locate a node in the source, in the units web-tree-sitter reports', async () => {
    const source = 'const a = 1;\nfunction f() { return 2; }\n';
    const { root } = await engine.encode(source, { path: 'a.ts' }, { positions: true });
    const fn = nodesTagged(root, 'function')[0];
    const start = Number(fn?.attrs.get(ATTR.startIndex));
    const end = Number(fn?.attrs.get(ATTR.endIndex));
    expect(source.slice(start, end)).toBe('function f() { return 2; }');
  });

  test('stay correct after non-ASCII text, so they can be used to slice the string', async () => {
    const source = 'const s = "日本語 🎉 é";\nfunction after() {}\n';
    const { root } = await engine.encode(source, { path: 'a.ts' }, { positions: true });
    const fn = nodesTagged(root, 'function')[0];
    const start = Number(fn?.attrs.get(ATTR.startIndex));
    const end = Number(fn?.attrs.get(ATTR.endIndex));
    expect(source.slice(start, end)).toBe('function after() {}');
  });
});

describe('encoding and inspecting one parse', () => {
  test('withEncoded hands over the tree and the outline, and returns what the work returns', async () => {
    const source = 'function a() { b(); }\nfunction b() {}\n';
    const result = await engine.withEncoded(source, { path: 'a.ts' }, {}, (tree, encoded) => ({
      language: encoded.language,
      rootType: tree.root.type,
      functions: nodesTagged(encoded.root, 'function').length,
    }));
    expect(result).toEqual({ language: 'typescript', rootType: 'program', functions: 2 });
  });

  test('the tree is released once the work is done, and also when it throws', async () => {
    const before = engine.runtime.liveTrees;
    await engine.withEncoded('let a = 1;', { path: 'a.ts' }, {}, () => {
      expect(engine.runtime.liveTrees).toBe(before + 1);
    });
    expect(engine.runtime.liveTrees).toBe(before);

    class WorkFailed extends Error {}
    await expect(
      engine.withEncoded('let a = 1;', { path: 'a.ts' }, {}, () => {
        throw new WorkFailed('boom');
      }),
    ).rejects.toBeInstanceOf(WorkFailed);
    expect(engine.runtime.liveTrees).toBe(before);
  });
});
