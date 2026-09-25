import type { describe, expect, test } from 'bun:test';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { StoreOperationError } from '../errors.ts';
import type { CallFact, ExportFact, FileFacts, ImportFact, SymbolFact } from '../extract/index.ts';
import type { FileQuarantine, IndexedFile, IndexStore } from './types.ts';

/** The test runner's functions, passed in so this file never imports a test framework. */
export interface TestKit {
  readonly describe: typeof describe;
  readonly test: typeof test;
  readonly expect: typeof expect;
}

export interface IndexStoreContractOptions {
  /** A fresh, empty store for one test. */
  readonly make: () => IndexStore | Promise<IndexStore>;
}

function symbol(path: string, name: string, over: Partial<SymbolFact> = {}): SymbolFact {
  const baseName = name.split('.').at(-1) as string;
  return {
    id: `${path}#${name}`,
    path,
    name,
    baseName,
    kind: 'function',
    parentId: undefined,
    exported: undefined,
    startLine: 1,
    endLine: 3,
    signature: `${name}()`,
    doc: undefined,
    ...over,
  };
}

const call = (from: string | undefined, name: string, over: Partial<CallFact> = {}): CallFact => ({
  from,
  name,
  receiver: undefined,
  kind: 'call',
  line: 2,
  ...over,
});

const load = (specifier: string, over: Partial<ImportFact> = {}): ImportFact => ({
  specifier,
  kind: 'static',
  relative: specifier.startsWith('.'),
  typeOnly: false,
  bindings: [{ imported: 'x', local: 'x', typeOnly: false }],
  line: 1,
  ...over,
});

interface FileOptions {
  readonly symbols?: readonly SymbolFact[];
  readonly calls?: readonly CallFact[];
  readonly imports?: readonly ImportFact[];
  readonly exports?: readonly ExportFact[];
  readonly hash?: string;
  readonly wexpr?: IndexedFile['wexpr'];
  readonly language?: string;
}

function file(path: string, options: FileOptions = {}): IndexedFile {
  const facts: FileFacts = {
    path,
    language: options.language ?? 'typescript',
    symbols: options.symbols ?? [],
    calls: options.calls ?? [],
    imports: options.imports ?? [],
    exports: options.exports ?? [],
    hasSyntaxErrors: false,
    importsSupported: true,
    gaps: { unnamedCalls: 0, computedImports: 0 },
  };
  return {
    path,
    language: facts.language,
    packageRoot: 'packages/a',
    repo: '',
    size: 100,
    mtimeMs: 1700000000000.5,
    contentHash: options.hash ?? `hash-${path}`,
    facts,
    ...(options.wexpr ? { wexpr: options.wexpr } : {}),
  };
}

const quarantine = (path: string, over: Partial<FileQuarantine> = {}): FileQuarantine => ({
  path,
  reason: 'unreadable',
  message: 'permission denied',
  size: 7,
  mtimeMs: 5,
  ...over,
});

/**
 * What every `IndexStore` must do. Run it against each implementation: a store that passes can be
 * swapped for another without callers noticing.
 */
export function indexStoreContract(
  kit: TestKit,
  name: string,
  options: IndexStoreContractOptions,
): void {
  const { describe, test, expect } = kit;
  const fresh = () => Promise.resolve(options.make());

  describe(`index store contract: ${name}`, () => {
    test('a file that was never stored is unknown', async () => {
      const store = await fresh();
      expect(await store.fileState('a.ts')).toBeUndefined();
      expect(await store.facts('a.ts')).toBeUndefined();
      expect(await store.symbol('a.ts#x')).toBeUndefined();
      await store.close();
    });

    test('a stored file comes back exactly, facts and all', async () => {
      const store = await fresh();
      const stored = file('src/a.ts', {
        symbols: [
          symbol('src/a.ts', 'Outer', { kind: 'class', exported: true, doc: '/** Owns. */' }),
          symbol('src/a.ts', 'Outer.run', {
            kind: 'method',
            parentId: 'src/a.ts#Outer',
            exported: false,
          }),
          symbol('src/a.ts', 'plain'),
        ],
        calls: [
          call('src/a.ts#Outer.run', 'log', { receiver: { kind: 'self' } }),
          call('src/a.ts#Outer.run', 'send', { receiver: { kind: 'name', name: 'client.http' } }),
          call(undefined, 'chained', { receiver: { kind: 'complex' } }),
          call('src/a.ts#plain', 'Widget', { kind: 'new' }),
        ],
        imports: [
          load('./b', { bindings: [{ imported: 'default', local: 'B', typeOnly: true }] }),
          load('pkg', { kind: 'side-effect', bindings: [], typeOnly: false }),
        ],
      });
      await store.replaceFile(stored);
      expect(await store.facts('src/a.ts')).toEqual(stored.facts);
      expect(await store.fileState('src/a.ts')).toEqual({
        path: 'src/a.ts',
        size: 100,
        mtimeMs: 1700000000000.5,
        contentHash: 'hash-src/a.ts',
        status: 'indexed',
      });
      expect(await store.symbol('src/a.ts#Outer.run')).toEqual(stored.facts.symbols[1]);
      await store.close();
    });

    test('parameter names survive storage, and their absence does too', async () => {
      const store = await fresh();
      const stored = file('a.ts', {
        symbols: [
          symbol('a.ts', 'f', { params: 'a, ...rest' }),
          symbol('a.ts', 'C', { kind: 'class' }),
        ],
      });
      await store.replaceFile(stored);
      expect((await store.facts('a.ts'))?.symbols).toEqual(stored.facts.symbols);
      expect((await store.symbol('a.ts#f'))?.params).toBe('a, ...rest');
      expect((await store.symbol('a.ts#C'))?.params).toBeUndefined();
      await store.close();
    });

    test('names exported by a list survive storage', async () => {
      const store = await fresh();
      const stored = file('barrel.ts', {
        exports: [
          { name: 'a', local: 'a', line: 3 },
          { name: 'default', local: 'b', line: 4 },
        ],
      });
      await store.replaceFile(stored);
      expect((await store.facts('barrel.ts'))?.exports).toEqual(stored.facts.exports);
      await store.replaceFile(file('barrel.ts', { hash: 'h2' }));
      expect((await store.facts('barrel.ts'))?.exports).toEqual([]);
      await store.close();
    });

    test('storing a file again replaces everything held for it', async () => {
      const store = await fresh();
      await store.replaceFile(
        file('a.ts', {
          symbols: [symbol('a.ts', 'old')],
          calls: [call('a.ts#old', 'gone')],
          imports: [load('./old')],
          wexpr: { formatVersion: 1, text: 'old' },
        }),
      );
      await store.replaceFile(file('a.ts', { symbols: [symbol('a.ts', 'fresh')], hash: 'h2' }));
      expect((await store.facts('a.ts'))?.symbols.map((s) => s.name)).toEqual(['fresh']);
      expect((await store.findCalls()).items).toEqual([]);
      expect((await store.findImports()).items).toEqual([]);
      expect(await store.wexpr('a.ts', 1)).toBeUndefined();
      expect((await store.fileState('a.ts'))?.contentHash).toBe('h2');
      await store.close();
    });

    test('symbols are found by exact name, base name, kind, path and export state', async () => {
      const store = await fresh();
      await store.replaceFile(
        file('src/a.ts', {
          symbols: [
            symbol('src/a.ts', 'Outer', { kind: 'class', exported: true }),
            symbol('src/a.ts', 'Outer.run', { kind: 'method', exported: false }),
            symbol('src/a.ts', 'run', { exported: true }),
          ],
        }),
      );
      await store.replaceFile(
        file('lib/b.ts', { symbols: [symbol('lib/b.ts', 'run', { exported: true })] }),
      );
      const names = async (query: Parameters<IndexStore['findSymbols']>[0]) =>
        (await store.findSymbols(query)).items.map((s) => s.id);

      expect(await names({ baseName: 'run' })).toEqual([
        'lib/b.ts#run',
        'src/a.ts#Outer.run',
        'src/a.ts#run',
      ]);
      expect(await names({ name: 'run' })).toEqual(['lib/b.ts#run', 'src/a.ts#run']);
      expect(await names({ kind: 'class' })).toEqual(['src/a.ts#Outer']);
      expect(await names({ path: 'lib/b.ts' })).toEqual(['lib/b.ts#run']);
      expect(await names({ pathPrefix: 'src/' })).toEqual([
        'src/a.ts#Outer',
        'src/a.ts#Outer.run',
        'src/a.ts#run',
      ]);
      expect(await names({ baseName: 'run', exportedOnly: true })).toEqual([
        'lib/b.ts#run',
        'src/a.ts#run',
      ]);
      expect(await names({ name: 'missing' })).toEqual([]);
      await store.close();
    });

    test('calls and imports are found by what they name, with the file they are in', async () => {
      const store = await fresh();
      await store.replaceFile(
        file('a.ts', {
          symbols: [symbol('a.ts', 'f')],
          calls: [call('a.ts#f', 'go'), call(undefined, 'go'), call('a.ts#f', 'stop')],
          imports: [load('./x'), load('./y')],
        }),
      );
      await store.replaceFile(
        file('b.ts', { calls: [call(undefined, 'go')], imports: [load('./x')] }),
      );

      const goers = (await store.findCalls({ name: 'go' })).items;
      expect(goers.map((c) => [c.path, c.from])).toEqual([
        ['a.ts', 'a.ts#f'],
        ['a.ts', undefined],
        ['b.ts', undefined],
      ]);
      expect((await store.findCalls({ from: 'a.ts#f' })).items.map((c) => c.name)).toEqual([
        'go',
        'stop',
      ]);
      expect((await store.findCalls({ path: 'b.ts' })).items).toHaveLength(1);
      expect((await store.findImports({ specifier: './x' })).items.map((i) => i.path)).toEqual([
        'a.ts',
        'b.ts',
      ]);
      expect((await store.findImports({ path: 'a.ts' })).items.map((i) => i.specifier)).toEqual([
        './x',
        './y',
      ]);
      await store.close();
    });

    test('pages cover every match once, in order, and say how much was cut', async () => {
      const store = await fresh();
      const symbols = Array.from({ length: 5 }, (_, i) => symbol('a.ts', `s${i}`));
      await store.replaceFile(file('a.ts', { symbols }));

      const first = await store.findSymbols({ limit: 2 });
      expect(first.items.map((s) => s.name)).toEqual(['s0', 's1']);
      expect(first.total).toBe(5);
      expect(first.limit).toMatchObject({ applied: 2, source: 'caller', reached: true });
      expect(first.nextCursor).not.toBeNull();

      const second = await store.findSymbols({ limit: 2, cursor: first.nextCursor as string });
      expect(second.items.map((s) => s.name)).toEqual(['s2', 's3']);
      const last = await store.findSymbols({ limit: 2, cursor: second.nextCursor as string });
      expect(last.items.map((s) => s.name)).toEqual(['s4']);
      expect(last.nextCursor).toBeNull();
      expect(last.limit.reached).toBe(false);

      const everything = await store.findSymbols();
      expect(everything.items).toHaveLength(5);
      expect(everything.limit.source).toBe('default');
      await store.close();
    });

    test('a bad limit or cursor is a typed argument error', async () => {
      const store = await fresh();
      await expect(store.findSymbols({ limit: 0 })).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(store.findSymbols({ cursor: 'nonsense' })).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
      await store.close();
    });

    test('quarantine replaces the facts, is visible as a state, and ends when the file indexes', async () => {
      const store = await fresh();
      await store.replaceFile(file('a.ts', { symbols: [symbol('a.ts', 'f')] }));
      const entry = quarantine('a.ts', { errorCode: 'SYNTAX_PARSE_FAILED', contentHash: 'abc' });
      await store.quarantineFile(entry);

      expect(await store.facts('a.ts')).toBeUndefined();
      expect((await store.findSymbols()).items).toEqual([]);
      expect(await store.fileState('a.ts')).toEqual({
        path: 'a.ts',
        size: 7,
        mtimeMs: 5,
        contentHash: 'abc',
        status: 'quarantined',
      });
      expect((await store.quarantinedFiles()).items).toEqual([entry]);

      await store.quarantineFile(quarantine('b.ts'));
      expect((await store.fileState('b.ts'))?.contentHash).toBe('');
      expect((await store.quarantinedFiles()).items.map((q) => q.path)).toEqual(['a.ts', 'b.ts']);

      await store.replaceFile(file('a.ts'));
      expect((await store.fileState('a.ts'))?.status).toBe('indexed');
      expect((await store.quarantinedFiles()).items.map((q) => q.path)).toEqual(['b.ts']);
      await store.close();
    });

    test('files lists indexed and quarantined together, by path, filterable', async () => {
      const store = await fresh();
      await store.replaceFile(file('src/b.ts'));
      await store.replaceFile(file('src/a.ts'));
      await store.replaceFile(file('Zed.ts'));
      await store.quarantineFile(quarantine('src/c.bin'));
      await store.replaceFile(file('ünï.ts'));

      const paths = async (query?: Parameters<IndexStore['files']>[0]) =>
        (await store.files(query)).items.map((f) => f.path);
      expect(await paths()).toEqual(['Zed.ts', 'src/a.ts', 'src/b.ts', 'src/c.bin', 'ünï.ts']);
      expect(await paths({ status: 'quarantined' })).toEqual(['src/c.bin']);
      expect(await paths({ status: 'indexed', pathPrefix: 'src/' })).toEqual([
        'src/a.ts',
        'src/b.ts',
      ]);
      await store.close();
    });

    test('removing a file removes everything about it, and says whether it was there', async () => {
      const store = await fresh();
      await store.replaceFile(
        file('a.ts', {
          symbols: [symbol('a.ts', 'f')],
          calls: [call(undefined, 'g')],
          imports: [load('./x')],
          wexpr: { formatVersion: 1, text: 't' },
        }),
      );
      await store.replaceEdges('a.ts', [{ from: 'a.ts#f', to: 'b.ts#g', kind: 'calls' }]);
      await store.quarantineFile(quarantine('q.ts'));

      expect(await store.removeFile('a.ts')).toBe(true);
      expect(await store.removeFile('a.ts')).toBe(false);
      expect(await store.removeFile('q.ts')).toBe(true);
      expect(await store.stats()).toMatchObject({
        files: 0,
        quarantinedFiles: 0,
        symbols: 0,
        calls: 0,
        imports: 0,
        edges: 0,
      });
      await store.close();
    });

    test('cached structure is served for its own format version only', async () => {
      const store = await fresh();
      await store.replaceFile(file('a.ts', { wexpr: { formatVersion: 2, text: '(program)' } }));
      await store.replaceFile(file('b.ts'));
      expect(await store.wexpr('a.ts', 2)).toBe('(program)');
      expect(await store.wexpr('a.ts', 3)).toBeUndefined();
      expect(await store.wexpr('b.ts', 2)).toBeUndefined();
      await store.close();
    });

    test('edges belong to the file they start from, and go when it is replaced', async () => {
      const store = await fresh();
      await store.replaceFile(file('a.ts'));
      await store.replaceFile(file('b.ts'));
      await store.replaceEdges('a.ts', [
        { from: 'a.ts', to: 'b.ts', kind: 'imports' },
        { from: 'a.ts#f', to: 'b.ts#g', kind: 'calls' },
      ]);
      await store.replaceEdges('b.ts', [{ from: 'b.ts', to: 'c.ts', kind: 'imports' }]);

      const edges = async (query?: Parameters<IndexStore['findEdges']>[0]) =>
        (await store.findEdges(query)).items;
      expect(await edges()).toHaveLength(3);
      expect(await edges({ to: 'b.ts' })).toEqual([
        { from: 'a.ts', to: 'b.ts', kind: 'imports', confidence: 'exact' },
      ]);
      expect((await edges({ kind: 'calls' })).map((e) => e.to)).toEqual(['b.ts#g']);
      expect((await edges({ from: 'b.ts' })).map((e) => e.to)).toEqual(['c.ts']);
      expect((await edges({ kinds: ['calls', 'imports'] })).map((e) => e.to)).toEqual([
        'b.ts',
        'b.ts#g',
        'c.ts',
      ]);
      expect(await edges({ kinds: [] })).toEqual([]);
      expect(await edges({ kind: 'calls', kinds: ['imports'] })).toEqual([]);

      await store.replaceEdges('b.ts', [
        { from: 'b.ts#h', to: 'a.ts#f', kind: 'calls:name', confidence: 'guess' },
      ]);
      expect((await edges({ from: 'b.ts#h' })).map((e) => e.confidence)).toEqual(['guess']);
      await store.replaceEdges('b.ts', [{ from: 'b.ts', to: 'c.ts', kind: 'imports' }]);

      await store.replaceEdges('a.ts', [{ from: 'a.ts', to: 'z.ts', kind: 'imports' }]);
      expect((await edges()).map((e) => e.to)).toEqual(['z.ts', 'c.ts']);

      await store.replaceFile(file('a.ts', { hash: 'changed' }));
      expect((await edges()).map((e) => e.to)).toEqual(['c.ts']);
      await store.close();
    });

    test('edges for a file that is not in the index are refused', async () => {
      const store = await fresh();
      await expect(
        store.replaceEdges('missing.ts', [{ from: 'a', to: 'b', kind: 'calls' }]),
      ).rejects.toBeInstanceOf(StoreOperationError);
      await store.close();
    });

    test('touching a file updates its stamp and nothing else', async () => {
      const store = await fresh();
      await store.replaceFile(file('a.ts', { symbols: [symbol('a.ts', 'f')] }));
      expect(await store.touchFile('a.ts', 555, 1234.5)).toBe(true);
      expect(await store.fileState('a.ts')).toMatchObject({
        size: 555,
        mtimeMs: 1234.5,
        contentHash: 'hash-a.ts',
        status: 'indexed',
      });
      expect((await store.facts('a.ts'))?.symbols).toHaveLength(1);
      expect(await store.touchFile('nope.ts', 1, 1)).toBe(false);
      await store.close();
    });

    test('metadata is a key-value store that can be overwritten', async () => {
      const store = await fresh();
      expect(await store.getMeta('k')).toBeUndefined();
      await store.setMeta('k', 'one');
      await store.setMeta('k', 'two');
      expect(await store.getMeta('k')).toBe('two');
      expect(await store.deleteMeta('k')).toBe(true);
      expect(await store.deleteMeta('k')).toBe(false);
      expect(await store.getMeta('k')).toBeUndefined();
      await store.close();
    });

    test('stats count what is held, by language too', async () => {
      const store = await fresh();
      await store.replaceFile(
        file('a.ts', {
          symbols: [symbol('a.ts', 'f'), symbol('a.ts', 'g')],
          calls: [call(undefined, 'x')],
          imports: [load('./y')],
        }),
      );
      await store.replaceFile(file('b.py', { language: 'python', symbols: [symbol('b.py', 'h')] }));
      await store.quarantineFile(quarantine('c.ts'));
      expect(await store.stats()).toEqual({
        files: 2,
        quarantinedFiles: 1,
        symbols: 3,
        calls: 1,
        imports: 1,
        edges: 0,
        byLanguage: [
          { language: 'python', files: 1 },
          { language: 'typescript', files: 1 },
        ],
      });
      await store.close();
    });
  });
}
