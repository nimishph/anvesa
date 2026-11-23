import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryPatternSource, parsePatternFile } from './loader.ts';
import { PatternResolver, projectPatterns, standardPatterns } from './resolver.ts';

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

  test('a name that differs from its file offers only the fixes that give a valid name', () => {
    const reason = (text: string, file: string) => {
      try {
        parsePatternFile(text, file);
        return 'accepted';
      } catch (failure) {
        return (failure as { message: string }).message;
      }
    };
    expect(reason(pattern('even'), 'odd.json')).toContain(
      'rename it to even.json, or set "name" to "odd"',
    );
    const upperFile = reason(pattern('wrong-case'), 'Wrong-Case.json');
    expect(upperFile).toContain('rename it to wrong-case.json)');
    expect(upperFile).not.toContain('set "name"');
    const upperName = reason(pattern('Wrong-Case'), 'wrong-case.json');
    expect(upperName).toContain('set "name" to "wrong-case")');
    expect(upperName).not.toContain('rename it');
    // Neither name is valid: the name rule is the reason.
    expect(reason(pattern('Bad'), 'Worse.json')).toContain('lowercase letters, digits');
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
  const tiered = () => {
    const project = folder({
      'shared.json': pattern('shared', 'from the project'),
      'broken.json': '{',
    });
    const user = folder({
      'shared.json': pattern('shared', 'from the user'),
      'only.json': pattern('only'),
      'broken.json': '{',
    });
    return new PatternResolver([
      new DirectoryPatternSource('project', project, 'project/'),
      new DirectoryPatternSource('user', user, 'user/'),
    ]);
  };

  test('the project tier shadows the user tier, and inventory says so', async () => {
    const resolver = tiered();
    expect((await resolver.find('shared')).spec.description).toBe('from the project');
    expect((await resolver.find('only')).tier).toBe('user');
    const { patterns, invalid } = await resolver.inventory();
    expect(patterns.map((p) => [p.name, p.tier, p.description, p.shadows])).toEqual([
      ['only', 'user', 'finds only', undefined],
      ['shared', 'project', 'from the project', ['user']],
    ]);
    expect(invalid.map((i) => [i.tier, i.file])).toEqual([
      ['project', 'broken.json'],
      ['user', 'broken.json'],
    ]);
  });

  test('tier:name asks only that tier', async () => {
    const resolver = tiered();
    expect((await resolver.find('user:shared')).spec.description).toBe('from the user');
    expect((await resolver.find('project:shared')).spec.description).toBe('from the project');
    await expect(resolver.find('project:only')).rejects.toThrow('one of project:shared');
    await expect(resolver.find('team:shared')).rejects.toThrow('one of project, user');
  });

  test('standardPatterns reads the project, then <home>/patterns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvesa-project-'));
    const home = mkdtempSync(join(tmpdir(), 'anvesa-home-'));
    roots.push(root, home);
    mkdirSync(join(home, 'patterns'));
    writeFileSync(join(home, 'patterns', 'mine.json'), pattern('mine'));
    const found = await standardPatterns(root, home).find('mine');
    expect(found.tier).toBe('user');
    await expect(standardPatterns(root, home).find('absent')).rejects.toThrow('one of mine');
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
