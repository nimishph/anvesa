import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryPatternSource, parsePatternFile } from './loader.ts';
import { PatternResolver, projectPatterns } from './resolver.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvesa-patterns-'));
  roots.push(dir);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

const pattern = (name: string, description = `finds ${name}`) =>
  JSON.stringify({ name, description, target: { kind: 'function' } });

describe('pattern loader', () => {
  test('find reads only the named file, so a broken neighbour does not matter', async () => {
    const dir = folder({ 'good.json': pattern('good'), 'broken.json': '{ nope' });
    const source = new DirectoryPatternSource('project', dir, 'here/');
    const found = await source.find('good');
    expect(found?.spec.name).toBe('good');
    expect(found?.file).toBe('good.json');
    expect(await source.find('absent')).toBeUndefined();
  });

  test('a name that is not a file name is never looked up', async () => {
    const dir = folder({ 'good.json': pattern('good') });
    const source = new DirectoryPatternSource('project', join(dir, 'nested'), 'here/');
    expect(await source.find('../good')).toBeUndefined();
    expect(await source.find('Good')).toBeUndefined();
  });

  test('find throws with the reason when the named file is invalid', async () => {
    const dir = folder({ 'odd.json': pattern('even') });
    const source = new DirectoryPatternSource('project', dir, 'here/');
    await expect(source.find('odd')).rejects.toThrow('rename it to even.json');
  });

  test('all lists usable patterns and every rejected file with a typed code', async () => {
    const dir = folder({
      'a.json': pattern('a'),
      'b.json': pattern('b', ' '),
      'c.json': '[]',
      'notes.txt': 'ignored',
    });
    const { patterns, invalid } = await new DirectoryPatternSource('project', dir, 'here/').all();
    expect(patterns.map((p) => p.spec.name)).toEqual(['a']);
    expect(invalid.map((i) => [i.file, i.code])).toEqual([
      ['b.json', 'CORE_INVALID_ARGUMENT'],
      ['c.json', 'CORE_INVALID_ARGUMENT'],
    ]);
  });

  test('a missing folder is an empty tier', async () => {
    const source = new DirectoryPatternSource('project', join(tmpdir(), 'no-such-dir-xyz'), 'x/');
    expect(await source.all()).toEqual({ patterns: [], invalid: [] });
    expect(await source.find('a')).toBeUndefined();
  });

  test('parsePatternFile refuses a name with capitals even when the file matches', () => {
    expect(() => parsePatternFile(pattern('Loud'), 'Loud.json')).toThrow('lowercase');
  });
});

describe('pattern resolver', () => {
  test('the first tier that has a name wins, and inventory lists each name once', async () => {
    const first = folder({ 'shared.json': pattern('shared', 'from the first') });
    const second = folder({
      'shared.json': pattern('shared', 'from the second'),
      'only.json': pattern('only'),
    });
    const resolver = new PatternResolver([
      new DirectoryPatternSource('project', first, 'first/'),
      new DirectoryPatternSource('project', second, 'second/'),
    ]);
    expect((await resolver.find('shared')).spec.description).toBe('from the first');
    expect((await resolver.find('only')).spec.name).toBe('only');
    const { patterns } = await resolver.inventory();
    expect(patterns.map((p) => [p.name, p.description])).toEqual([
      ['only', 'finds only'],
      ['shared', 'from the first'],
    ]);
  });

  test('an unknown name lists the known ones, or says where to put the first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvesa-project-'));
    roots.push(root);
    await expect(projectPatterns(root).find('x')).rejects.toThrow(
      'a pattern in .anvesa/patterns/<name>.json',
    );
    mkdirSync(join(root, '.anvesa', 'patterns'), { recursive: true });
    writeFileSync(join(root, '.anvesa', 'patterns', 'known.json'), pattern('known'));
    await expect(projectPatterns(root).find('x')).rejects.toThrow('one of known');
  });
});
