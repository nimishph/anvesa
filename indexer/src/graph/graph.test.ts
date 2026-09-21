import { afterAll, describe, expect, test } from 'bun:test';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import { StoreDatabase } from '../store/database.ts';
import { MemoryIndexStore } from '../store/memory-index-store.ts';
import { SqliteIndexStore } from '../store/sqlite-index-store.ts';
import type { EdgeRecord, IndexStore } from '../store/types.ts';
import { cleanupTrees, disposeExtractors, type Fixture, indexFixture } from '../test-support.ts';
import { EDGE } from './edges.ts';
import { DiskEnvironment, GraphLinker, GraphQueries, ImportResolver, summarize } from './index.ts';

afterAll(async () => {
  cleanupTrees();
  await disposeExtractors();
});

async function allEdges(store: IndexStore): Promise<EdgeRecord[]> {
  const found: EdgeRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.findEdges(cursor === undefined ? {} : { cursor });
    found.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return found;
}

const edgesOf = async (store: IndexStore, from: string, kind?: string) =>
  (await store.findEdges({ from, ...(kind ? { kind } : {}) })).items.map(
    (e) => `${e.kind} ${e.to}`,
  );

/** A pnpm-style monorepo: a library package and an app that uses it. */
const monorepo = {
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'package.json': '{"name":"root","private":true}',
  'packages/core/package.json': JSON.stringify({
    name: '@acme/core',
    main: './dist/index.js',
    types: './dist/index.d.ts',
  }),
  'packages/core/src/index.ts': `export { greet } from './greet';
export * from './math';
export class Store {
  cache = new Map();
  get(id: string) { return this.cache.get(id); }
  put(id: string) { this.log(id); }
  log(message: string) {}
}
`,
  'packages/core/src/greet.ts': `export function greet(name: string) { return format(name); }
function format(name: string) { return name; }
`,
  'packages/core/src/math.ts': `export function add(a: number, b: number) { return a + b; }
export function sum(values: number[]) { return values.reduce(add); }
export function twice(n: number) { return add(n, n); }
`,
  'packages/app/package.json': JSON.stringify({
    name: '@acme/app',
    dependencies: { '@acme/core': 'workspace:*' },
  }),
  'packages/app/src/main.ts': `import { greet, add, Store } from '@acme/core';
import type { Store as StoreType } from '@acme/core';
import { helper } from './helper';
import './data.json';
import missing from './missing';
import React from 'react';

export function run() {
  greet('x');
  add(1, 2);
  const store = new Store();
  store.put('a');
  helper();
  React.createElement('div');
  missing();
  unknownFn();
}
`,
  'packages/app/src/helper.ts': `export function helper() { return 1; }
`,
  'packages/app/src/types.ts': `import type { Store } from '@acme/core';
export type Holder = Store;
`,
  'packages/app/src/data.json': 'body {}\n',
};

describe('linking a pnpm monorepo', () => {
  let fixture: Fixture;
  const ready = async () => {
    if (!fixture) {
      fixture = await indexFixture(monorepo);
      await fixture.linker.linkAll();
    }
    return fixture;
  };

  test('finds the two workspace packages', async () => {
    const { workspace } = await ready();
    expect(workspace.packages().map((p) => [p.name, p.root])).toEqual([
      ['root', ''],
      ['@acme/app', 'packages/app'],
      ['@acme/core', 'packages/core'],
    ]);
  });

  test('imports resolve across packages, through built-output paths, to real files', async () => {
    const { store } = await ready();
    const main = 'packages/app/src/main.ts';
    expect(await edgesOf(store, main, EDGE.imports)).toEqual([
      `${EDGE.imports} packages/core/src/index.ts`,
      `${EDGE.imports} packages/app/src/helper.ts`,
    ]);
    expect(await edgesOf(store, main, EDGE.importsType)).toEqual([
      `${EDGE.importsType} packages/core/src/index.ts`,
    ]);
  });

  test('assets, external packages and dangling imports are recorded, none dropped', async () => {
    const { store, queries } = await ready();
    const main = 'packages/app/src/main.ts';
    expect(await edgesOf(store, main, EDGE.importsAsset)).toEqual([
      `${EDGE.importsAsset} packages/app/src/data.json`,
    ]);
    expect(await edgesOf(store, main, EDGE.importsExternal)).toEqual([
      `${EDGE.importsExternal} react`,
    ]);
    expect(await edgesOf(store, main, EDGE.importsDangling)).toEqual([
      `${EDGE.importsDangling} ./missing`,
    ]);
    expect((await queries.danglingImports()).items).toEqual([
      { from: main, to: './missing', kind: EDGE.importsDangling },
    ]);
  });

  test('re-exports are followed, so a call lands on the defining file', async () => {
    const { store } = await ready();
    const run = 'packages/app/src/main.ts#run';
    const resolved = await edgesOf(store, run, EDGE.calls);
    // `greet` is re-exported by name from ./greet, `add` through `export * from './math'`.
    expect(resolved).toContain(`${EDGE.calls} packages/core/src/greet.ts#greet`);
    expect(resolved).toContain(`${EDGE.calls} packages/core/src/math.ts#add`);
    expect(resolved).toContain(`${EDGE.calls} packages/core/src/index.ts#Store`);
    expect(resolved).toContain(`${EDGE.calls} packages/app/src/helper.ts#helper`);
  });

  test('a method call on a value of unknown type is a marked guess among what the caller can see', async () => {
    const { store } = await ready();
    expect(await edgesOf(store, 'packages/app/src/main.ts#run', EDGE.callsByName)).toEqual([
      `${EDGE.callsByName} packages/core/src/index.ts#Store.put`,
    ]);
  });

  test('external calls and unresolved calls are kept, with what they name', async () => {
    const { store } = await ready();
    const run = 'packages/app/src/main.ts#run';
    expect(await edgesOf(store, run, EDGE.callsExternal)).toEqual([
      `${EDGE.callsExternal} react#default.createElement`,
    ]);
    expect((await edgesOf(store, run, EDGE.callsUnresolved)).sort()).toEqual([
      `${EDGE.callsUnresolved} missing`,
      `${EDGE.callsUnresolved} unknownFn`,
    ]);
  });

  test('runtime built-ins are external to the workspace, and a property call is not the caller itself', async () => {
    const { store } = await ready();
    expect(await edgesOf(store, 'packages/core/src/index.ts#Store')).toEqual([
      `${EDGE.callsExternal} global#Map`,
    ]);
    // `this.cache.get(id)` inside `Store.get` must not link to `Store.get` itself.
    expect(await edgesOf(store, 'packages/core/src/index.ts#Store.get')).toEqual([
      `${EDGE.callsUnresolved} get`,
    ]);
  });

  test('calls inside a package resolve through scope and the enclosing class', async () => {
    const { store } = await ready();
    expect(await edgesOf(store, 'packages/core/src/greet.ts#greet', EDGE.calls)).toEqual([
      `${EDGE.calls} packages/core/src/greet.ts#format`,
    ]);
    expect(await edgesOf(store, 'packages/core/src/index.ts#Store.put', EDGE.calls)).toEqual([
      `${EDGE.calls} packages/core/src/index.ts#Store.log`,
    ]);
    expect(await edgesOf(store, 'packages/core/src/math.ts#twice', EDGE.calls)).toEqual([
      `${EDGE.calls} packages/core/src/math.ts#add`,
    ]);
  });

  test('callers work across packages, and say so', async () => {
    const { queries } = await ready();
    const callers = await queries.callers('packages/core/src/greet.ts#greet');
    expect(callers.items).toEqual([
      {
        from: 'packages/app/src/main.ts#run',
        path: 'packages/app/src/main.ts',
        evidence: 'resolved',
        package: '@acme/app',
        crossPackage: true,
      },
    ]);
    const inPackage = await queries.callers('packages/core/src/math.ts#add');
    expect(inPackage.items.map((c) => [c.from, c.crossPackage])).toEqual([
      ['packages/app/src/main.ts#run', true],
      ['packages/core/src/math.ts#twice', false],
    ]);
  });

  test('a guessed caller is marked, and can be left out', async () => {
    const { queries } = await ready();
    const target = 'packages/core/src/index.ts#Store.put';
    const all = await queries.callers(target);
    expect(all.items.map((c) => c.evidence)).toEqual(['name']);
    expect((await queries.callers(target, { resolvedOnly: true })).items).toEqual([]);
  });

  test('callees list what a symbol calls, unresolved ones included', async () => {
    const { queries } = await ready();
    const callees = await queries.callees('packages/app/src/main.ts#run');
    expect(
      callees.items
        .filter((c) => c.kind === 'unresolved')
        .map((c) => c.to)
        .sort(),
    ).toEqual(['missing', 'unknownFn']);
    expect(callees.items.find((c) => c.kind === 'external')?.to).toBe(
      'react#default.createElement',
    );
    const neighbors = await queries.neighbors('packages/core/src/index.ts#Store.put');
    expect(neighbors.callers.items).toHaveLength(1);
    expect(neighbors.callees.items.map((c) => c.to)).toEqual([
      'packages/core/src/index.ts#Store.log',
    ]);
  });

  test('dependents follow imports and re-exports, by depth, with type-only importers opt-in', async () => {
    const { queries } = await ready();
    const greet = 'packages/core/src/greet.ts';
    const direct = await queries.dependents(greet);
    expect(direct.dependents).toEqual([{ path: 'packages/core/src/index.ts', depth: 1 }]);
    expect(direct.moreBeyondDepth).toBe(true);

    const all = await queries.dependents(greet, { depth: Number.POSITIVE_INFINITY });
    expect(all.dependents).toEqual([
      { path: 'packages/core/src/index.ts', depth: 1 },
      { path: 'packages/app/src/main.ts', depth: 2 },
    ]);
    expect(all.moreBeyondDepth).toBe(false);

    const index = 'packages/core/src/index.ts';
    const runtimeOnly = await queries.dependents(index);
    expect(runtimeOnly.dependents.map((d) => d.path)).toEqual(['packages/app/src/main.ts']);
    const withTypes = await queries.dependents(index, { includeTypeOnly: true });
    expect(withTypes.dependents.map((d) => d.path)).toEqual([
      'packages/app/src/main.ts',
      'packages/app/src/types.ts',
    ]);
    await expect(queries.dependents(index, { depth: 0 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  test('dependencies list what a file imports in the workspace', async () => {
    const { queries } = await ready();
    const page = await queries.dependencies('packages/app/src/main.ts');
    expect([...page.items].sort()).toEqual([
      'packages/app/src/data.json',
      'packages/app/src/helper.ts',
      'packages/core/src/index.ts',
      'packages/core/src/index.ts',
    ]);
  });

  test('the report accounts for every import and call', async () => {
    const { linker } = await ready();
    const fresh = new GraphLinker(fixture.store, fixture.resolver);
    const summary = summarize(await fresh.linkAll());
    expect(summary.imports).toEqual({ resolved: 6, asset: 1, external: 1, dangling: 1 });
    expect(summary.calls.unresolved).toBe(4);
    expect(summary.calls.external).toBe(2);
    expect(summary.unresolvedReasons.get('not declared here or imported')).toBe(1);
    expect(summary.unresolvedReasons.get('the import does not resolve')).toBe(1);
    expect(
      summary.unresolvedReasons.get(
        'receiver type unknown, no method of that name reachable by imports',
      ),
    ).toBe(2);
    void linker;
  });

  test('linking twice gives the same edges', async () => {
    const { store } = await ready();
    const before = await allEdges(store);
    await new GraphLinker(fixture.store, fixture.resolver).linkAll();
    expect(await allEdges(store)).toEqual(before);
  });
});

describe('what to link again when files change', () => {
  test('a modified file sends its importers, and the importers of files that re-export it', async () => {
    const { queries } = await indexFixture(monorepo).then(async (f) => {
      await f.linker.linkAll();
      return f;
    });
    const relink = await queries.relinkSet(
      new Map([['packages/core/src/greet.ts', 'modified' as const]]),
    );
    // main.ts and types.ts import index.ts, which re-exports greet.ts.
    expect(relink).toEqual([
      'packages/app/src/main.ts',
      'packages/app/src/types.ts',
      'packages/core/src/index.ts',
    ]);
  });

  test('a file appearing sends everything that had a dangling import', async () => {
    const fixture = await indexFixture(monorepo);
    await fixture.linker.linkAll();
    const relink = await fixture.queries.relinkSet(
      new Map([['packages/app/src/missing.ts', 'added' as const]]),
    );
    expect(relink).toEqual(['packages/app/src/main.ts']);
  });

  test('a modified file does not wake the dangling importers', async () => {
    const fixture = await indexFixture(monorepo);
    await fixture.linker.linkAll();
    const relink = await fixture.queries.relinkSet(
      new Map([['packages/app/src/helper.ts', 'modified' as const]]),
    );
    expect(relink).toEqual(['packages/app/src/main.ts']);
  });

  test('once the missing file exists and its importer is linked again, the import resolves', async () => {
    const fixture = await indexFixture({
      ...monorepo,
      'packages/app/src/missing.ts': 'export default function missing() {}\n',
    });
    // A file's presence on disk is what resolution consults; a fresh linker sees it.
    await fixture.linker.linkAll();
    expect((await fixture.queries.danglingImports()).items).toEqual([]);
    expect(await edgesOf(fixture.store, 'packages/app/src/main.ts#run', EDGE.calls)).toContain(
      `${EDGE.calls} packages/app/src/missing.ts#missing`,
    );
  });
});

describe('barrels that list what they export', () => {
  const files = {
    'package.json': '{"name":"r"}',
    'lib/create.ts': 'export function create() {}\nexport default function make() {}\n',
    'lib/index.ts': `import { create } from './create';
import make from './create';
function local() {}
export { create, make as maker, local as renamedLocal };
`,
    'app.ts': `import { create, maker, renamedLocal } from './lib';
export function run() { create(); maker(); renamedLocal(); }
`,
  };

  test('an imported name that is exported on is followed to where it is defined', async () => {
    const fixture = await indexFixture(files);
    await fixture.linker.linkAll();
    expect((await edgesOf(fixture.store, 'app.ts#run', EDGE.calls)).sort()).toEqual([
      `${EDGE.calls} lib/create.ts#create`,
      `${EDGE.calls} lib/index.ts#local`,
    ]);
  });
});

describe('what a bare name can mean', () => {
  test('methods are not visible by bare name, and the nearest earlier definition wins', async () => {
    const fixture = await indexFixture({
      'package.json': '{"name":"r"}',
      'a.ts': `const holder = { next() {} };
function helper() { return 1; }
function use1() { helper(); }
function helper2() {}
export function use() { next(); }
`,
      'tests.ts': `function Component() { return 1; }
it('one', () => { Component(); });
function Component() { return 2; }
it('two', () => { Component(); });
`,
    });
    await fixture.linker.linkAll();
    expect(await edgesOf(fixture.store, 'a.ts#use')).toEqual([`${EDGE.callsUnresolved} next`]);
    const calls = (await fixture.store.findEdges({ from: 'tests.ts', kind: EDGE.calls })).items;
    expect(calls.map((e) => e.to)).toEqual(['tests.ts#Component', 'tests.ts#Component~2']);
  });
});

describe('calls on a value whose type is not written', () => {
  const files = {
    'package.json': '{"name":"r"}',
    'a.ts': `import { make } from './b';
export function run(client) { client.send(); client.close(); client.nowhere(); }
`,
    'b.ts': `import { Far } from './c';
export class Near { send() {} }
export function make() { return new Near(); }
`,
    'c.ts': `export class Far { send() {} close() {} }
`,
    'lonely.ts': 'export class Lonely { nowhere() {} }\n',
  };

  test('the nearest method of that name by imports is the guess, and is marked as one', async () => {
    const fixture = await indexFixture(files);
    await fixture.linker.linkAll();
    // `send` is defined in b.ts (one import away) and c.ts (two): the nearer wins.
    expect(await edgesOf(fixture.store, 'a.ts#run', EDGE.callsByName)).toEqual([
      `${EDGE.callsByName} b.ts#Near.send`,
      `${EDGE.callsByName} c.ts#Far.close`,
    ]);
  });

  test('a method no file it can reach defines is unresolved, however common the name elsewhere', async () => {
    const fixture = await indexFixture(files);
    await fixture.linker.linkAll();
    expect(await edgesOf(fixture.store, 'a.ts#run', EDGE.callsUnresolved)).toEqual([
      `${EDGE.callsUnresolved} nowhere`,
    ]);
  });

  test('a method in the same file is nearer than any import', async () => {
    const fixture = await indexFixture({
      ...files,
      'a.ts': `import { make } from './b';
class Local { send() {} }
export function run(client) { client.send(); }
`,
    });
    await fixture.linker.linkAll();
    expect(await edgesOf(fixture.store, 'a.ts#run', EDGE.callsByName)).toEqual([
      `${EDGE.callsByName} a.ts#Local.send`,
    ]);
  });
});

describe('names hidden by parameters', () => {
  const files = {
    'package.json': '{"name":"r"}',
    'a.ts': `function next() {}
export function chain(next: () => void, other: number) {
  next();
  helper();
}
function helper() {}
export const arrow = (helper: () => void) => { helper(); };
export function plain() { next(); }
`,
  };

  test('a parameter is not the top-level function of the same name', async () => {
    const fixture = await indexFixture(files);
    await fixture.linker.linkAll();
    // `next()` inside `chain` calls the parameter; inside `plain` it calls the function.
    expect(await edgesOf(fixture.store, 'a.ts#chain')).toEqual([
      `${EDGE.callsUnresolved} next`,
      `${EDGE.calls} a.ts#helper`,
    ]);
    expect(await edgesOf(fixture.store, 'a.ts#arrow')).toEqual([`${EDGE.callsUnresolved} helper`]);
    expect(await edgesOf(fixture.store, 'a.ts#plain')).toEqual([`${EDGE.calls} a.ts#next`]);
    const summary = summarize(await new GraphLinker(fixture.store, fixture.resolver).linkAll());
    expect(summary.unresolvedReasons.get('a parameter of the enclosing function')).toBe(2);
  });
});

describe('Python packages', () => {
  const files = {
    'pyproject.toml': '[project]\nname = "svc"\n',
    'svc/__init__.py': 'from .core import run\n',
    'svc/core.py': `from . import util
from .models import User
import os


def run():
    util.clean()
    user = User()
    user.save()
    os.getcwd()


class Runner:
    def go(self):
        self.step()
        run()

    def step(self):
        pass
`,
    'svc/util.py': 'def clean():\n    pass\n',
    'svc/models.py': 'class User:\n    def save(self):\n        pass\n',
    'tests/test_core.py': `from svc import run
from svc.core import Runner


def test_it():
    run()
    Runner().go()
`,
  };

  let fixture: Fixture;
  const ready = async () => {
    if (!fixture) {
      fixture = await indexFixture(files);
      await fixture.linker.linkAll();
    }
    return fixture;
  };

  test('imports resolve relative and absolute, and standard-library modules are external', async () => {
    const { store } = await ready();
    expect(await edgesOf(store, 'svc/core.py')).toEqual([
      `${EDGE.imports} svc/__init__.py`,
      `${EDGE.imports} svc/models.py`,
      `${EDGE.importsExternal} os`,
    ]);
  });

  test('calls resolve through module imports, class imports and self', async () => {
    const { store } = await ready();
    expect((await edgesOf(store, 'svc/core.py#run')).sort()).toEqual(
      [
        `${EDGE.calls} svc/util.py#clean`,
        `${EDGE.calls} svc/models.py#User`,
        `${EDGE.callsByName} svc/models.py#User.save`,
        `${EDGE.callsExternal} os#getcwd`,
      ].sort(),
    );
    expect((await edgesOf(store, 'svc/core.py#Runner.go')).sort()).toEqual(
      [`${EDGE.calls} svc/core.py#Runner.step`, `${EDGE.calls} svc/core.py#run`].sort(),
    );
  });

  test('a name a package re-exports from its __init__ resolves to where it is defined', async () => {
    const { store } = await ready();
    const calls = await edgesOf(store, 'tests/test_core.py#test_it', EDGE.calls);
    expect(calls).toEqual([`${EDGE.calls} svc/core.py#run`, `${EDGE.calls} svc/core.py#Runner`]);
    expect(await edgesOf(store, 'tests/test_core.py#test_it', EDGE.callsUnresolved)).toEqual([
      `${EDGE.callsUnresolved} go`,
    ]);
  });

  test('callers of a function found through a package import', async () => {
    const { queries } = await ready();
    const callers = await queries.callers('svc/core.py#run');
    expect(callers.items.map((c) => c.from).sort()).toEqual([
      'svc/core.py#Runner.go',
      'tests/test_core.py#test_it',
    ]);
  });
});

describe('the same graph on every store', () => {
  test('SQLite produces exactly the edges the in-memory store does', async () => {
    const memory = await indexFixture(monorepo, { store: new MemoryIndexStore() });
    await memory.linker.linkAll();

    const database = StoreDatabase.open(':memory:');
    const sqlite = await indexFixture(monorepo, { store: new SqliteIndexStore(database, true) });
    await sqlite.linker.linkAll();

    expect(await allEdges(sqlite.store)).toEqual(await allEdges(memory.store));
    await sqlite.store.close();
  });

  test('a file that is not indexed links to nothing', async () => {
    const { linker } = await indexFixture({ 'a.ts': 'export {};\n' });
    expect(await linker.linkFile('nope.ts')).toBeUndefined();
  });

  test('a resolver and queries can be built by hand over any store', async () => {
    const fixture = await indexFixture({ 'a.ts': "import './b';\n", 'b.ts': 'export {};\n' });
    const resolver = new ImportResolver(new DiskEnvironment(fixture.root), []);
    const linker = new GraphLinker(fixture.store, resolver);
    await linker.linkAll();
    const queries = new GraphQueries(fixture.store);
    expect((await queries.dependents('b.ts')).dependents).toEqual([{ path: 'a.ts', depth: 1 }]);
  });
});
