import { afterAll, describe, expect, test } from 'bun:test';
import { Deadline, OperationAbortedError } from '@cntxt-labs/code-lens-core';
import { LanguageRegistry, npmPackageSource, SyntaxRuntime } from '@cntxt-labs/code-lens-syntax';
import { StructuralEngine } from './engine.ts';
import { MappingNotFoundError } from './errors.ts';
import { validateMapping } from './mapping.ts';
import { disposeEngines, makeEngine, treesEqual } from './test-support.ts';
import { parseWExpr, serializeWExpr } from './text.ts';
import { matchWql, parseWql } from './wql.ts';

const engine = makeEngine();
afterAll(disposeEngines);

const source = `export class Parser {
  parse(input: string) { return input; }
  reset() {}
}
export class Lexer {
  parse() { return 1; }
}
export function parse() { return 2; }`;

describe('encode', () => {
  test('takes the language from an explicit target or from the path', async () => {
    const explicit = await engine.encode('const a = 1;', { language: 'javascript' });
    expect(explicit.language).toBe('javascript');
    expect(explicit.path).toBeUndefined();
    const inferred = await engine.encode('const a = 1;', { path: 'x/y.tsx' });
    expect(inferred.language).toBe('tsx');
    expect(inferred.path).toBe('x/y.tsx');
  });

  test('an explicit path option labels the tree even when the target is a language', async () => {
    const encoded = await engine.encode(
      'const a = 1;',
      { language: 'typescript' },
      { path: 'virtual.ts' },
    );
    expect(encoded.path).toBe('virtual.ts');
    expect(encoded.root.attrs.get('path')).toBe('virtual.ts');
  });

  test('is deterministic', async () => {
    const [a, b] = await Promise.all([
      engine.encode(source, { path: 'a.ts' }),
      engine.encode(source, { path: 'a.ts' }),
    ]);
    expect(treesEqual(a.root, b.root)).toBe(true);
  });

  test('never leaves a syntax tree undisposed, on success or failure', async () => {
    await engine.encode(source, { path: 'a.ts' });
    await engine.encode('function (', { path: 'broken.ts' });
    expect(engine.runtime.liveTrees).toBe(0);
  });

  test('a cancelled deadline stops before parsing, with a typed error', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.encode(
        source,
        { path: 'a.ts' },
        { deadline: Deadline.of({ signal: controller.signal }) },
      ),
    ).rejects.toBeInstanceOf(OperationAbortedError);
  });
});

describe('a language that parses but has no mapping', () => {
  const registry = new LanguageRegistry();
  registry.register({
    key: 'demo',
    extensions: ['.demo'],
    grammar: { id: 'tsx', npmPackage: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  });
  const runtime = new SyntaxRuntime({
    registry,
    sources: [npmPackageSource(import.meta.filename)],
  });
  const custom = new StructuralEngine({ runtime });
  afterAll(() => runtime.dispose());

  test('fails with a typed error naming the languages that are mapped, and frees the tree', async () => {
    const failure = await custom.encode('const a = 1;', { language: 'demo' }).catch((e) => e);
    expect(failure).toBeInstanceOf(MappingNotFoundError);
    expect(failure.context.language).toBe('demo');
    expect(failure.context.known).toContain('typescript');
    expect(runtime.liveTrees).toBe(0);
  });

  test('registering a mapping makes the same language work', async () => {
    const mapping = validateMapping({
      name: 'demo',
      extensions: ['.demo'],
      nodeTypeMap: { function_declaration: 'function' },
      structuralTags: ['function'],
      nameExtractors: {},
    });
    // With no explicit list, a mapping serves the language named after itself.
    custom.mappings.register(mapping);
    const encoded = await custom.encode('function hi() {}', { language: 'demo' });
    expect(encoded.root.children.map((n) => n.tag)).toEqual(['function']);
    expect(encoded.root.children[0]?.attrs.get('name')).toBe('hi');
    expect(() => custom.mappings.register(mapping)).toThrow(/already belongs/);
  });
});

describe('queryDirect', () => {
  test('finds symbols in one piece of source and reports where they are', async () => {
    const result = await engine.queryDirect('//method[@name="parse"]', source, {
      path: 'src/p.ts',
    });
    expect(result.items.map((h) => [h.name, h.startLine, h.endLine, h.path])).toEqual([
      ['Parser.parse', 2, 2, 'src/p.ts'],
      ['Lexer.parse', 6, 6, 'src/p.ts'],
    ]);
    expect(result.items[0]?.params).toBe('input');
    expect(result.file.language).toBe('typescript');
    expect(result.limit).toMatchObject({ source: 'default', reached: false });
  });

  test('a qualified name and its suffix both find the same symbol', async () => {
    const bare = await engine.queryDirect('//*[@name="Lexer.parse"]', source, { path: 'a.ts' });
    expect(bare.items).toHaveLength(1);
    expect(bare.items[0]?.name).toBe('Lexer.parse');
  });

  test('@path is answered from the target', async () => {
    const hit = await engine.queryDirect('//class[@path="src/p.ts"]', source, { path: 'src/p.ts' });
    expect(hit.items).toHaveLength(2);
    const miss = await engine.queryDirect('//class[@path="other.ts"]', source, {
      path: 'src/p.ts',
    });
    expect(miss.items).toHaveLength(0);
  });

  test('pages through results with a cursor and reports the limit', async () => {
    const first = await engine.queryDirect('//*[@name]', source, { path: 'a.ts' }, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.limit).toMatchObject({ applied: 3, source: 'caller', reached: true });
    const second = await engine.queryDirect(
      '//*[@name]',
      source,
      { path: 'a.ts' },
      { limit: 100, cursor: first.nextCursor as string },
    );
    const everything = await engine.queryDirect('//*[@name]', source, { path: 'a.ts' });
    expect([...first.items, ...second.items].map((h) => h.name)).toEqual(
      everything.items.map((h) => h.name),
    );
  });

  test('a malformed query fails before anything is parsed', async () => {
    await expect(engine.queryDirect('//class[@name=]', source, { path: 'a.ts' })).rejects.toThrow(
      /offset 14/,
    );
  });
});

describe('storing outlines', () => {
  test('an encoded file round-trips through text and answers queries identically', async () => {
    const encoded = await engine.encode(source, { path: 'src/p.ts' });
    const restored = parseWExpr(serializeWExpr(encoded.root));
    expect(treesEqual(restored, encoded.root)).toBe(true);
    const query = parseWql('//class[@name="Parser"]>method');
    const names = (root: typeof restored) =>
      matchWql(query, [root]).map((m) => m.node.attrs.get('name'));
    expect(names(restored)).toEqual(names(encoded.root));
    expect(names(restored)).toEqual(['Parser.parse', 'Parser.reset']);
  });
});
