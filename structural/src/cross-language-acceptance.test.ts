import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { StructuralIndex } from './corpus.ts';
import { DocblockAnnotationCorpusAdapter } from './corpus-adapter.ts';
import type { EncodedFile } from './engine.ts';
import type { WNode } from './node.ts';
import { compilePattern } from './pattern/compiler.ts';
import type { PatternSpec } from './pattern/schema.ts';
import { disposeEngines, makeEngine } from './test-support.ts';
import { matchWql, parseWql } from './wql.ts';

const engine = makeEngine();
afterAll(disposeEngines);

const tsCode = [
  '/**',
  ' * @corpus(endpoint)',
  ' * User management service.',
  ' */',
  'export class UserService {',
  '  /**',
  '   * @endpoint',
  '   * Save user data.',
  '   */',
  '  save(user: string): boolean {',
  '    return true;',
  '  }',
  '}',
  '/**',
  ' * @corpus(utility)',
  ' */',
  'export function standaloneTs(x: number): number {',
  '  return x * 2;',
  '}',
].join('\n');

const pyCode = [
  '"""',
  '@corpus(service)',
  'Account operations.',
  '"""',
  'class AccountService:',
  '    """',
  '    @endpoint',
  '    Deposit funds.',
  '    """',
  '    def deposit(self, amount: int) -> bool:',
  '        return True',
  '"""',
  '@corpus(utility)',
  '"""',
  'def standalone_py(x: int) -> int:',
  '    return x * 2',
].join('\n');

const goCode = [
  '// @endpoint Save record to database',
  'func (r *Repo) Save() bool { return true }',
  '// @corpus(utility) Helper function',
  'func StandaloneGo() int { return 42 }',
].join('\n');

const rsCode = [
  '/// @endpoint Save service entity',
  'fn save(&self) -> bool { true }',
  '/// @corpus(utility) Standalone utility',
  'fn standalone_rs() -> i32 { 42 }',
].join('\n');

function makeGoAst(): WNode {
  return {
    tag: 'source_file',
    attrs: new Map(),
    children: [
      {
        tag: 'type_declaration',
        attrs: new Map([['name', 'Repo']]),
        children: [
          {
            tag: 'struct',
            attrs: new Map([['name', 'Repo']]),
            children: [],
          },
        ],
      },
      {
        tag: 'method',
        attrs: new Map([
          ['name', 'Repo.Save'],
          ['baseName', 'Save'],
          ['callable', 'true'],
          ['isMethod', 'true'],
          ['doc', '@endpoint Save record to database'],
        ]),
        children: [],
      },
      {
        tag: 'function',
        attrs: new Map([
          ['name', 'StandaloneGo'],
          ['baseName', 'StandaloneGo'],
          ['callable', 'true'],
          ['doc', '@corpus(utility) Helper function'],
        ]),
        children: [],
      },
    ],
  };
}

function makeRustAst(): WNode {
  return {
    tag: 'source_file',
    attrs: new Map(),
    children: [
      {
        tag: 'impl',
        attrs: new Map([['name', 'Service']]),
        children: [
          {
            tag: 'function',
            attrs: new Map([
              ['name', 'Service.save'],
              ['baseName', 'save'],
              ['callable', 'true'],
              ['isMethod', 'true'],
              ['doc', '@endpoint Save service entity'],
            ]),
            children: [],
          },
        ],
      },
      {
        tag: 'function',
        attrs: new Map([
          ['name', 'standalone_rs'],
          ['baseName', 'standalone_rs'],
          ['callable', 'true'],
          ['doc', '@corpus(utility) Standalone utility'],
        ]),
        children: [],
      },
    ],
  };
}

describe('Cross-Language Acceptance Suite (TS, Python, Go, Rust)', () => {
  let tsFile: EncodedFile;
  let pyFile: EncodedFile;
  let goRoot: WNode;
  let rustRoot: WNode;

  beforeAll(async () => {
    tsFile = await engine.encode(tsCode, { path: 'src/user.ts' });
    pyFile = await engine.encode(pyCode, { path: 'src/account.py' });
    goRoot = makeGoAst();
    rustRoot = makeRustAst();
  });

  describe('AST Normalization & Virtual Tags across 4 languages', () => {
    test('//callable matches all callables across TS, Python, Go, Rust', () => {
      const q = parseWql('//callable');
      const tsHits = matchWql(q, [tsFile.root]);
      const pyHits = matchWql(q, [pyFile.root]);
      const goHits = matchWql(q, [goRoot]);
      const rsHits = matchWql(q, [rustRoot]);

      expect(tsHits.length).toBe(2); // save, standaloneTs
      expect(pyHits.length).toBe(2); // deposit, standalone_py
      expect(goHits.length).toBe(2); // Repo.Save, StandaloneGo
      expect(rsHits.length).toBe(2); // Service.save, standalone_rs
    });

    test('//method matches class/struct/impl methods across all 4 languages', () => {
      const q = parseWql('//method');
      const tsHits = matchWql(q, [tsFile.root]);
      const pyHits = matchWql(q, [pyFile.root]);
      const goHits = matchWql(q, [goRoot]);
      const rsHits = matchWql(q, [rustRoot]);

      expect(tsHits.length).toBe(1);
      expect(tsHits[0]?.node.attrs.get('baseName')).toBe('save');

      expect(pyHits.length).toBe(1);
      expect(pyHits[0]?.node.attrs.get('baseName')).toBe('deposit');

      expect(goHits.length).toBe(1);
      expect(goHits[0]?.node.attrs.get('baseName')).toBe('Save');

      expect(rsHits.length).toBe(1);
      expect(rsHits[0]?.node.attrs.get('baseName')).toBe('save');
    });

    test('//function matches standalone functions across all 4 languages', () => {
      expect(matchWql(parseWql('//function[@name="standaloneTs"]'), [tsFile.root]).length).toBe(1);
      expect(matchWql(parseWql('//function[@name="standalone_py"]'), [pyFile.root]).length).toBe(1);
      expect(matchWql(parseWql('//function[@name="StandaloneGo"]'), [goRoot]).length).toBe(1);
      expect(matchWql(parseWql('//function[@name="standalone_rs"]'), [rustRoot]).length).toBe(1);
    });
  });

  describe('Corpus Extraction across languages', () => {
    test('extracts @endpoint and @corpus annotations into CorpusRecords', () => {
      const adapter = new DocblockAnnotationCorpusAdapter();
      const records = [
        ...adapter.extract({ path: 'src/user.ts', content: tsCode }),
        ...adapter.extract({ path: 'src/account.py', content: pyCode }),
        ...adapter.extract({ path: 'src/repo.go', content: goCode }),
        ...adapter.extract({ path: 'src/service.rs', content: rsCode }),
      ];

      const endpoints = records.filter((r) => r.attrs.tag === 'endpoint');
      expect(endpoints.length).toBeGreaterThanOrEqual(4);
      expect(endpoints.map((e) => e.path)).toEqual(
        expect.arrayContaining(['src/user.ts', 'src/account.py', 'src/repo.go', 'src/service.rs']),
      );

      const utilities = records.filter((r) => r.attrs.tag === 'corpus');
      expect(utilities.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Pattern Compilation, Binding & Execution', () => {
    test('compiles declarative pattern and runs across multi-language index', () => {
      const spec: PatternSpec = {
        name: 'save-operations',
        description: 'Finds all save methods across all languages',
        target: {
          kind: 'callable',
          name: '$name',
        },
        params: [{ name: 'name', default: 'save', required: false }],
      };

      const compiled = compilePattern(spec);
      expect(compiled.templateWql).toBe('//callable[@name="$name"]');

      const bound = compiled.bind({ name: 'save' });
      expect(bound.wql).toBe('//callable[@name="save"]');

      const index = new StructuralIndex();
      index.set({ path: 'src/user.ts', root: tsFile.root });
      index.set({ path: 'src/account.py', root: pyFile.root });
      index.set({ path: 'src/repo.go', root: goRoot });
      index.set({ path: 'src/service.rs', root: rustRoot });

      const hits = index.query(bound.wql);
      expect(hits.items.length).toBeGreaterThanOrEqual(2);
      const names = hits.items.map((i) => i.name);
      expect(names).toContain('UserService.save');
      expect(names).toContain('Service.save');
    });

    test('generates diagnostic hints for zero matches in Python when function vs method used', () => {
      const spec: PatternSpec = {
        name: 'py-method-search',
        description: 'Search for method in Python',
        target: {
          kind: 'method',
          name: 'non_existent_method',
        },
      };

      const compiled = compilePattern(spec);
      const diag = compiled.diagnoseResults(0, ['python']);
      expect(diag).toBeDefined();
      expect(diag?.hint).toContain('In Python files without class scope');
      expect(diag?.hint).toContain('Consider kind "callable"');
    });
  });
});
