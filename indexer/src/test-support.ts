import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StructuralEngine } from '@sutras/code-lens-structural';
import { npmPackageSource, SyntaxRuntime } from '@sutras/code-lens-syntax';
import { FactExtractor } from './extract/extract.ts';
import { DiskEnvironment, GraphLinker, GraphQueries, ImportResolver } from './graph/index.ts';
import { MemoryIndexStore } from './store/memory-index-store.ts';
import type { IndexStore } from './store/types.ts';
import { defaultConfig } from './workspace/config.ts';
import { readSource } from './workspace/content.ts';
import { walkSources } from './workspace/walk.ts';
import { Workspace } from './workspace/workspace.ts';

/** Test-only helpers. Not exported from the package. */

export const gitAvailable = Bun.spawnSync({ cmd: ['git', '--version'] }).exitCode === 0;

export interface Scenario {
  readonly name: string;
  /** Ignore file path (relative to the repo) -> its text. */
  readonly ignores: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly dirs?: readonly string[];
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'extensions, anchoring, dir-only and negation',
    ignores: { '.gitignore': '*.log\n!keep.log\nbuild/\n/rootonly\ntemp*\n' },
    files: [
      'a.log',
      'keep.log',
      'sub/x.log',
      'sub/keep.log',
      'build/out.js',
      'sub/build/out.js',
      'rootonly',
      'sub/rootonly',
      'temp1',
      'sub/temp2',
      'src/a.ts',
    ],
  },
  {
    name: 'double star in every position',
    ignores: { '.gitignore': '**/cache\nlogs/**\nfoo/**/bar\ndocs/**/*.tmp\n**/gen/**\n' },
    files: [
      'cache',
      'a/cache',
      'a/b/cache/x',
      'logs/a',
      'logs/b/c',
      'x/logs/a',
      'foo/bar',
      'foo/a/bar',
      'foo/a/b/bar',
      'foo/a/baz',
      'docs/a.tmp',
      'docs/x/y/a.tmp',
      'docs/a.md',
      'gen/a',
      'src/gen/a/b',
      'x/gen',
    ],
  },
  {
    name: 'character classes and wildcards',
    ignores: { '.gitignore': '[ab]*.txt\nfile[0-9].c\n[!x]y.md\nq[[:digit:]].t\n?.dat\na?c\n' },
    files: [
      'a1.txt',
      'b.txt',
      'c.txt',
      'file3.c',
      'fileA.c',
      'xy.md',
      'zy.md',
      'q5.t',
      'qz.t',
      'k.dat',
      'kk.dat',
      'abc',
      'a/c',
      'a/b/abc',
    ],
  },
  {
    name: 'escapes and comments',
    ignores: { '.gitignore': '# a comment\n\\#hash\n\\!bang\n  \n#another\nplain\n' },
    files: ['#hash', '!bang', 'plain', 'other', 'sub/#hash', 'sub/plain'],
  },
  {
    name: 'nested ignore files, negation and rooted patterns',
    ignores: {
      '.gitignore': '*.tmp\nnode_modules/\n',
      'sub/.gitignore': '!keep.tmp\n/local\n',
      'sub/deep/.gitignore': '*.gen\n!/sub-level.tmp\n',
    },
    files: [
      'a.tmp',
      'keep.tmp',
      'sub/a.tmp',
      'sub/keep.tmp',
      'sub/local',
      'sub/x/local',
      'sub/deep/a.gen',
      'sub/deep/b.tmp',
      'sub/deep/sub-level.tmp',
      'node_modules/pkg/index.js',
      'sub/node_modules/pkg/index.js',
      'other/keep.tmp',
    ],
  },
  {
    name: 'an excluded directory cannot be reopened',
    ignores: { '.gitignore': 'vendor/\n!vendor/keep.txt\n/dist/*\n!/dist/keep.js\n' },
    files: ['vendor/a.txt', 'vendor/keep.txt', 'dist/a.js', 'dist/keep.js', 'dist/sub/x.js'],
  },
  {
    name: 'directory-only patterns do not match files',
    ignores: { '.gitignore': 'cache/\nnode_modules/\n' },
    files: ['a/cache', 'b/cache/x', 'node_modules', 'sub/node_modules/y'],
  },
  {
    name: 'a slash in the middle anchors the pattern',
    ignores: { '.gitignore': 'src/gen\nlib\n/top\ndocs/*.md\n' },
    files: [
      'src/gen',
      'x/src/gen',
      'gen',
      'lib',
      'b/lib',
      'a/lib/z',
      'top',
      'a/top',
      'docs/a.md',
      'docs/x/a.md',
    ],
  },
  {
    name: 'the last matching rule wins',
    ignores: { '.gitignore': '*.a\n!b.a\nb.a\nc.b\n!c.b\n' },
    files: ['x.a', 'b.a', 'c.b', 'sub/b.a'],
  },
  {
    name: 'whitelist style: ignore everything, re-include some',
    ignores: { '.gitignore': '*\n!*/\n!*.ts\n!.gitignore\nsecret.ts\n' },
    files: ['a.ts', 'a.js', 'src/b.ts', 'src/b.js', 'src/deep/c.ts', 'secret.ts', 'src/secret.ts'],
  },
  {
    name: 'CRLF line endings and blank files',
    ignores: { '.gitignore': '*.log\r\n!keep.log\r\nbuild/\r\n', 'empty/.gitignore': '' },
    files: ['a.log', 'keep.log', 'build/x', 'empty/a.log'],
  },
  {
    name: 'lone double star and root wildcard',
    ignores: { '.gitignore': '/*\n!/src\n!/README.md\n', 'src/.gitignore': '**/*.snap\n' },
    files: ['README.md', 'LICENSE', 'src/a.ts', 'src/x/a.snap', 'src/a.snap', 'docs/a.md'],
  },
];

const roots: string[] = [];

/** Remove every repository made by `materialise`. Call from `afterAll`. */
export function cleanupRepos(): void {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function materialise(scenario: Scenario): string {
  const root = mkdtempSync(join(tmpdir(), 'code-lens-ignore-'));
  roots.push(root);
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
  Bun.spawnSync({ cmd: ['git', 'config', 'core.ignorecase', 'false'], cwd: root });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, text] of Object.entries(scenario.ignores)) put(path, text);
  for (const file of scenario.files) if (!(file in scenario.ignores)) put(file, 'x');
  for (const dir of scenario.dirs ?? []) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

/** Every file and directory of the scenario, as `path` + whether it is a directory. */
export function allPaths(scenario: Scenario): { path: string; isDirectory: boolean }[] {
  const entries = new Map<string, boolean>();
  const add = (path: string, isDirectory: boolean) => {
    if (!entries.has(path) || isDirectory) entries.set(path, isDirectory);
  };
  const files = [...scenario.files, ...Object.keys(scenario.ignores)];
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth += 1)
      add(parts.slice(0, depth).join('/'), true);
    add(file, false);
  }
  for (const dir of scenario.dirs ?? []) add(dir, true);
  return [...entries].map(([path, isDirectory]) => ({ path, isDirectory }));
}

const trees: string[] = [];

/** A temporary directory holding the given files. Remove them all with `cleanupTrees`. */
export function makeTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'code-lens-tree-'));
  trees.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

export function cleanupTrees(): void {
  for (const root of trees.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const runtimes: SyntaxRuntime[] = [];

/** A fact extractor backed by the grammars installed as dev dependencies of this package. */
export function makeExtractor(): FactExtractor {
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  runtimes.push(runtime);
  return new FactExtractor(new StructuralEngine({ runtime }));
}

export async function disposeExtractors(): Promise<void> {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
}

export interface Fixture {
  readonly root: string;
  readonly workspace: Workspace;
  readonly store: IndexStore;
  readonly resolver: ImportResolver;
  readonly linker: GraphLinker;
  readonly queries: GraphQueries;
}

/**
 * A real directory tree, indexed end to end with the real grammars: walk, read, extract, store,
 * ready to link. What the orchestrator will do, in its plainest form.
 */
export async function indexFixture(
  files: Readonly<Record<string, string>>,
  options: { readonly store?: IndexStore } = {},
): Promise<Fixture> {
  const root = makeTree(files);
  const workspace = await Workspace.open({ root, config: defaultConfig() });
  const store = options.store ?? new MemoryIndexStore();
  const extractor = makeExtractor();
  for await (const entry of walkSources(workspace)) {
    const content = await readSource(root, entry.path);
    if (content.kind !== 'text') continue;
    const facts = await extractor.extract(entry.path, content.content);
    await store.replaceFile({
      path: entry.path,
      language: entry.language,
      packageRoot: entry.package?.root,
      repo: entry.repo,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      contentHash: content.hash,
      facts,
    });
  }
  const resolver = new ImportResolver(new DiskEnvironment(root), workspace.packages());
  return {
    root,
    workspace,
    store,
    resolver,
    linker: new GraphLinker(store, resolver),
    queries: new GraphQueries(store, (path) => workspace.packageOf(path)),
  };
}
