import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GrammarLockError } from './errors.ts';
import { GrammarLock, LOCAL_VERSION } from './lockfile.ts';
import { makeTempDir, type TempDir } from './test-support.ts';

let dir: TempDir;
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await dir.cleanup();
});

const sha = 'a'.repeat(64);
const entry = (id: string) => ({
  id,
  npmPackage: `tree-sitter-${id}`,
  version: '1.2.3',
  file: `tree-sitter-${id}.wasm`,
  sha256: sha,
});

async function loadFailure(path: string): Promise<GrammarLockError | undefined> {
  try {
    await GrammarLock.load(path);
    return undefined;
  } catch (thrown) {
    return thrown as GrammarLockError;
  }
}

describe('GrammarLock', () => {
  test('a missing file is an empty lock, not an error', async () => {
    const lock = await GrammarLock.load(join(dir.path, 'absent.json'));
    expect(lock.entries()).toEqual([]);
  });

  test('round-trips and writes keys in sorted order for clean diffs', async () => {
    const path = join(dir.path, 'roundtrip.json');
    const lock = GrammarLock.empty(path);
    lock.set(entry('zig'));
    lock.set(entry('c'));
    await lock.save();
    const text = await readFile(path, 'utf8');
    expect(text.indexOf('"c"')).toBeLessThan(text.indexOf('"zig"'));
    const again = await GrammarLock.load(path);
    expect(again.get('zig')).toEqual(entry('zig'));
    expect(again.entries().map((e) => e.id)).toEqual(['c', 'zig']);
  });

  test('saving leaves no temp files behind', async () => {
    const sub = join(dir.path, 'clean');
    const lock = GrammarLock.empty(join(sub, 'lock.json'));
    lock.set(entry('go'));
    await lock.save();
    await lock.save();
    expect(await readdir(sub)).toEqual(['lock.json']);
  });

  test('invalid JSON is reported with the parse failure as the cause', async () => {
    const path = join(dir.path, 'broken.json');
    await writeFile(path, '{not json');
    const failure = await loadFailure(path);
    expect(failure).toBeInstanceOf(GrammarLockError);
    expect(failure?.cause).toBeDefined();
  });

  test('rejects a lockfile version it does not understand', async () => {
    const path = join(dir.path, 'future.json');
    await writeFile(path, JSON.stringify({ lockfileVersion: 99, grammars: {} }));
    expect((await loadFailure(path))?.context.problem).toContain('99');
  });

  test('rejects an entry with a malformed checksum and names the entry', async () => {
    const path = join(dir.path, 'badsha.json');
    await writeFile(
      path,
      JSON.stringify({
        lockfileVersion: 1,
        grammars: { go: { npmPackage: 'p', version: '1', file: 'f', sha256: 'zz' } },
      }),
    );
    expect((await loadFailure(path))?.context.problem).toContain('"go"');
  });

  test('rejects an entry missing a field and says which', async () => {
    const path = join(dir.path, 'missing.json');
    await writeFile(
      path,
      JSON.stringify({
        lockfileVersion: 1,
        grammars: { go: { npmPackage: 'p', file: 'f', sha256: sha } },
      }),
    );
    expect((await loadFailure(path))?.context.problem).toContain('"version"');
  });

  test('a directory where the file should be is an unreadable lockfile, not an empty one', async () => {
    const failure = await loadFailure(dir.path);
    expect(failure).toBeInstanceOf(GrammarLockError);
    expect(failure?.cause).toBeDefined();
  });

  test('exposes the sentinel used for local installs', () => {
    expect(LOCAL_VERSION).toBe('local');
  });
});
