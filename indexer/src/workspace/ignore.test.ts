import { afterAll, describe, expect, test } from 'bun:test';
import {
  allPaths,
  cleanupRepos,
  gitAvailable,
  materialise,
  type Scenario,
  scenarios,
} from '../test-support.ts';
import { decideLayer, IgnoreStack, parseIgnore } from './ignore.ts';

afterAll(cleanupRepos);

function gitIgnored(root: string, paths: readonly string[]): Set<string> {
  const run = Bun.spawnSync({
    cmd: ['git', 'check-ignore', '--no-index', '-z', '--stdin'],
    cwd: root,
    stdin: Buffer.from(paths.join('\0')),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Exit 1 means "none of these are ignored"; anything above that is a real failure.
  expect(run.exitCode).toBeLessThanOrEqual(1);
  return new Set(
    run.stdout
      .toString()
      .split('\0')
      .filter((p) => p.length > 0),
  );
}

function stackFor(scenario: Scenario): IgnoreStack {
  const layers = Object.entries(scenario.ignores)
    .map(([path, text]) => ({
      path,
      base: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      text,
    }))
    .sort((a, b) => a.base.split('/').length - b.base.split('/').length);
  return new IgnoreStack(
    layers.map((layer) => ({
      base: layer.base,
      rules: parseIgnore(layer.text),
      origin: layer.path,
    })),
  );
}

describe.skipIf(!gitAvailable)('agrees with git on what is ignored', () => {
  for (const scenario of scenarios) {
    test(scenario.name, () => {
      const root = materialise(scenario);
      const paths = allPaths(scenario);
      const expected = gitIgnored(
        root,
        paths.map((p) => p.path),
      );
      const stack = stackFor(scenario);
      const mine = new Set(
        paths.filter((p) => stack.isIgnoredWithParents(p.path, p.isDirectory)).map((p) => p.path),
      );
      const disagreements = paths
        .filter((p) => expected.has(p.path) !== mine.has(p.path))
        .map(
          (p) =>
            `${p.path}${p.isDirectory ? '/' : ''}: git=${expected.has(p.path)} mine=${mine.has(p.path)}`,
        );
      expect(disagreements).toEqual([]);
    });
  }
});

describe('parsing', () => {
  test('skips blanks and comments, and reads negation, directory-only and anchoring', () => {
    const rules = parseIgnore('# c\n\n*.log\n!keep.log\nbuild/\n/root\nsrc/gen\n');
    expect(rules.map((r) => [r.source, r.negated, r.dirOnly, r.anchored])).toEqual([
      ['*.log', false, false, false],
      ['!keep.log', true, false, false],
      ['build/', false, true, false],
      ['/root', false, false, true],
      ['src/gen', false, false, true],
    ]);
  });

  test('an escaped trailing space is part of the name; an unescaped one is not', () => {
    const [plain, escaped] = parseIgnore('name   \nname\\ \n');
    expect(plain?.regex.test('name')).toBe(true);
    expect(escaped?.regex.test('name ')).toBe(true);
    expect(escaped?.regex.test('name')).toBe(false);
  });

  test('an unclosed bracket is a literal "["', () => {
    const [rule] = parseIgnore('a[b\n');
    expect(rule?.regex.test('a[b')).toBe(true);
  });

  test('a bracket does not match a slash, and a star does not cross one', () => {
    const [bracket, star] = parseIgnore('a[!x]b\na*b\n');
    expect(bracket?.regex.test('a/b')).toBe(false);
    expect(star?.regex.test('a/b')).toBe(false);
    expect(star?.regex.test('axxb')).toBe(true);
  });

  test('case-insensitive matching is opt-in', () => {
    expect(parseIgnore('README\n')[0]?.regex.test('readme')).toBe(false);
    expect(parseIgnore('README\n', { caseInsensitive: true })[0]?.regex.test('readme')).toBe(true);
  });

  test('a rule with regex metacharacters in its text matches them literally', () => {
    const [rule] = parseIgnore('a+b(c).d\n');
    expect(rule?.regex.test('a+b(c).d')).toBe(true);
    expect(rule?.regex.test('aab(c)xd')).toBe(false);
  });
});

describe('evaluation', () => {
  test('a layer only speaks for paths under its base', () => {
    const layer = { base: 'sub', rules: parseIgnore('*.tmp\n'), origin: 'sub/.gitignore' };
    expect(decideLayer(layer, 'sub/a.tmp', false)).toBe('ignore');
    expect(decideLayer(layer, 'other/a.tmp', false)).toBeUndefined();
    expect(decideLayer(layer, 'sub', true)).toBeUndefined();
  });

  test('a nearer layer beats a farther one, and a layer with no opinion defers', () => {
    const stack = new IgnoreStack([
      { base: '', rules: parseIgnore('*.tmp\n'), origin: 'root' },
      { base: 'sub', rules: parseIgnore('!keep.tmp\n'), origin: 'sub' },
    ]);
    expect(stack.isIgnored('sub/keep.tmp', false)).toBe(false);
    expect(stack.isIgnored('sub/other.tmp', false)).toBe(true);
    expect(stack.decide('sub/readme', false)).toBeUndefined();
  });

  test('`with` returns a new stack and leaves the old one alone; an empty layer changes nothing', () => {
    const base = new IgnoreStack([{ base: '', rules: parseIgnore('*.a\n'), origin: 'root' }]);
    const extended = base.with({ base: 'x', rules: parseIgnore('*.b\n'), origin: 'x' });
    expect(base.layers).toHaveLength(1);
    expect(extended.layers).toHaveLength(2);
    expect(base.with({ base: 'y', rules: [], origin: 'y' })).toBe(base);
  });

  test('isIgnoredWithParents lets an ignored directory take its contents with it', () => {
    const stack = new IgnoreStack([
      { base: '', rules: parseIgnore('vendor/\n!vendor/keep.txt\n'), origin: 'root' },
    ]);
    expect(stack.isIgnored('vendor/keep.txt', false)).toBe(false);
    expect(stack.isIgnoredWithParents('vendor/keep.txt', false)).toBe(true);
  });
});
