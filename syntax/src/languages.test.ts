import { describe, expect, test } from 'bun:test';
import { LanguageConflictError, UnknownLanguageError } from './errors.ts';
import { builtinLanguages, type LanguageDef, LanguageRegistry } from './languages.ts';

const registry = new LanguageRegistry();
const keyFor = (path: string) => registry.forPath(path)?.key;

describe('path detection', () => {
  test('uses the file name extension, case-insensitively', () => {
    expect(keyFor('src/app.ts')).toBe('typescript');
    expect(keyFor('src/App.TSX')).toBe('tsx');
    expect(keyFor('C:\\proj\\main.PY')).toBe('python');
  });

  test('a dot in a directory name is not an extension', () => {
    expect(keyFor('release.v1/Makefile')).toBeUndefined();
    expect(keyFor('release.v1/app.ts')).toBe('typescript');
  });

  test('a dotfile has no extension of its own', () => {
    expect(keyFor('.gitignore')).toBeUndefined();
    expect(keyFor('dir/.ts')).toBeUndefined();
  });

  test('a file with no extension is unknown, not an error', () => {
    expect(keyFor('LICENSE')).toBeUndefined();
  });

  test('the longest registered suffix wins, so multi-part extensions work', () => {
    const custom = new LanguageRegistry(builtinLanguages());
    custom.register({
      key: 'dts',
      extensions: ['.d.ts'],
      grammar: { id: 'dts', npmPackage: 'tree-sitter-typescript', file: 'tree-sitter-dts.wasm' },
    });
    expect(custom.forPath('types/index.d.ts')?.key).toBe('dts');
    expect(custom.forPath('types/index.ts')?.key).toBe('typescript');
  });

  test('Vue shares the tsx grammar rather than the typescript one', () => {
    expect(registry.byKey('vue')?.grammar.id).toBe('tsx');
    expect(registry.grammars().filter((g) => g.id === 'tsx')).toHaveLength(1);
  });
});

describe('registration', () => {
  test('a duplicate key is a conflict, not a silent no-op', () => {
    const custom = new LanguageRegistry();
    expect(() =>
      custom.register({ ...(builtinLanguages()[0] as LanguageDef), extensions: ['.zzz'] }),
    ).toThrow(LanguageConflictError);
  });

  test('an extension owned by another language is a conflict that names the owner', () => {
    const custom = new LanguageRegistry();
    const failure = (() => {
      try {
        custom.register({
          key: 'mini-ts',
          extensions: ['.ts'],
          grammar: { id: 'mini', npmPackage: 'x', file: 'x.wasm' },
        });
      } catch (thrown) {
        return thrown as LanguageConflictError;
      }
    })();
    expect(failure).toBeInstanceOf(LanguageConflictError);
    expect(failure?.context).toMatchObject({ existingLanguage: 'typescript' });
  });

  test('one grammar id cannot mean two different files', () => {
    const custom = new LanguageRegistry();
    expect(() =>
      custom.register({
        key: 'other',
        extensions: ['.other'],
        grammar: { id: 'tsx', npmPackage: 'tree-sitter-typescript', file: 'not-tsx.wasm' },
      }),
    ).toThrow(LanguageConflictError);
  });

  test('a failed registration leaves the registry unchanged', () => {
    const custom = new LanguageRegistry();
    const before = custom.languages().length;
    expect(() =>
      custom.register({
        key: 'clash',
        extensions: ['.newext', '.ts'],
        grammar: { id: 'clash', npmPackage: 'x', file: 'x.wasm' },
      }),
    ).toThrow(LanguageConflictError);
    expect(custom.languages()).toHaveLength(before);
    expect(custom.forExtension('.newext')).toBeUndefined();
  });

  test('registries are independent of each other', () => {
    const a = new LanguageRegistry();
    const b = new LanguageRegistry();
    a.register({
      key: 'zed',
      extensions: ['.zed'],
      grammar: { id: 'zed', npmPackage: 'tree-sitter-zed', file: 'tree-sitter-zed.wasm' },
    });
    expect(b.byKey('zed')).toBeUndefined();
  });
});

describe('lookup', () => {
  test('require names what is registered when the key is unknown', () => {
    const failure = (() => {
      try {
        registry.require('cobol');
      } catch (thrown) {
        return thrown as UnknownLanguageError;
      }
    })();
    expect(failure).toBeInstanceOf(UnknownLanguageError);
    expect(failure?.context.known).toContain('typescript');
  });

  test('extensions() lists every registered extension', () => {
    expect(registry.extensions().has('.tsx')).toBe(true);
    expect(registry.extensions().has('.nope')).toBe(false);
  });
});
