import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FragmentManifestError } from '../errors.ts';
import { communities } from './louvain.ts';
import {
  FRAGMENTS_PATH,
  FragmentAssigner,
  type FragmentManifest,
  loadManifest,
  manifestText,
  saveManifest,
  validateManifest,
} from './manifest.ts';
import { proposeClustered, proposePathPrior, slug } from './propose.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const manifest = (over: Record<string, unknown> = {}): FragmentManifest =>
  validateManifest({
    manifestVersion: 1,
    algorithm: { id: 'test', version: 1 },
    fallback: 'root',
    fragments: {
      root: {},
      core: { roots: ['packages/core'] },
      'core-tests': { roots: ['packages/core/test'] },
      docs: { roots: ['docs'], files: ['README.md'] },
      misc: { files: ['scripts/release.sh'] },
    },
    overrides: { 'packages/core/src/special.ts': 'misc' },
    ...over,
  });

describe('which fragment a file is in', () => {
  const assigner = new FragmentAssigner(manifest());

  test('the deepest folder that contains the file wins; a file is never a folder', () => {
    expect(assigner.assign('packages/core/src/a.ts')).toBe('core');
    expect(assigner.assign('packages/core/test/a.test.ts')).toBe('core-tests');
    expect(assigner.assign('packages/core/test/deep/er/b.ts')).toBe('core-tests');
    expect(assigner.assign('packages/corevil/a.ts')).toBe('root');
    expect(assigner.assign('packages/core')).toBe('root');
    expect(assigner.assign('docs/guide/a.md')).toBe('docs');
  });

  test('a named file beats its folder, and an override beats everything', () => {
    expect(assigner.assign('README.md')).toBe('docs');
    expect(assigner.assign('scripts/release.sh')).toBe('misc');
    expect(assigner.assign('packages/core/src/special.ts')).toBe('misc');
    expect(assigner.assign('anything/else.ts')).toBe('root');
  });

  test('is a pure function of the manifest: the order it was written in changes nothing', () => {
    const shuffled = validateManifest(
      JSON.parse(
        JSON.stringify({
          overrides: { 'packages/core/src/special.ts': 'misc' },
          fragments: Object.fromEntries(Object.entries(manifest().fragments).reverse()),
          fallback: 'root',
          algorithm: { version: 1, id: 'test' },
          manifestVersion: 1,
        }),
      ),
    );
    const other = new FragmentAssigner(shuffled);
    for (const path of [
      'packages/core/src/a.ts',
      'packages/core/test/x.ts',
      'README.md',
      'docs/a.md',
      'nothing.ts',
      'packages/core/src/special.ts',
    ]) {
      expect(other.assign(path)).toBe(assigner.assign(path));
    }
    expect(manifestText(shuffled)).toBe(manifestText(manifest()));
    expect(assigner.ids()).toEqual(['core', 'core-tests', 'docs', 'misc', 'root']);
  });
});

describe('the manifest file', () => {
  const bad = (raw: unknown, pattern: RegExp) => {
    expect(() => validateManifest(raw, 'm.json')).toThrow(pattern);
    expect(() => validateManifest(raw, 'm.json')).toThrow(FragmentManifestError);
  };
  const base = {
    manifestVersion: 1,
    algorithm: { id: 'x', version: 1 },
    fallback: 'root',
    fragments: { root: {} },
  };

  test('says which field is wrong', () => {
    bad(null, /\(root\)/);
    bad({ ...base, manifestVersion: 2 }, /manifestVersion/);
    bad({ ...base, algorithm: { id: 1 } }, /algorithm/);
    bad({ ...base, fallback: 'nope' }, /fallback.*not one of the fragments/);
    bad({ ...base, fragments: { Root: {} } }, /fragments\.Root/);
    bad({ ...base, fragments: { root: { colour: 'red' } } }, /fragments\.root\.colour/);
    bad({ ...base, fragments: { root: { roots: ['../out'] } } }, /relative path/);
    bad({ ...base, fragments: { root: { roots: ['a/'] } } }, /not normalised/);
    bad({ ...base, fragments: { root: { files: [1] } } }, /array of strings/);
    bad({ ...base, overrides: { 'a.ts': 'ghost' } }, /overrides\.a\.ts/);
    bad(
      { ...base, fragments: { root: {}, a: { roots: ['x'] }, b: { roots: ['x'] } } },
      /already in fragment "a"/,
    );
  });

  test('is written in a fixed order, so an unchanged manifest is an unchanged file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-lens-frag-'));
    dirs.push(dir);
    expect(await loadManifest(dir)).toBeUndefined();
    const path = await saveManifest(dir, manifest());
    expect(path).toBe(join(dir, FRAGMENTS_PATH));
    const first = readFileSync(path, 'utf8');
    await saveManifest(dir, (await loadManifest(dir)) as FragmentManifest);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(first).fragments)).toEqual([
      'core',
      'core-tests',
      'docs',
      'misc',
      'root',
    ]);
  });

  test('a file that is not JSON, or does not fit, is an error that names it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-lens-frag-'));
    dirs.push(dir);
    await saveManifest(dir, manifest());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, FRAGMENTS_PATH), '{oops');
    await expect(loadManifest(dir)).rejects.toThrow(/not valid JSON/);
    writeFileSync(join(dir, FRAGMENTS_PATH), '{"manifestVersion": 3}');
    await expect(loadManifest(dir)).rejects.toBeInstanceOf(FragmentManifestError);
  });
});

describe('the free tier: fragments follow the layout', () => {
  const files = [
    'packages/core/src/a.ts',
    'packages/core/src/b.ts',
    'packages/dense/src/c.ts',
    'apps/web/src/d.ts',
    'apps/api/src/e.ts',
    'scripts/build.ts',
    'README.md',
    'tools/x/src/f.ts',
  ];
  const packageRoots = ['packages/core', 'packages/dense', 'apps/web', 'apps/api', 'tools/x', ''];

  test('one fragment per package, one per other top folder, the rest in root', () => {
    const proposal = proposePathPrior({ files, packageRoots });
    expect(Object.keys(proposal.fragments).sort()).toEqual([
      'api',
      'core',
      'dense',
      'root',
      'scripts',
      'web',
      'x',
    ]);
    expect(proposal.algorithm).toEqual({ id: 'path-prior', version: 1 });
    const assigner = new FragmentAssigner(proposal);
    expect(assigner.assign('packages/core/src/a.ts')).toBe('core');
    expect(assigner.assign('apps/web/src/d.ts')).toBe('web');
    expect(assigner.assign('scripts/build.ts')).toBe('scripts');
    expect(assigner.assign('README.md')).toBe('root');
  });

  test('is the same however the inputs are ordered, and names clashes by full path', () => {
    const shuffled = proposePathPrior({
      files: [...files].reverse(),
      packageRoots: [...packageRoots].reverse(),
    });
    expect(manifestText(shuffled)).toBe(manifestText(proposePathPrior({ files, packageRoots })));

    const clash = proposePathPrior({
      files: ['a/util/x.ts', 'b/util/y.ts'],
      packageRoots: ['a/util', 'b/util'],
    });
    expect(Object.keys(clash.fragments).sort()).toEqual(['a-util', 'b-util', 'root']);
  });

  test('a package none of whose files are indexed gets no fragment', () => {
    const proposal = proposePathPrior({
      files: ['packages/core/src/a.ts'],
      packageRoots: ['packages/core', 'examples/unused', 'packages/empty'],
    });
    expect(Object.keys(proposal.fragments).sort()).toEqual(['core', 'root']);
  });

  test('ids are plain and never clash, whatever the folder is called', () => {
    expect(slug('My Folder!')).toBe('my-folder');
    expect(slug('///')).toBe('fragment');
    const proposal = proposePathPrior({
      files: ['Root/a.ts', 'root/b.ts', 'ROOT/c.ts'],
      packageRoots: [],
    });
    expect(Object.keys(proposal.fragments).sort()).toEqual(['root', 'root-2', 'root-3', 'root-4']);
    expect(() => validateManifest(proposal)).not.toThrow();
  });
});

describe('communities of a graph', () => {
  const clique = (nodes: number[]) =>
    nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => ({ a, b, weight: 1 })));

  test('two cliques joined by one link are two communities, numbered by their lowest node', () => {
    const edges = [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), { a: 3, b: 4, weight: 1 }];
    expect([...communities(8, edges)]).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  test('a node with no links is its own community, and an empty graph has none joined', () => {
    expect([...communities(3, [])]).toEqual([0, 1, 2]);
    expect([...communities(5, [{ a: 0, b: 1, weight: 1 }])]).toEqual([0, 0, 1, 2, 3]);
  });

  test('gives the same answer however the edges are listed', () => {
    const edges = [
      ...clique([0, 1, 2]),
      ...clique([3, 4, 5]),
      ...clique([6, 7, 8]),
      { a: 2, b: 3, weight: 1 },
      { a: 5, b: 6, weight: 1 },
    ];
    const forward = [...communities(9, edges)];
    const backward = [...communities(9, [...edges].reverse())];
    expect(backward).toEqual(forward);
    expect(new Set(forward).size).toBe(3);
  });

  test('a higher resolution gives smaller communities', () => {
    // A ring of four cliques: coarse finds fewer groups than fine.
    const cliques = [0, 4, 8, 12].map((start) => clique([start, start + 1, start + 2, start + 3]));
    const ring = [
      { a: 3, b: 4, weight: 1 },
      { a: 7, b: 8, weight: 1 },
      { a: 11, b: 12, weight: 1 },
      { a: 15, b: 0, weight: 1 },
    ];
    const edges = [...cliques.flat(), ...ring];
    const coarse = new Set(communities(16, edges, 0.05)).size;
    const fine = new Set(communities(16, edges, 3)).size;
    expect(coarse).toBeLessThanOrEqual(fine);
    expect(fine).toBeGreaterThanOrEqual(4);
  });
});

describe('the second tier: fragments follow the imports', () => {
  const files = [
    'src/auth/login.ts',
    'src/auth/session.ts',
    'src/auth/token.ts',
    'src/billing/invoice.ts',
    'src/billing/tax.ts',
    'src/billing/plan.ts',
    'src/util/log.ts',
    'src/lonely.ts',
    'src/auth/README.md',
  ];
  const link = (a: string, b: string, times = 1): [string, string][] =>
    Array.from({ length: times }, () => [a, b] as [string, string]);
  const imports = [
    ...link('src/auth/login.ts', 'src/auth/session.ts', 2),
    ...link('src/auth/session.ts', 'src/auth/token.ts', 2),
    ...link('src/auth/login.ts', 'src/auth/token.ts'),
    ...link('src/billing/invoice.ts', 'src/billing/tax.ts', 2),
    ...link('src/billing/tax.ts', 'src/billing/plan.ts', 2),
    ...link('src/billing/invoice.ts', 'src/billing/plan.ts'),
    ...link('src/billing/invoice.ts', 'src/util/log.ts'),
    ...link('src/auth/login.ts', 'src/util/log.ts'),
  ];

  test('files that use each other end up together, named for the folder they mostly live in', () => {
    const proposal = proposeClustered({ files, packageRoots: [], imports });
    expect(proposal.algorithm).toEqual({ id: 'import-clusters', version: 1 });
    const assigner = new FragmentAssigner(proposal);
    const auth = assigner.assign('src/auth/login.ts');
    const billing = assigner.assign('src/billing/invoice.ts');
    expect(auth).toBe('src-auth');
    expect(billing).toBe('src-billing');
    expect(assigner.assign('src/auth/token.ts')).toBe(auth);
    expect(assigner.assign('src/billing/plan.ts')).toBe(billing);
    // A file with no imports goes where its folder's other files went; one with no such folder, to root.
    expect(assigner.assign('src/auth/README.md')).toBe(auth);
    expect(assigner.assign('src/lonely.ts')).toBe('root');
    expect(() => validateManifest(JSON.parse(manifestText(proposal)))).not.toThrow();
  });

  test('every file has exactly one fragment, and the result does not depend on input order', () => {
    const proposal = proposeClustered({ files, packageRoots: [], imports });
    const listed = Object.values(proposal.fragments).flatMap((spec) => spec.files ?? []);
    expect(new Set(listed).size).toBe(listed.length);
    const again = proposeClustered({
      files: [...files].reverse(),
      packageRoots: [],
      imports: [...imports].reverse(),
    });
    expect(manifestText(again)).toBe(manifestText(proposal));
  });

  test('links to files that are not indexed are ignored, and labels are only words', () => {
    const proposal = proposeClustered({
      files,
      packageRoots: [],
      imports: [...imports, ['src/auth/login.ts', 'node_modules/x/index.js']],
      labels: { 'src-auth': 'Authentication' },
    });
    expect(proposal.fragments['src-auth']?.label).toBe('Authentication');
    expect(new FragmentAssigner(proposal).assign('src/auth/login.ts')).toBe('src-auth');
  });
});
