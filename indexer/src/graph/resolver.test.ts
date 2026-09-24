import { describe, expect, test } from 'bun:test';
import { ManifestInvalidError } from '../errors.ts';
import type { ImportFact } from '../extract/index.ts';
import type { WorkspacePackage } from '../workspace/discover.ts';
import { parseJsonc } from './jsonc.ts';
import { dirname, join } from './paths.ts';
import {
  ImportResolver,
  type Resolution,
  type ResolverEnvironment,
  scriptCandidates,
  splitPackage,
} from './resolver.ts';
import { AliasResolver, aliasCandidates } from './tsconfig.ts';

/** An environment over a map of path -> text. */
function environment(files: Record<string, string>): ResolverEnvironment {
  return {
    exists: async (path) => path in files,
    read: async (path) => files[path],
  };
}

const npm = (name: string, root: string): WorkspacePackage => ({
  name,
  root,
  kind: 'npm',
  manifest: `${root}/package.json`,
  dependsOn: [],
});
const python = (name: string, root: string): WorkspacePackage => ({
  name,
  root,
  kind: 'python',
  manifest: undefined,
  dependsOn: [],
});

const fact = (specifier: string, over: Partial<ImportFact> = {}): ImportFact => ({
  specifier,
  kind: 'static',
  relative: specifier.startsWith('.'),
  typeOnly: false,
  bindings: [],
  line: 1,
  ...over,
});

const resolveTs = async (
  files: Record<string, string>,
  from: string,
  specifier: string,
  packages: WorkspacePackage[] = [],
): Promise<Resolution> =>
  (
    await new ImportResolver(environment(files), packages).resolve(
      from,
      fact(specifier),
      'typescript',
    )
  ).resolution;

describe('paths', () => {
  test('join normalises, and refuses to leave the workspace', () => {
    expect(join('a/b', '../c')).toBe('a/c');
    expect(join('a', '..')).toBe('');
    expect(join('a', '../..')).toBeUndefined();
    expect(join('', 'x')).toBe('x');
    expect(dirname('a/b.ts')).toBe('a');
    expect(dirname('b.ts')).toBe('');
  });
});

describe('JSON with comments', () => {
  test('comments, trailing commas and slashes inside strings', () => {
    const text = `{
      // a comment
      "url": "https://example.com/a//b", /* inline */
      "list": [1, 2,],
      "nested": { "x": "y", },
    }`;
    expect(parseJsonc(text, 'tsconfig.json')).toEqual({
      url: 'https://example.com/a//b',
      list: [1, 2],
      nested: { x: 'y' },
    });
  });

  test('invalid JSON is a typed error that names the file', () => {
    expect(() => parseJsonc('{oops', 'a/tsconfig.json')).toThrow(ManifestInvalidError);
    try {
      parseJsonc('{oops', 'a/tsconfig.json');
    } catch (thrown) {
      expect((thrown as ManifestInvalidError).message).toContain('a/tsconfig.json');
    }
  });
});

describe('script file candidates', () => {
  test('an extensionless path tries extensions, then folder indexes', () => {
    const list = scriptCandidates('src/util');
    expect(list[0]).toBe('src/util');
    expect(list).toContain('src/util.ts');
    expect(list).toContain('src/util/index.tsx');
    expect(list.indexOf('src/util.ts')).toBeLessThan(list.indexOf('src/util.js'));
  });

  test('a compiled extension may be a source file: ./x.js is x.ts', () => {
    expect(scriptCandidates('src/x.js')).toEqual(['src/x.ts', 'src/x.tsx', 'src/x.js']);
    expect(scriptCandidates('src/x.mjs')).toContain('src/x.mts');
  });

  test('a declaration file stands for its source', () => {
    expect(scriptCandidates('dist/x.d.ts')).toContain('dist/x.ts');
  });

  test('a dotted name that is not an extension is still a base name', () => {
    expect(scriptCandidates('src/a.test')).toContain('src/a.test.ts');
  });

  test('scoped and plain package names split from their subpath', () => {
    expect(splitPackage('@scope/pkg/deep/x')).toEqual({ name: '@scope/pkg', subpath: 'deep/x' });
    expect(splitPackage('pkg')).toEqual({ name: 'pkg', subpath: '' });
    expect(splitPackage('lodash/fp')).toEqual({ name: 'lodash', subpath: 'fp' });
  });
});

describe('relative imports', () => {
  const files = {
    'src/a.ts': '',
    'src/util.ts': '',
    'src/lib/index.ts': '',
    'src/style.css': '',
    'src/data.json': '',
  };

  test.each([
    ['./util', 'src/util.ts'],
    ['./util.js', 'src/util.ts'],
    ['./lib', 'src/lib/index.ts'],
    ['../src/util', 'src/util.ts'],
    ['./style.css', 'src/style.css'],
    ['./data.json', 'src/data.json'],
  ])('%s', async (specifier, expected) => {
    expect(await resolveTs(files, 'src/a.ts', specifier)).toEqual({
      kind: 'file',
      path: expected,
      via: 'relative',
    });
  });

  test('when both x.ts and x.js exist, ./x.js means the source, as it does to the compiler', async () => {
    const both = { 'src/a.ts': '', 'src/x.ts': '', 'src/x.js': '' };
    expect(await resolveTs(both, 'src/a.ts', './x.js')).toMatchObject({ path: 'src/x.ts' });
    const onlyJs = { 'src/a.ts': '', 'src/x.js': '' };
    expect(await resolveTs(onlyJs, 'src/a.ts', './x.js')).toMatchObject({ path: 'src/x.js' });
  });

  test('a missing file is dangling, and says everything that was tried', async () => {
    const result = await resolveTs(files, 'src/a.ts', './nope');
    expect(result).toMatchObject({ kind: 'dangling', reason: 'no such file' });
    expect(result).toMatchObject({
      tried: expect.arrayContaining(['src/nope.ts', 'src/nope/index.ts']),
    });
  });

  test('a path above the workspace root is dangling with that reason', async () => {
    const result = await resolveTs(files, 'a.ts', '../outside');
    expect(result).toMatchObject({ kind: 'dangling', reason: 'the path leaves the workspace' });
  });
});

describe('bare imports', () => {
  test('packages outside the workspace and runtime built-ins are external', async () => {
    expect(await resolveTs({}, 'a.ts', 'react')).toEqual({ kind: 'external', name: 'react' });
    expect(await resolveTs({}, 'a.ts', '@scope/thing/deep')).toEqual({
      kind: 'external',
      name: '@scope/thing',
    });
    expect(await resolveTs({}, 'a.ts', 'node:fs')).toEqual({ kind: 'external', name: 'node:fs' });
    expect(await resolveTs({}, 'a.ts', 'fs')).toEqual({ kind: 'external', name: 'fs' });
  });
});

describe('workspace packages', () => {
  const packages = [npm('@acme/core', 'packages/core'), npm('@acme/ui', 'packages/ui')];

  const at = (files: Record<string, string>, specifier: string) =>
    resolveTs({ 'packages/app/a.ts': '', ...files }, 'packages/app/a.ts', specifier, packages);

  test('the entry comes from main', async () => {
    const result = await at(
      {
        'packages/core/package.json': JSON.stringify({ main: 'lib/index.js' }),
        'packages/core/lib/index.js': '',
      },
      '@acme/core',
    );
    expect(result).toEqual({ kind: 'file', path: 'packages/core/lib/index.js', via: 'package' });
  });

  test('build output is mapped back to the source that produced it', async () => {
    const result = await at(
      {
        'packages/core/package.json': JSON.stringify({
          main: './dist/index.js',
          types: './dist/index.d.ts',
        }),
        'packages/core/src/index.ts': '',
      },
      '@acme/core',
    );
    expect(result).toEqual({ kind: 'file', path: 'packages/core/src/index.ts', via: 'package' });
  });

  test('exports conditions are read, preferring source and types', async () => {
    const result = await at(
      {
        'packages/core/package.json': JSON.stringify({
          exports: {
            '.': { import: './dist/x.js', types: './src/entry.ts', default: './dist/x.js' },
          },
        }),
        'packages/core/src/entry.ts': '',
      },
      '@acme/core',
    );
    expect(result).toMatchObject({ kind: 'file', path: 'packages/core/src/entry.ts' });
  });

  test('a package with no entry fields falls back to index and src/index', async () => {
    const withSrc = await at(
      { 'packages/core/package.json': '{}', 'packages/core/src/index.ts': '' },
      '@acme/core',
    );
    expect(withSrc).toMatchObject({ path: 'packages/core/src/index.ts' });
    const flat = await at(
      { 'packages/core/package.json': '{}', 'packages/core/index.js': '' },
      '@acme/core',
    );
    expect(flat).toMatchObject({ path: 'packages/core/index.js' });
  });

  test('a subpath goes through an exact or wildcard exports entry, else the folder', async () => {
    const manifest = JSON.stringify({
      exports: {
        '.': './src/index.ts',
        './utils': './src/utils/index.ts',
        './features/*': './src/features/*.ts',
      },
    });
    const files = {
      'packages/core/package.json': manifest,
      'packages/core/src/index.ts': '',
      'packages/core/src/utils/index.ts': '',
      'packages/core/src/features/login.ts': '',
      'packages/ui/package.json': '{}',
      'packages/ui/src/button.tsx': '',
    };
    expect(await at(files, '@acme/core/utils')).toMatchObject({
      path: 'packages/core/src/utils/index.ts',
    });
    expect(await at(files, '@acme/core/features/login')).toMatchObject({
      path: 'packages/core/src/features/login.ts',
    });
    expect(await at(files, '@acme/ui/button')).toMatchObject({
      path: 'packages/ui/src/button.tsx',
    });
  });

  test('a workspace package whose entry is missing is dangling, not external', async () => {
    const result = await at({ 'packages/core/package.json': '{"main":"gone.js"}' }, '@acme/core');
    expect(result).toMatchObject({ kind: 'dangling' });
    expect((result as { reason: string }).reason).toContain('@acme/core');
  });

  test('an invalid package.json is a reason, not a crash', async () => {
    const result = await at({ 'packages/core/package.json': '{oops' }, '@acme/core');
    expect(result).toMatchObject({ kind: 'dangling' });
    expect((result as { reason: string }).reason).toContain('not valid');
  });
});

describe('tsconfig aliases', () => {
  const config = `{
      // comments are fine
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~lib": ["lib/main.ts"], }, },
    }`;

  test('paths map a prefix, and the longest matching pattern wins', () => {
    const resolved = {
      source: 'tsconfig.json',
      baseUrl: undefined,
      rules: [
        { pattern: '@/*', targets: ['src/*'] },
        { pattern: '@/deep/*', targets: ['other/*'] },
        { pattern: 'exact', targets: ['lib/exact.ts'] },
      ],
    };
    expect(aliasCandidates(resolved, '@/util')).toEqual(['src/util']);
    expect(aliasCandidates(resolved, '@/deep/x')).toEqual(['other/x']);
    expect(aliasCandidates(resolved, 'exact')).toEqual(['lib/exact.ts']);
    expect(aliasCandidates(resolved, 'nothing')).toEqual([]);
  });

  test('an alias resolves to a file, and a matching alias with no file is dangling', async () => {
    const files = {
      'tsconfig.json': config,
      'src/util.ts': '',
      'src/app/a.ts': '',
      'lib/main.ts': '',
    };
    expect(await resolveTs(files, 'src/app/a.ts', '@/util')).toEqual({
      kind: 'file',
      path: 'src/util.ts',
      via: 'alias',
    });
    expect(await resolveTs(files, 'src/app/a.ts', '~lib')).toMatchObject({ path: 'lib/main.ts' });
    expect(await resolveTs(files, 'src/app/a.ts', '@/missing')).toMatchObject({
      kind: 'dangling',
      reason: 'a tsconfig path alias matches but no file does',
    });
  });

  test('baseUrl lets a bare specifier name a file under it', async () => {
    const files = {
      'tsconfig.json': '{"compilerOptions":{"baseUrl":"src"}}',
      'src/shared/thing.ts': '',
      'src/a.ts': '',
    };
    expect(await resolveTs(files, 'src/a.ts', 'shared/thing')).toMatchObject({
      kind: 'file',
      path: 'src/shared/thing.ts',
    });
  });

  test('the nearest config wins, and extends carries paths through, relative to their config', async () => {
    const env = environment({
      'tsconfig.base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["libs/*"]}}}',
      'apps/web/tsconfig.json': '{"extends":"../../tsconfig.base.json"}',
      'apps/web/src/a.ts': '',
      'libs/x.ts': '',
    });
    const aliases = new AliasResolver(env);
    const found = await aliases.configFor('apps/web/src');
    expect(found?.source).toBe('apps/web/tsconfig.json');
    expect(aliasCandidates(found as NonNullable<typeof found>, '@lib/x')).toEqual(['libs/x']);
  });

  test('a config that extends itself in a cycle does not loop', async () => {
    const env = environment({
      'tsconfig.json': '{"extends":"./tsconfig.json"}',
    });
    expect(await new AliasResolver(env).configFor('')).toMatchObject({ rules: [] });
  });
});

describe('Python', () => {
  const resolvePy = async (
    files: Record<string, string>,
    from: string,
    specifier: string,
    bindings: string[] = [],
    packages: WorkspacePackage[] = [],
  ) =>
    new ImportResolver(environment(files), packages).resolve(
      from,
      fact(specifier, {
        bindings: bindings.map((name) => ({ imported: name, local: name, typeOnly: false })),
      }),
      'python',
    );

  const files = {
    'app/__init__.py': '',
    'app/main.py': '',
    'app/util.py': '',
    'app/models/__init__.py': '',
    'app/models/user.py': '',
    'src/lib/__init__.py': '',
    'src/lib/core.py': '',
  };

  test('absolute imports search the workspace root and src folders', async () => {
    expect((await resolvePy(files, 'app/main.py', 'app.util')).resolution).toEqual({
      kind: 'file',
      path: 'app/util.py',
      via: 'module',
    });
    expect((await resolvePy(files, 'app/main.py', 'lib.core')).resolution).toMatchObject({
      path: 'src/lib/core.py',
    });
    expect((await resolvePy(files, 'app/main.py', 'app.models')).resolution).toMatchObject({
      path: 'app/models/__init__.py',
    });
  });

  test('relative imports count their dots from the importing file', async () => {
    expect((await resolvePy(files, 'app/main.py', '.util')).resolution).toMatchObject({
      path: 'app/util.py',
      via: 'relative',
    });
    expect((await resolvePy(files, 'app/models/user.py', '..util')).resolution).toMatchObject({
      path: 'app/util.py',
    });
    expect((await resolvePy(files, 'app/main.py', '.models.user')).resolution).toMatchObject({
      path: 'app/models/user.py',
    });
    expect((await resolvePy(files, 'app/models/user.py', '.')).resolution).toMatchObject({
      path: 'app/models/__init__.py',
    });
  });

  test('a relative import that finds nothing is dangling', async () => {
    const result = await resolvePy(files, 'app/main.py', '.missing');
    expect(result.resolution).toMatchObject({ kind: 'dangling', reason: 'no such module' });
  });

  test('a module nobody here defines is external (standard library or installed)', async () => {
    expect((await resolvePy(files, 'app/main.py', 'os.path')).resolution).toEqual({
      kind: 'external',
      name: 'os',
    });
  });

  test('imported names that are submodules are reported as members', async () => {
    const result = await resolvePy(files, 'app/main.py', 'app.models', ['user', 'Missing']);
    expect(result.members).toEqual(new Map([['user', 'app/models/user.py']]));
    const dot = await resolvePy(files, 'app/main.py', '.', ['util', 'models']);
    expect(dot.members).toEqual(
      new Map([
        ['util', 'app/util.py'],
        ['models', 'app/models/__init__.py'],
      ]),
    );
  });

  test('a namespace package (a folder with no __init__) still yields its submodules', async () => {
    const result = await resolvePy({ 'ns/tool.py': '' }, 'main.py', 'ns', ['tool']);
    expect(result.resolution).toMatchObject({ kind: 'file', path: 'ns/tool.py' });
    expect(result.members.get('tool')).toBe('ns/tool.py');
  });

  test('a package root adds its own source folder', async () => {
    const result = await resolvePy(
      { 'services/api/src/api/__init__.py': '', 'services/api/src/api/routes.py': '' },
      'services/worker/w.py',
      'api.routes',
      [],
      [python('api', 'services/api')],
    );
    expect(result.resolution).toMatchObject({ path: 'services/api/src/api/routes.py' });
  });
});

describe('Vue resolution', () => {
  test('resolves relative imports from .vue files to .ts and .vue files', async () => {
    const files = {
      'src/components/App.vue': '',
      'src/components/Button.vue': '',
      'src/components/utils.ts': '',
    };
    const resolver = new ImportResolver(environment(files), []);

    const toTs = await resolver.resolve('src/components/App.vue', fact('./utils'), 'vue');
    expect(toTs.resolution).toEqual({
      kind: 'file',
      path: 'src/components/utils.ts',
      via: 'relative',
    });

    const toVue = await resolver.resolve('src/components/App.vue', fact('./Button.vue'), 'vue');
    expect(toVue.resolution).toEqual({
      kind: 'file',
      path: 'src/components/Button.vue',
      via: 'relative',
    });

    const toVueExtensionless = await resolver.resolve(
      'src/components/App.vue',
      fact('./Button'),
      'vue',
    );
    expect(toVueExtensionless.resolution).toEqual({
      kind: 'file',
      path: 'src/components/Button.vue',
      via: 'relative',
    });
  });
});

describe('PHP resolution', () => {
  test('resolves PSR-4 namespace use declarations to app and src files', async () => {
    const files = {
      'app/Http/Controllers/OrderController.php': '',
      'app/Facades/PixartOrderFacade.php': '',
      'src/Services/OrderService.php': '',
    };
    const resolver = new ImportResolver(environment(files), []);

    const facade = await resolver.resolve(
      'app/Http/Controllers/OrderController.php',
      fact('App\\Facades\\PixartOrderFacade'),
      'php',
    );
    expect(facade.resolution).toEqual({
      kind: 'file',
      path: 'app/Facades/PixartOrderFacade.php',
      via: 'module',
    });

    const service = await resolver.resolve(
      'app/Http/Controllers/OrderController.php',
      fact('App\\Services\\OrderService'),
      'php',
    );
    expect(service.resolution).toEqual({
      kind: 'file',
      path: 'src/Services/OrderService.php',
      via: 'module',
    });

    const external = await resolver.resolve(
      'app/Http/Controllers/OrderController.php',
      fact('Illuminate\\Support\\Facades\\Log'),
      'php',
    );
    expect(external.resolution).toEqual({
      kind: 'external',
      name: 'Illuminate\\Support\\Facades\\Log',
    });
  });
});

describe('languages not understood', () => {
  test('say so instead of pretending to resolve', async () => {
    const result = await new ImportResolver(environment({}), []).resolve('a.go', fact('fmt'), 'go');
    expect(result.resolution).toMatchObject({ kind: 'dangling' });
  });
});
