import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { UnknownPackageError, WorkspaceConfigError, WorkspaceRootError } from '../errors.ts';
import { cleanupTrees, makeTree } from '../test-support.ts';
import { defaultConfig, validateWorkspaceConfig } from './config.ts';
import { Workspace } from './workspace.ts';

afterAll(cleanupTrees);

const summary = (ws: Workspace) =>
  ws.packages().map((pkg) => `${pkg.root === '' ? '.' : pkg.root}|${pkg.name}|${pkg.kind}`);

const pnpm = {
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n  - '!apps/legacy'\n",
  'package.json': '{"name":"mono","private":true}',
  'packages/a/package.json':
    '{"name":"@x/a","version":"1.0.0","dependencies":{"@x/b":"workspace:*","lodash":"^4"}}',
  'packages/a/src/a.ts': 'export const a = 1;',
  'packages/b/package.json': '{"name":"@x/b","devDependencies":{"vitest":"1"}}',
  'packages/b/src/b.ts': 'export const b = 1;',
  'apps/web/package.json': '{"name":"web","dependencies":{"@x/a":"workspace:*"}}',
  'apps/web/src/main.ts': 'import "@x/a";',
  'apps/legacy/package.json': '{"name":"legacy"}',
  'node_modules/foo/package.json': '{"name":"foo"}',
  'README.md': '# mono',
};

const open = (files: Record<string, string>, config = defaultConfig()) =>
  Workspace.open({ root: makeTree(files), config });

describe('npm, pnpm, yarn and friends', () => {
  test('a pnpm monorepo: members, exclusions, the root, and what node_modules hides', async () => {
    const ws = await open(pnpm);
    expect(summary(ws)).toEqual([
      '.|mono|npm',
      'apps/legacy|legacy|generic',
      'apps/web|web|npm',
      'packages/a|@x/a|npm',
      'packages/b|@x/b|npm',
    ]);
    expect(ws.packageByName('@x/a')[0]).toMatchObject({
      version: '1.0.0',
      manifest: 'packages/a/package.json',
    });
    expect(ws.diagnostics).toEqual([]);
  });

  test('package.json workspaces in array and object form both work', async () => {
    const member = (name: string) => ({ [`${name}/package.json`]: `{"name":"${name}"}` });
    const array = await open({
      'package.json': '{"name":"r","workspaces":["libs/*"]}',
      ...member('libs/x'),
      ...member('libs/y'),
    });
    const object = await open({
      'package.json': '{"name":"r","workspaces":{"packages":["libs/*"]}}',
      ...member('libs/x'),
    });
    expect(array.packages().map((p) => p.name)).toEqual(['r', 'libs/x', 'libs/y']);
    expect(object.packages().map((p) => p.name)).toEqual(['r', 'libs/x']);
  });

  test('lerna defaults to packages/*, and Nx project.json directories are packages', async () => {
    const lerna = await open({
      'lerna.json': '{"version":"1.0.0"}',
      'package.json': '{"name":"root"}',
      'packages/p/package.json': '{"name":"p"}',
    });
    expect(lerna.packages().map((p) => p.name)).toContain('p');
    const nx = await open({
      'nx.json': '{}',
      'package.json': '{"name":"root"}',
      'libs/util/project.json': '{"name":"util","implicitDependencies":["core"]}',
      'libs/core/project.json': '{"name":"core"}',
    });
    expect(nx.packageByName('util')[0]).toMatchObject({ kind: 'npm', dependsOn: ['core'] });
    expect(nx.packageByName('core')).toHaveLength(1);
  });
});

describe('other ecosystems', () => {
  test('Cargo: crates by their package name, renamed dependencies, virtual workspace root', async () => {
    const ws = await open({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/core/Cargo.toml':
        '[package]\nname = "acme-core"\nversion = "0.1.0"\n[dependencies]\nserde = "1"\n',
      'crates/cli/Cargo.toml':
        '[package]\nname = "acme-cli"\n[dependencies]\ncore = { path = "../core", package = "acme-core" }\n[dev-dependencies]\ntempfile = "3"\n',
      'crates/core/src/lib.rs': '',
    });
    // The virtual workspace root has no crate of its own; it is a generic package for the root files.
    expect(summary(ws).filter((line) => !line.endsWith('|generic'))).toEqual([
      'crates/cli|acme-cli|cargo',
      'crates/core|acme-core|cargo',
    ]);
    expect(ws.packageByName('acme-cli')[0]?.dependsOn).toEqual(['acme-core', 'tempfile']);
    expect(ws.dependenciesOf('acme-cli').map((p) => p.name)).toEqual(['acme-core']);
    expect(ws.packageOf('README.md')?.kind).toBe('generic');
  });

  test('Go: modules from go.work and from stray go.mod files, linked by requires', async () => {
    const ws = await open({
      'go.work': 'go 1.22\n\nuse (\n\t./svc/a\n\t./svc/b\n)\n',
      'svc/a/go.mod': 'module example.com/a\n\nrequire example.com/b v0.0.0\n',
      'svc/b/go.mod': 'module example.com/b\n',
      'tools/go.mod': 'module example.com/tools\n',
    });
    expect(summary(ws)).toEqual([
      'svc/a|example.com/a|go',
      'svc/b|example.com/b|go',
      'tools|example.com/tools|go',
    ]);
    expect(ws.dependenciesOf('example.com/a').map((p) => p.name)).toEqual(['example.com/b']);
  });

  test('Python: uv workspaces, PEP 621 and Poetry names, and a config-only pyproject that names nothing', async () => {
    const ws = await open({
      'pyproject.toml':
        '[project]\nname = "root"\nversion = "0.1"\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      'packages/x/pyproject.toml':
        '[project]\nname = "x"\ndependencies = ["y>=1", "requests"]\n[project.optional-dependencies]\ntest = ["pytest"]\n',
      'packages/y/pyproject.toml':
        '[tool.poetry]\nname = "y"\n[tool.poetry.dependencies]\npython = "^3.10"\nrequests = "*"\n',
      'tool-only/pyproject.toml': '[tool.ruff]\nline-length = 100\n',
    });
    expect(summary(ws)).toEqual([
      '.|root|python',
      'packages/x|x|python',
      'packages/y|y|python',
      'tool-only|tool-only|generic',
    ]);
    expect(ws.packageByName('x')[0]?.dependsOn).toEqual(['y', 'requests', 'pytest']);
    expect(ws.packageByName('y')[0]?.dependsOn).toEqual(['requests']);
    expect(ws.dependenciesOf('x').map((p) => p.name)).toEqual(['y']);
  });

  test('Maven: modules by artifactId, dependencies between siblings', async () => {
    const ws = await open({
      'pom.xml':
        '<project><artifactId>parent</artifactId><modules><module>core</module><module>web</module></modules></project>',
      'core/pom.xml':
        '<project><parent><artifactId>parent</artifactId></parent><artifactId>core</artifactId></project>',
      'web/pom.xml':
        '<project><parent><artifactId>parent</artifactId></parent><artifactId>web</artifactId><dependencies><dependency><artifactId>core</artifactId></dependency></dependencies></project>',
    });
    expect(summary(ws)).toEqual(['.|parent|maven', 'core|core|maven', 'web|web|maven']);
    expect(ws.dependenciesOf('web').map((p) => p.name)).toEqual(['core']);
  });

  test('Gradle: included projects named by path, with project() dependencies', async () => {
    const ws = await open({
      'settings.gradle.kts': 'rootProject.name = "app"\ninclude(":libs:core", ":libs:util")\n',
      'build.gradle.kts': 'plugins {}',
      'libs/core/build.gradle.kts': 'dependencies { implementation(project(":libs:util")) }',
      'libs/util/build.gradle.kts': '',
    });
    expect(summary(ws)).toEqual([
      '.|app|gradle',
      'libs/core|libs:core|gradle',
      'libs/util|libs:util|gradle',
    ]);
    expect(ws.dependenciesOf('libs:core').map((p) => p.name)).toEqual(['libs:util']);
  });

  test('Bazel: every directory with a BUILD file, named by its label, when the root is a Bazel workspace', async () => {
    const ws = await open({
      'MODULE.bazel': 'module(name = "acme")',
      'services/api/BUILD.bazel': 'go_binary(name = "api", deps = ["//libs/core:core", ":local"])',
      'libs/core/BUILD': 'go_library(name = "core")',
    });
    expect(summary(ws)).toEqual([
      'libs/core|//libs/core|bazel',
      'services/api|//services/api|bazel',
    ]);
    expect(ws.dependenciesOf('//services/api').map((p) => p.name)).toEqual(['//libs/core']);
    // Without a Bazel marker at the root, BUILD files are just files.
    const plain = await open({ 'libs/core/BUILD': '' });
    expect(plain.packages()).toEqual([]);
  });

  test('any other manifest still makes a package, named as the manifest says or by its directory', async () => {
    const ws = await open({
      'site/composer.json': '{"name":"acme/site"}',
      'ruby/Gemfile': "source 'https://rubygems.org'",
    });
    expect(summary(ws)).toEqual(['ruby|ruby|generic', 'site|acme/site|generic']);
  });

  test('a polyglot repo has one package per ecosystem directory', async () => {
    const ws = await open({
      'web/package.json': '{"name":"web"}',
      'engine/Cargo.toml': '[package]\nname = "engine"\n',
      'ml/pyproject.toml': '[project]\nname = "ml"\n',
    });
    expect(summary(ws)).toEqual(['engine|engine|cargo', 'ml|ml|python', 'web|web|npm']);
  });
});

describe('finding the package of a file', () => {
  test('the deepest package above a file owns it', async () => {
    const ws = await open({
      'package.json': '{"name":"root"}',
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/sub/package.json': '{"name":"sub"}',
      'packages/a/src/x.ts': '',
      'packages/a/sub/y.ts': '',
    });
    expect(ws.packageOf('packages/a/src/x.ts')?.name).toBe('a');
    expect(ws.packageOf('packages/a/sub/y.ts')?.name).toBe('sub');
    expect(ws.packageOf('top.ts')?.name).toBe('root');
    expect(ws.packageOf('packages/a/package.json')?.name).toBe('a');
  });

  test('two packages may share a name; both are found', async () => {
    const ws = await open({
      'a/package.json': '{"name":"dup"}',
      'b/package.json': '{"name":"dup"}',
    });
    expect(ws.packageByName('dup').map((p) => p.root)).toEqual(['a', 'b']);
  });
});

describe('dependencies between packages', () => {
  test('direct and transitive, both ways, ignoring names that are not workspace packages', async () => {
    const ws = await open(pnpm);
    expect(ws.dependenciesOf('web').map((p) => p.name)).toEqual(['@x/a']);
    expect(ws.dependenciesOf('web', { transitive: true }).map((p) => p.name)).toEqual([
      '@x/a',
      '@x/b',
    ]);
    expect(ws.dependentsOf('@x/b').map((p) => p.name)).toEqual(['@x/a']);
    expect(ws.dependentsOf('@x/b', { transitive: true }).map((p) => p.name)).toEqual([
      'web',
      '@x/a',
    ]);
    expect(ws.dependenciesOf('@x/b')).toEqual([]);
    expect(ws.dependenciesOf('no-such-package')).toEqual([]);
  });

  test('a dependency cycle terminates', async () => {
    const ws = await open({
      'a/package.json': '{"name":"a","dependencies":{"b":"1"}}',
      'b/package.json': '{"name":"b","dependencies":{"a":"1"}}',
    });
    expect(ws.dependenciesOf('a', { transitive: true }).map((p) => p.name)).toEqual(['b']);
  });
});

describe('scoping', () => {
  test('by package name or root, alone or with what it depends on or what depends on it', async () => {
    const ws = await open(pnpm);
    const only = ws.scope({ packages: ['@x/a'] });
    expect(only('packages/a/src/a.ts')).toBe(true);
    expect(only('packages/b/src/b.ts')).toBe(false);
    expect(ws.scope({ packages: ['packages/a'] })('packages/a/src/a.ts')).toBe(true);

    const withDeps = ws.scope({ packages: ['web'], withDependencies: true });
    expect(
      ['apps/web/src/main.ts', 'packages/a/src/a.ts', 'packages/b/src/b.ts'].map(withDeps),
    ).toEqual([true, true, true]);
    expect(withDeps('apps/legacy/x.ts')).toBe(false);

    const withDependents = ws.scope({ packages: ['@x/b'], withDependents: true });
    expect(
      ['packages/b/src/b.ts', 'packages/a/src/a.ts', 'apps/web/src/main.ts'].map(withDependents),
    ).toEqual([true, true, true]);
  });

  test('by directory prefix, and combined with packages as a union', async () => {
    const ws = await open(pnpm);
    const paths = ws.scope({ paths: ['packages/b'] });
    expect(paths('packages/b/src/b.ts')).toBe(true);
    expect(paths('packages/bb/x.ts')).toBe(false);
    const both = ws.scope({ paths: ['apps/legacy'], packages: ['@x/a'] });
    expect(both('apps/legacy/x.ts')).toBe(true);
    expect(both('packages/a/src/a.ts')).toBe(true);
    expect(both('packages/b/src/b.ts')).toBe(false);
  });

  test('a nested package is not part of its parent package scope', async () => {
    const ws = await open({
      'a/package.json': '{"name":"a"}',
      'a/inner/package.json': '{"name":"inner"}',
      'a/x.ts': '',
      'a/inner/y.ts': '',
    });
    const scope = ws.scope({ packages: ['a'] });
    expect(scope('a/x.ts')).toBe(true);
    expect(scope('a/inner/y.ts')).toBe(false);
  });

  test('no scope means everything; an unknown package is an error that lists the real ones', async () => {
    const ws = await open(pnpm);
    expect(ws.scope()('anything/at/all.ts')).toBe(true);
    try {
      ws.scope({ packages: ['nope'] });
      throw new WorkspaceRootError('x', 'expected a failure');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(UnknownPackageError);
      expect((thrown as UnknownPackageError).context.known).toContain('web');
    }
  });
});

describe('configuration', () => {
  test('a configured package wins over discovery at the same directory', async () => {
    const config = validateWorkspaceConfig({
      packages: [{ name: 'api', root: 'packages/a', dependsOn: ['@x/b'] }],
    });
    const ws = await open(pnpm, config);
    expect(ws.packageOf('packages/a/src/a.ts')).toMatchObject({
      name: 'api',
      kind: 'configured',
      dependsOn: ['@x/b'],
    });
  });

  test('discovery can be switched off, or narrowed to chosen adapters', async () => {
    const files = { ...pnpm, 'crates/c/Cargo.toml': '[package]\nname = "c"\n' };
    const off = await open(
      files,
      validateWorkspaceConfig({ discover: false, packages: [{ name: 'only', root: 'apps/web' }] }),
    );
    expect(summary(off)).toEqual(['apps/web|only|configured']);
    const cargoOnly = await open(files, validateWorkspaceConfig({ adapters: ['cargo'] }));
    expect(summary(cargoOnly)).toEqual(['crates/c|c|cargo']);
  });

  test('an unknown adapter name is a config error naming the adapters that exist', async () => {
    await expect(
      open(pnpm, validateWorkspaceConfig({ adapters: ['npm', 'cobol'] })),
    ).rejects.toThrow(/unknown adapter "cobol"/);
  });

  test('config exclude removes directories from the survey, so their packages disappear', async () => {
    const ws = await open(pnpm, validateWorkspaceConfig({ exclude: ['apps/web'] }));
    expect(ws.packageByName('web')).toEqual([]);
  });

  test('.code-lens/workspace.json is read from the workspace', async () => {
    const root = makeTree({
      ...pnpm,
      '.code-lens/workspace.json': JSON.stringify({
        version: 1,
        packages: [{ name: 'special', root: 'apps/web' }],
      }),
    });
    const ws = await Workspace.open({ root });
    expect(ws.packageByName('special')[0]?.kind).toBe('configured');
  });

  test('a configured package whose directory does not exist is reported, not silently kept', async () => {
    const ws = await open(
      pnpm,
      validateWorkspaceConfig({ packages: [{ name: 'ghost', root: 'nowhere/here' }] }),
    );
    expect(
      ws.diagnostics.some((d) => d.adapter === 'configured' && d.path === 'nowhere/here'),
    ).toBe(true);
  });

  test.each([
    [null, '(root)'],
    [{ surprise: 1 }, 'surprise'],
    [{ version: 2 }, 'version'],
    [{ packages: 'x' }, 'packages'],
    [{ packages: [{ root: 'a' }] }, 'packages[0].name'],
    [{ packages: [{ name: 'a', root: '../out' }] }, 'packages[0].root'],
    [{ packages: [{ name: 'a', root: 1 }] }, 'packages[0].root'],
    [{ packages: [{ name: 'a', root: 'a', dependsOn: [1] }] }, 'packages[0].dependsOn[0]'],
    [{ nestedRepos: 'maybe' }, 'nestedRepos'],
    [{ discover: 'yes' }, 'discover'],
    [{ exclude: [''] }, 'exclude[0]'],
  ])('a bad config names the field: %j', (raw, location) => {
    try {
      validateWorkspaceConfig(raw);
      throw new WorkspaceRootError('x', 'expected a failure');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(WorkspaceConfigError);
      expect((thrown as WorkspaceConfigError).context.location).toBe(location);
    }
  });

  test('a workspace.json that is not JSON is a typed error with the cause kept', async () => {
    const root = makeTree({ '.code-lens/workspace.json': '{nope' });
    const failure = await Workspace.open({ root }).catch((e) => e);
    expect(failure).toBeInstanceOf(WorkspaceConfigError);
    expect(failure.cause).toBeDefined();
  });
});

describe('problems are reported, not fatal', () => {
  test('a broken manifest becomes a diagnostic and the rest of the workspace is still found', async () => {
    const ws = await open({
      ...pnpm,
      'packages/c/package.json': '{broken',
      'packages/d/Cargo.toml': 'name = ',
    });
    expect(ws.packageByName('@x/a')).toHaveLength(1);
    const broken = ws.diagnostics.filter((d) => d.path === 'packages/c/package.json');
    expect(broken.length).toBeGreaterThan(0);
    expect(broken[0]?.error.code).toBe('INDEXER_MANIFEST_INVALID');
    expect(
      ws.diagnostics.some((d) => d.adapter === 'cargo' && d.path === 'packages/d/Cargo.toml'),
    ).toBe(true);
  });

  test('a root that does not exist, or is a file, is a typed error', async () => {
    const dir = makeTree({ 'file.txt': 'x' });
    await expect(Workspace.open({ root: join(dir, 'missing') })).rejects.toBeInstanceOf(
      WorkspaceRootError,
    );
    await expect(Workspace.open({ root: join(dir, 'file.txt') })).rejects.toBeInstanceOf(
      WorkspaceRootError,
    );
  });

  test('nested repositories are noted in the survey', async () => {
    const ws = await open({
      'a/package.json': '{"name":"a"}',
      'inner/.git/HEAD': 'ref: x\n',
      'inner/package.json': '{"name":"inner"}',
    });
    expect(ws.survey.nestedRepos).toEqual(['inner']);
    expect(ws.packageByName('inner')).toHaveLength(1);
  });
});
