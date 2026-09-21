import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Deadline, OperationAbortedError } from '@sutras/code-lens-core';
import { SourceReadError } from '../errors.ts';
import { cleanupTrees, makeTree } from '../test-support.ts';
import { defaultConfig, validateWorkspaceConfig } from './config.ts';
import { BINARY_SNIFF_BYTES, readSource } from './content.ts';
import { walkSources } from './walk.ts';
import { Workspace } from './workspace.ts';

afterAll(cleanupTrees);

async function walk(files: Record<string, string>, config = defaultConfig()) {
  const root = makeTree(files);
  const workspace = await Workspace.open({ root, config });
  return { root, workspace };
}

async function collect(workspace: Workspace, options: Parameters<typeof walkSources>[1] = {}) {
  const run = walkSources(workspace, options);
  const entries = [];
  for await (const entry of run) entries.push(entry);
  return { entries, summary: run.summary };
}

const monorepo = {
  'package.json': '{"name":"root"}',
  'packages/a/package.json': '{"name":"a"}',
  'packages/a/src/index.ts': 'export const a = 1;\n',
  'packages/a/src/util.py': 'x = 1\n',
  'packages/b/package.json': '{"name":"b"}',
  'packages/b/lib.js': 'module.exports = 1;\n',
  'top.ts': 'export {};\n',
  'notes.txt': 'not code',
  Makefile: 'all:',
  'image.png': 'binary-ish',
};

describe('walking source files', () => {
  test('yields supported files in a fixed order, each with its language and package', async () => {
    const { workspace } = await walk(monorepo);
    const { entries } = await collect(workspace);
    expect(entries.map((e) => [e.path, e.language, e.package?.name])).toEqual([
      ['top.ts', 'typescript', 'root'],
      ['packages/a/src/index.ts', 'typescript', 'a'],
      ['packages/a/src/util.py', 'python', 'a'],
      ['packages/b/lib.js', 'javascript', 'b'],
    ]);
  });

  test('every file is accounted for: yielded, unsupported, out of scope or ignored', async () => {
    const { workspace } = await walk({ ...monorepo, '.gitignore': '*.log\n', 'debug.log': 'x' });
    const { summary } = await collect(workspace);
    expect(summary.files).toBe(4);
    expect(summary.byLanguage.get('typescript')).toBe(2);
    expect(summary.byPackage.get('packages/a')).toBe(2);
    expect(summary.byPackage.get('')).toBe(1);
    expect(Object.fromEntries(summary.unsupported)).toEqual({
      '.txt': 1,
      // `Makefile` and `.gitignore` both have no extension.
      '': 2,
      '.png': 1,
      '.json': 3,
    });
    expect(summary.traversal.ignoredFiles).toBe(1);
    expect(summary.outOfScope).toBe(0);
  });

  test('a scope limits what is yielded and counts what it set aside', async () => {
    const { workspace } = await walk(monorepo);
    const { entries, summary } = await collect(workspace, {
      scope: workspace.scope({ packages: ['a'] }),
    });
    expect(entries.map((e) => e.path)).toEqual([
      'packages/a/src/index.ts',
      'packages/a/src/util.py',
    ]);
    expect(summary.outOfScope).toBe(2);
  });

  test('size and modification time come from one stat, and change when the file does', async () => {
    const { root, workspace } = await walk({ 'a.ts': 'export const a = 1;\n' });
    const [before] = (await collect(workspace)).entries;
    expect(before?.size).toBe('export const a = 1;\n'.length);
    expect(Number.isFinite(before?.mtimeMs)).toBe(true);
    await Bun.sleep(20);
    writeFileSync(join(root, 'a.ts'), 'export const a = 12345;\n');
    const [after] = (await collect(workspace)).entries;
    expect(after?.size).toBe('export const a = 12345;\n'.length);
    expect(after?.mtimeMs).toBeGreaterThan(before?.mtimeMs as number);
  });

  test('a file that disappears between listing and stat is reported, and the walk goes on', async () => {
    const { root, workspace } = await walk({ 'a.ts': '', 'b.ts': '', 'c.ts': '' });
    const { entries, summary } = await collect(workspace, {
      scope: (path) => {
        if (path === 'b.ts') rmSync(join(root, 'b.ts'));
        return true;
      },
    });
    expect(entries.map((e) => e.path)).toEqual(['a.ts', 'c.ts']);
    expect(summary.unreadable.map((u) => u.path)).toEqual(['b.ts']);
    expect(summary.unreadable[0]?.error).toBeInstanceOf(SourceReadError);
    expect(summary.unreadable[0]?.error.cause).toBeDefined();
  });

  test('nested repositories label their files, so results can say which repo they came from', async () => {
    const { workspace } = await walk({
      'a.ts': '',
      'inner/.git/HEAD': 'ref: x\n',
      'inner/b.ts': '',
    });
    const { entries } = await collect(workspace);
    expect(entries.map((e) => [e.path, e.repo])).toEqual([
      ['a.ts', ''],
      ['inner/b.ts', 'inner'],
    ]);
  });

  test('a custom config can skip nested repositories entirely', async () => {
    const { workspace } = await walk(
      { 'a.ts': '', 'inner/.git/HEAD': 'ref: x\n', 'inner/b.ts': '' },
      validateWorkspaceConfig({ nestedRepos: 'skip' }),
    );
    const { entries, summary } = await collect(workspace);
    expect(entries.map((e) => e.path)).toEqual(['a.ts']);
    expect(summary.traversal.skippedNestedRepos).toEqual(['inner']);
  });

  test('a cancelled deadline stops the walk with a typed error', async () => {
    const { workspace } = await walk({ 'a.ts': '' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(workspace, { deadline: Deadline.of({ signal: controller.signal }) }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
  });
});

describe('reading source content', () => {
  const read = (files: Record<string, string | Uint8Array>, path: string) => {
    const root = makeTree({});
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
    return readSource(root, path);
  };

  test('text comes back decoded, with a hash of the exact bytes', async () => {
    const content = 'export const é = "日本語";\n';
    const result = await read({ 'a.ts': content }, 'a.ts');
    expect(result).toMatchObject({ kind: 'text', content, lossy: false, encoding: 'utf-8' });
    expect(result.kind === 'text' && result.hash).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
  });

  test('a NUL byte in the first bytes makes a file binary, as it does for git', async () => {
    const bytes = new Uint8Array([0x61, 0x00, 0x62]);
    expect(await read({ 'a.bin': bytes }, 'a.bin')).toEqual({ kind: 'binary', bytes: 3 });
  });

  test('a NUL after the sniffed region does not make a file binary', async () => {
    const bytes = new Uint8Array(BINARY_SNIFF_BYTES + 100).fill(0x61);
    bytes[BINARY_SNIFF_BYTES + 50] = 0;
    expect((await read({ 'long.ts': bytes }, 'long.ts')).kind).toBe('text');
  });

  test('UTF-16 with a byte-order mark is text, even though it is full of NUL bytes', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('const a = 1;', 'utf16le')]);
    const be = Buffer.from([0xfe, 0xff, ...Buffer.from('const b = 2;', 'utf16le').swap16()]);
    const one = await read({ 'le.ts': le }, 'le.ts');
    const two = await read({ 'be.ts': be }, 'be.ts');
    expect(one).toMatchObject({ kind: 'text', encoding: 'utf-16le', lossy: false });
    expect(one.kind === 'text' && one.content).toBe('const a = 1;');
    expect(two).toMatchObject({ kind: 'text', encoding: 'utf-16be' });
    expect(two.kind === 'text' && two.content).toBe('const b = 2;');
  });

  test('a UTF-8 byte-order mark is not part of the text', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 1;')]);
    const result = await read({ 'bom.ts': withBom }, 'bom.ts');
    expect(result.kind === 'text' && result.content).toBe('const a = 1;');
  });

  test('bytes that are not valid UTF-8 are decoded anyway, and flagged as lossy', async () => {
    const result = await read({ 'bad.ts': Buffer.from([0x61, 0xff, 0xfe, 0x62]) }, 'bad.ts');
    expect(result).toMatchObject({ kind: 'text', lossy: true });
    expect(result.kind === 'text' && result.content).toContain('�');
  });

  test('there is no size limit: a multi-megabyte file is read whole', async () => {
    const big = `${'export const x = 1;\n'.repeat(400_000)}`;
    const result = await read({ 'big.ts': big }, 'big.ts');
    expect(result.kind).toBe('text');
    expect(result.kind === 'text' && result.bytes).toBe(big.length);
  });

  test('a missing file is a typed error that keeps the cause', async () => {
    const failure = await read({}, 'nope.ts').catch((e) => e);
    expect(failure).toBeInstanceOf(SourceReadError);
    expect(failure.cause).toBeDefined();
    expect(failure.context.path).toBe('nope.ts');
  });

  test('a cancelled deadline stops before reading', async () => {
    const root = makeTree({ 'a.ts': 'x' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readSource(root, 'a.ts', { deadline: Deadline.of({ signal: controller.signal }) }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
  });
});
