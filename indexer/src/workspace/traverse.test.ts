import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Deadline, OperationAbortedError } from '@cntxt-labs/code-lens-core';
import { cleanupRepos, gitAvailable, materialise, scenarios } from '../test-support.ts';
import { DEFAULT_EXCLUDES, Traversal, type TraverseOptions } from './traverse.ts';

const temp: string[] = [];
afterAll(() => {
  cleanupRepos();
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'code-lens-traverse-'));
  temp.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function collect(options: TraverseOptions) {
  const traversal = new Traversal(options);
  const files: string[] = [];
  const directories: string[] = [];
  const repos = new Map<string, string>();
  for await (const visit of traversal) {
    directories.push(visit.path);
    for (const entry of visit.entries) {
      if (entry.kind === 'file') {
        files.push(entry.path);
        repos.set(entry.path, visit.repo);
      }
    }
  }
  return { files, directories, repos, report: traversal.report };
}

describe.skipIf(!gitAvailable)(
  'yields exactly the files git considers untracked and not ignored',
  () => {
    for (const scenario of scenarios) {
      test(scenario.name, async () => {
        const root = materialise(scenario);
        const git = Bun.spawnSync({
          cmd: ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
          cwd: root,
          stdout: 'pipe',
        });
        const expected = git.stdout
          .toString()
          .split('\0')
          .filter((p) => p.length > 0)
          .sort();
        // No built-in excludes: git has none, and the comparison is about ignore files alone.
        const { files } = await collect({ root, defaultExcludes: [] });
        expect([...files].sort()).toEqual(expected);
      });
    }
  },
);

describe('order and reporting', () => {
  test('directories and entries come in a fixed code-point order', async () => {
    const root = tree({ 'b/x.ts': '', 'a/y.ts': '', 'Z/z.ts': '', 'a.ts': '', '_u.ts': '' });
    const { files, directories } = await collect({ root });
    expect(directories).toEqual(['', 'Z', 'a', 'b']);
    expect(files).toEqual(['_u.ts', 'a.ts', 'Z/z.ts', 'a/y.ts', 'b/x.ts']);
  });

  test('counts what it visited and what ignore rules set aside', async () => {
    const root = tree({
      '.gitignore': '*.log\nbuild/\n',
      'a.log': '',
      'keep.ts': '',
      'build/out.js': '',
      'src/x.ts': '',
    });
    const { report } = await collect({ root });
    expect(report).toMatchObject({ directories: 2, ignoredDirectories: 1, ignoredFiles: 1 });
  });

  test('a cancelled deadline stops the walk with a typed error', async () => {
    const root = tree({ 'a/b.ts': '' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect({ root, deadline: Deadline.of({ signal: controller.signal }) }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
  });

  test('a directory that vanishes is reported, not fatal', async () => {
    const root = tree({ 'a/x.ts': '' });
    const { report } = await collect({ root: join(root, 'does-not-exist') });
    expect(report.unreadableDirectories).toHaveLength(1);
    expect(report.unreadableDirectories[0]?.error.code).toBe('INDEXER_DIRECTORY_READ');
    expect(report.unreadableDirectories[0]?.error.cause).toBeDefined();
  });
});

describe('what is excluded before any ignore file is read', () => {
  test('version-control metadata is never entered, whatever the rules say', async () => {
    const root = tree({ '.git/config': '', '.gitignore': '!.git\n', 'a.ts': '' });
    const { files } = await collect({ root });
    expect(files).toEqual(['.gitignore', 'a.ts']);
  });

  test('default excludes apply, and a project can lift one with a negation', async () => {
    const files = { 'node_modules/p/i.js': '', '__pycache__/x.pyc': '', 'src/a.ts': '' };
    const plain = await collect({ root: tree(files) });
    expect(plain.files).toEqual(['src/a.ts']);
    expect(DEFAULT_EXCLUDES).toContain('node_modules');
    const lifted = await collect({
      root: tree({ ...files, '.code-lensignore': '!node_modules\n' }),
    });
    expect(lifted.files).toContain('node_modules/p/i.js');
  });

  test('.code-lensignore outranks .gitignore in the same directory', async () => {
    const root = tree({
      '.gitignore': '*.gen.ts\n',
      '.code-lensignore': '!keep.gen.ts\n',
      'keep.gen.ts': '',
      'drop.gen.ts': '',
    });
    const { files } = await collect({ root });
    expect(files).toContain('keep.gen.ts');
    expect(files).not.toContain('drop.gen.ts');
  });

  test('configuration excludes outrank every ignore file', async () => {
    const root = tree({ '.code-lensignore': '!secret.ts\n', 'secret.ts': '', 'ok.ts': '' });
    const { files } = await collect({ root, configExclude: ['secret.ts'] });
    expect(files).toEqual(['.code-lensignore', 'ok.ts']);
  });

  test('.git/info/exclude is honoured like an ignore file at the lowest precedence', async () => {
    const root = tree({
      '.git/info/exclude': '*.private\n',
      '.gitignore': '!keep.private\n',
      'a.private': '',
      'keep.private': '',
    });
    const { files } = await collect({ root });
    expect(files).toContain('keep.private');
    expect(files).not.toContain('a.private');
  });

  test('an ignore file that is really a directory is not read as one', async () => {
    const root = tree({ '.gitignore/inner.txt': '*.ts\n', 'a.ts': '' });
    const { files, report } = await collect({ root });
    expect(files).toContain('a.ts');
    expect(report.unreadableIgnoreFiles).toEqual([]);
  });

  test('case-insensitive matching is opt-in', async () => {
    const root = tree({ '.gitignore': 'Build\n', 'build/a.ts': '', 'keep.ts': '' });
    expect((await collect({ root })).files).toContain('build/a.ts');
    expect((await collect({ root, caseInsensitive: true })).files).not.toContain('build/a.ts');
  });
});

describe('nested repositories', () => {
  const layout = {
    '.gitignore': '*.log\nvendor-note.txt\n',
    'a.log': '',
    'a.ts': '',
    'inner/.git/HEAD': 'ref: refs/heads/main\n',
    'inner/.gitignore': '*.tmp\n',
    'inner/x.log': '',
    'inner/y.tmp': '',
    'inner/z.ts': '',
    'inner/deep/w.ts': '',
  };

  test('are included by default, with their own ignore context and a repo label', async () => {
    const { files, repos, report } = await collect({ root: tree(layout) });
    // The parent's `*.log` does not reach into the nested repository; its own `*.tmp` does.
    expect(files).toContain('inner/x.log');
    expect(files).not.toContain('inner/y.tmp');
    expect(files).not.toContain('a.log');
    expect(repos.get('a.ts')).toBe('');
    expect(repos.get('inner/z.ts')).toBe('inner');
    expect(repos.get('inner/deep/w.ts')).toBe('inner');
    expect(report.nestedRepos).toEqual(['inner']);
  });

  test('can be skipped, and the skip is reported', async () => {
    const { files, report } = await collect({ root: tree(layout), nestedRepos: 'skip' });
    expect(files.filter((f) => f.startsWith('inner/'))).toEqual([]);
    expect(report.skippedNestedRepos).toEqual(['inner']);
  });

  test('a submodule-style ".git" file also marks a repository', async () => {
    const root = tree({
      'sub/.git': 'gitdir: ../.git/modules/sub\n',
      'sub/a.ts': '',
      '.gitignore': '*.ts\n!sub/\n',
    });
    const { report } = await collect({ root });
    expect(report.nestedRepos).toEqual(['sub']);
  });
});

describe('symbolic links', () => {
  function link(target: string, path: string): boolean {
    try {
      symlinkSync(target, path);
      return true;
    } catch {
      return false;
    }
  }

  test('are reported and not followed unless asked (files only)', async () => {
    const root = tree({ 'real.ts': 'x', 'dir/a.ts': '' });
    const madeFile = link(join(root, 'real.ts'), join(root, 'alias.ts'));
    const madeDir = link(join(root, 'dir'), join(root, 'dirlink'));
    if (!madeFile || !madeDir) return; // creating links needs privileges on some systems
    const off = await collect({ root });
    expect(off.files).not.toContain('alias.ts');
    expect(off.report.symlinks.sort()).toEqual(['alias.ts', 'dirlink']);
    const on = await collect({ root, followSymlinks: true });
    expect(on.files).toContain('alias.ts');
    expect(on.files.some((f) => f.startsWith('dirlink/'))).toBe(false);
  });
});
