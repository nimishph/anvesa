import { afterAll, describe, expect, test } from 'bun:test';
import { Deadline, OperationAbortedError } from '@sutras/code-lens-core';
import { disposeExtractors, makeExtractor } from '../test-support.ts';
import type { CallFact, FileFacts, ImportFact } from './facts.ts';
import { importCollectorFor } from './imports.ts';

const extractor = makeExtractor();
afterAll(disposeExtractors);

const facts = (path: string, source: string): Promise<FileFacts> => extractor.extract(path, source);
const callsOf = (file: FileFacts) =>
  file.calls.map((call: CallFact) => [call.from, call.name, call.receiver, call.kind]);
const importsOf = (file: FileFacts) =>
  file.imports.map((entry: ImportFact) => [entry.specifier, entry.kind]);

describe('symbols', () => {
  const source = `export class Store {
  get(id: string) { return this.cache.get(id); }
  put(id: string) {}
}
export function make() { return new Store(); }
const helper = () => make();
`;

  test('have unique ids, their parent, position and export state', async () => {
    const file = await facts('src/store.ts', source);
    expect(file.symbols.map((s) => [s.id, s.kind, s.parentId, s.exported])).toEqual([
      ['src/store.ts#Store', 'class', undefined, true],
      ['src/store.ts#Store.get', 'method', 'src/store.ts#Store', false],
      ['src/store.ts#Store.put', 'method', 'src/store.ts#Store', false],
      ['src/store.ts#make', 'function', undefined, true],
      ['src/store.ts#helper', 'function', undefined, false],
    ]);
    const store = file.symbols[0];
    expect([store?.startLine, store?.endLine]).toEqual([1, 4]);
  });

  test('callables carry their parameter names', async () => {
    const file = await facts(
      'a.ts',
      'function f(a, { b, c }, ...rest) {}\nconst g = (x: number) => x;\nclass K { m(y) {} }\ninterface I {}\n',
    );
    const params = Object.fromEntries(file.symbols.map((s) => [s.name, s.params]));
    expect(params).toEqual({
      f: 'a, {b, c}, ...rest',
      g: 'x',
      K: undefined,
      'K.m': 'y',
      I: undefined,
    });
  });

  test('a name listed for export is exported, wherever the list is', async () => {
    const file = await facts(
      'a.ts',
      'function f() {}\nfunction g() {}\nfunction h() {}\nexport { f, g as renamed };\nexport default h;\n',
    );
    expect(file.symbols.map((s) => [s.name, s.exported])).toEqual([
      ['f', true],
      ['g', true],
      ['h', true],
    ]);
    expect(file.exports).toEqual([
      { name: 'f', local: 'f', line: 4 },
      { name: 'renamed', local: 'g', line: 4 },
      { name: 'default', local: 'h', line: 5 },
    ]);
  });

  test('a declaration that is not listed stays not exported', async () => {
    const file = await facts('a.ts', 'function f() {}\nfunction g() {}\nexport { f };\n');
    expect(file.symbols.map((s) => [s.name, s.exported])).toEqual([
      ['f', true],
      ['g', false],
    ]);
  });

  test('same-named symbols in one file get distinct ids, in document order', async () => {
    const file = await facts('a.py', 'def f():\n    pass\n\ndef f():\n    pass\n');
    expect(file.symbols.map((s) => s.id)).toEqual(['a.py#f', 'a.py#f~2']);
  });
});

describe('calls', () => {
  test('belong to the innermost symbol around them, or to the file', async () => {
    const file = await facts(
      'a.ts',
      `setup();
class A {
  run() { helper(); }
}
const later = () => { other(); };
function outer() { function inner() { deep(); } inner(); }
`,
    );
    expect(callsOf(file)).toEqual([
      [undefined, 'setup', undefined, 'call'],
      ['a.ts#A.run', 'helper', undefined, 'call'],
      ['a.ts#later', 'other', undefined, 'call'],
      ['a.ts#outer.inner', 'deep', undefined, 'call'],
      ['a.ts#outer', 'inner', undefined, 'call'],
    ]);
  });

  test('keep the receiver, so a method call is not a bare name', async () => {
    const file = await facts(
      'a.ts',
      'function f(client) { this.log(); client.send(); a.b().c(); new Widget(); }',
    );
    expect(callsOf(file)).toEqual([
      ['a.ts#f', 'log', { kind: 'self' }, 'call'],
      ['a.ts#f', 'send', { kind: 'name', name: 'client' }, 'call'],
      ['a.ts#f', 'c', { kind: 'complex' }, 'call'],
      ['a.ts#f', 'b', { kind: 'name', name: 'a' }, 'call'],
      ['a.ts#f', 'Widget', undefined, 'new'],
    ]);
  });

  test('calls that are not to a name are counted as gaps, not invented', async () => {
    const file = await facts('a.ts', 'function f(g) { g()(); items[0](); }');
    expect(callsOf(file).map((c) => c[1])).toEqual(['g']);
    expect(file.gaps.unnamedCalls).toBe(2);
  });

  test('super, require and import are not calls to a symbol', async () => {
    const file = await facts(
      'a.ts',
      "class B extends A { constructor() { super(); } }\nconst x = require('x');\nimport('y');\n",
    );
    expect(file.calls).toEqual([]);
  });

  test('a component in JSX is a reference, markup is not', async () => {
    const file = await facts(
      'a.tsx',
      'const Page = () => <div><Card title="x"/><ui.Button/></div>;',
    );
    expect(callsOf(file)).toEqual([
      ['a.tsx#Page', 'Card', undefined, 'jsx'],
      ['a.tsx#Page', 'Button', { kind: 'name', name: 'ui' }, 'jsx'],
    ]);
  });

  test('Python calls, methods and constructors', async () => {
    const file = await facts(
      'a.py',
      'class A:\n    def run(self):\n        self.step()\n        helper(1)\n        os.path.join("a")\n',
    );
    expect(callsOf(file)).toEqual([
      ['a.py#A.run', 'step', { kind: 'self' }, 'call'],
      ['a.py#A.run', 'helper', undefined, 'call'],
      ['a.py#A.run', 'join', { kind: 'name', name: 'os.path' }, 'call'],
    ]);
  });

  test('an awaited generic call is a call to the function', async () => {
    const file = await facts('a.ts', 'async function f() { const v = await load<Item>(req); }');
    expect(callsOf(file)).toEqual([['a.ts#f', 'load', undefined, 'call']]);
  });

  test('brackets inside string literals in a chain do not confuse the callee', async () => {
    const file = await facts(
      'a.ts',
      `const ctx = konn()
  .beforeEach(() => { log("(") ; log('}') })
  .afterEach(() => {});
`,
    );
    expect(callsOf(file)).toEqual([
      [undefined, 'afterEach', { kind: 'complex' }, 'call'],
      [undefined, 'beforeEach', { kind: 'complex' }, 'call'],
      [undefined, 'konn', undefined, 'call'],
      [undefined, 'log', undefined, 'call'],
      [undefined, 'log', undefined, 'call'],
    ]);
  });

  test('parentheses, non-null assertions and casts around a callee are looked through', async () => {
    const file = await facts('a.ts', 'function f(a, g) { (a.b)!(); (g as Fn)(); a?.b.c(); }');
    expect(callsOf(file)).toEqual([
      ['a.ts#f', 'b', { kind: 'name', name: 'a' }, 'call'],
      ['a.ts#f', 'g', undefined, 'call'],
      ['a.ts#f', 'c', { kind: 'name', name: 'a.b' }, 'call'],
    ]);
  });

  test('a call keeps its line', async () => {
    const file = await facts('a.ts', 'function f() {\n\n  g();\n}\n');
    expect(file.calls[0]?.line).toBe(3);
  });
});

describe('TypeScript and JavaScript imports', () => {
  const source = `import type { A, type B as C } from './a';
import D, * as E from "e";
import 'side';
import x = require('y');
export * from './r';
export * as ns from './r2';
export type { T } from './r3';
export { a as b } from './r4';
const { p, q: r } = require('z');
const m = await import('w');
const computed = require(name);
import('./lazy');
`;

  test('every way of loading a module', async () => {
    const file = await facts('a.ts', source);
    expect(importsOf(file)).toEqual([
      ['./a', 'static'],
      ['e', 'static'],
      ['side', 'side-effect'],
      ['y', 'require'],
      ['./r', 'reexport'],
      ['./r2', 'reexport'],
      ['./r3', 'reexport'],
      ['./r4', 'reexport'],
      ['z', 'require'],
      ['w', 'dynamic'],
      ['./lazy', 'dynamic'],
    ]);
  });

  test('bindings say what was taken and what it is called here', async () => {
    const file = await facts('a.ts', source);
    const byWhere = (specifier: string) => file.imports.find((i) => i.specifier === specifier);
    expect(byWhere('./a')?.bindings).toEqual([
      { imported: 'A', local: 'A', typeOnly: true },
      { imported: 'B', local: 'C', typeOnly: true },
    ]);
    expect(byWhere('e')?.bindings).toEqual([
      { imported: 'default', local: 'D', typeOnly: false },
      { imported: '*', local: 'E', typeOnly: false },
    ]);
    expect(byWhere('z')?.bindings).toEqual([
      { imported: 'p', local: 'p', typeOnly: false },
      { imported: 'q', local: 'r', typeOnly: false },
    ]);
    expect(byWhere('w')?.bindings).toEqual([{ imported: '*', local: 'm', typeOnly: false }]);
    expect(byWhere('./r')?.bindings).toEqual([{ imported: '*', local: '*', typeOnly: false }]);
    expect(byWhere('./r2')?.bindings).toEqual([{ imported: '*', local: 'ns', typeOnly: false }]);
    expect(byWhere('./r4')?.bindings).toEqual([{ imported: 'a', local: 'b', typeOnly: false }]);
  });

  test('type-only imports are marked, and relative ones too', async () => {
    const file = await facts('a.ts', source);
    const first = file.imports[0];
    expect(first?.typeOnly).toBe(true);
    expect(first?.relative).toBe(true);
    expect(file.imports.find((i) => i.specifier === 'e')?.typeOnly).toBe(false);
    expect(file.imports.find((i) => i.specifier === 'e')?.relative).toBe(false);
  });

  test('a computed specifier is a counted gap, not a guess', async () => {
    const file = await facts('a.ts', source);
    expect(file.gaps.computedImports).toBe(1);
  });

  test('a template literal without substitutions is a literal specifier', async () => {
    const computed = `import(\`./\${name}\`);`;
    const file = await facts('a.ts', `import(\`./x\`);\n${computed}`);
    expect(importsOf(file)).toEqual([['./x', 'dynamic']]);
    expect(file.gaps.computedImports).toBe(1);
  });

  test('JavaScript files use the same rules', async () => {
    const file = await facts('a.js', "import a from './a.js';\nconst b = require('b');\n");
    expect(importsOf(file)).toEqual([
      ['./a.js', 'static'],
      ['b', 'require'],
    ]);
  });
});

describe('Python imports', () => {
  test('import, from-import, aliases, relative levels and wildcards', async () => {
    const file = await facts(
      'a.py',
      `import os.path
import a.b as c
from . import x
from ..pkg.mod import (y as z, w)
from m import *
`,
    );
    expect(importsOf(file)).toEqual([
      ['os.path', 'static'],
      ['a.b', 'static'],
      ['.', 'static'],
      ['..pkg.mod', 'static'],
      ['m', 'static'],
    ]);
    expect(file.imports.map((i) => i.relative)).toEqual([false, false, true, true, false]);
    expect(file.imports[0]?.bindings).toEqual([{ imported: '*', local: 'os', typeOnly: false }]);
    expect(file.imports[1]?.bindings).toEqual([{ imported: '*', local: 'c', typeOnly: false }]);
    expect(file.imports[2]?.bindings).toEqual([{ imported: 'x', local: 'x', typeOnly: false }]);
    expect(file.imports[3]?.bindings).toEqual([
      { imported: 'y', local: 'z', typeOnly: false },
      { imported: 'w', local: 'w', typeOnly: false },
    ]);
    expect(file.imports[4]?.bindings).toEqual([{ imported: '*', local: '*', typeOnly: false }]);
  });
});

describe('languages and damage', () => {
  test('a language whose imports are not understood has no collector, so callers can say so', () => {
    expect(importCollectorFor('go')).toBeUndefined();
    expect(importCollectorFor('python')).toBeDefined();
    expect(importCollectorFor('tsx')).toBeDefined();
  });

  test('a file with a syntax error still yields the facts of its parseable parts', async () => {
    const file = await facts(
      'a.ts',
      'import a from "a";\nfunction ok() { go(); }\nfunction broken( {\n',
    );
    expect(file.hasSyntaxErrors).toBe(true);
    expect(file.imports.map((i) => i.specifier)).toEqual(['a']);
    expect(file.symbols.map((s) => s.name)).toContain('ok');
    expect(file.calls.map((c) => c.name)).toContain('go');
  });

  test('an empty file has no facts and no errors', async () => {
    const file = await facts('a.ts', '');
    expect(file).toMatchObject({ symbols: [], calls: [], imports: [], hasSyntaxErrors: false });
  });

  test('positions stay correct after non-ASCII text', async () => {
    const file = await facts('a.ts', 'const s = "日本語 🎉";\nfunction after() { target(); }\n');
    expect(callsOf(file)).toEqual([['a.ts#after', 'target', undefined, 'call']]);
  });

  test('a very deeply nested file is handled without a depth limit', async () => {
    const depth = 3000;
    const source = `${'['.repeat(depth)}call()${']'.repeat(depth)};`;
    const file = await facts('deep.ts', source);
    expect(file.calls.map((c) => c.name)).toEqual(['call']);
  });

  test('a cancelled deadline stops extraction with a typed error', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractor.extract('a.ts', 'function f() {}', {
        deadline: Deadline.of({ signal: controller.signal }),
      }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
  });
});
