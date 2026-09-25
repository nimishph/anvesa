import { describe, expect, test } from 'bun:test';
import { blocksRelease, compare, renderComparison } from './compare.ts';
import { complexityOf, structureOf } from './footprint.ts';
import { byFactor, parseManifest, StressError, select } from './manifest.ts';
import { percentile, type RepoResult, type RunRecord, sample, wordsOf } from './measure.ts';

const factors = (over: Record<string, unknown> = {}) => ({
  language: 'typescript',
  stack: ['web-framework'],
  structure: 'single',
  complexity: 'small',
  era: 'modern',
  ...over,
});

const manifest = parseManifest(
  {
    version: 1,
    repos: {
      'a/one': factors({ language: 'python', era: 'legacy', stack: ['cli'] }),
      'b/two': factors({ structure: 'monorepo', complexity: 'large', languages: ['rust'] }),
      'c/three': factors({ language: 'go', era: 'ai-era' }),
    },
  },
  'test',
);

describe('the manifest', () => {
  test('is a flat map that can be viewed by any factor', () => {
    expect([...byFactor(manifest, 'language')]).toEqual([
      ['go', ['c/three']],
      ['python', ['a/one']],
      ['typescript', ['b/two']],
    ]);
    expect(byFactor(manifest, 'era').get('legacy')).toEqual(['a/one']);
  });

  test('selects by any combination of factors, several values meaning any of', () => {
    expect(select(manifest, { language: ['rust'] }).map((e) => e.id)).toEqual(['b/two']);
    expect(select(manifest, { era: ['legacy', 'ai-era'] }).map((e) => e.id)).toEqual([
      'a/one',
      'c/three',
    ]);
    expect(select(manifest, { structure: ['monorepo'], complexity: ['large'] })).toHaveLength(1);
    expect(select(manifest, { stack: ['cli'] }).map((e) => e.id)).toEqual(['a/one']);
    expect(select(manifest, { limit: 2 })).toHaveLength(2);
    expect(select(manifest, { ids: ['nope/none'] })).toEqual([]);
  });

  test('refuses what it cannot trust, naming the repository and the field', () => {
    const bad = (repos: Record<string, unknown>) => () =>
      parseManifest({ version: 1, repos }, 'file.json');
    expect(bad({ 'no-slash': factors() })).toThrow(/owner\/name/);
    expect(bad({ 'a/b': factors({ era: 'ancient' }) })).toThrow(/a\/b: era must be one of/);
    expect(bad({ 'a/b': factors({ ref: 'main' }) })).toThrow(/40-character commit hash/);
    expect(bad({ 'a/b': factors({ stack: [''] }) })).toThrow(StressError);
    expect(() => parseManifest({ version: 2, repos: {} }, 'x')).toThrow(/not a stress manifest/);
  });
});

describe('measuring a repository', () => {
  test('sizes and layouts fall into classes', () => {
    expect(complexityOf(10)).toBe('small');
    expect(complexityOf(300)).toBe('medium');
    expect(complexityOf(25_000)).toBe('huge');
    const byLanguage = {
      typescript: { files: 10, bytes: 500 },
      go: { files: 4, bytes: 300 },
      python: { files: 4, bytes: 200 },
    };
    expect(structureOf({ packages: 0, workspaceMarkers: [], byLanguage })).toBe('polyglot');
    expect(structureOf({ packages: 0, workspaceMarkers: ['nx.json'], byLanguage })).toBe(
      'monorepo',
    );
    expect(structureOf({ packages: 4, workspaceMarkers: [], byLanguage: {} })).toBe('monorepo');
    expect(structureOf({ packages: 1, workspaceMarkers: [], byLanguage: {} })).toBe('nested');
    expect(
      structureOf({
        packages: 0,
        workspaceMarkers: [],
        byLanguage: { go: { files: 1, bytes: 9 } },
      }),
    ).toBe('single');
  });

  test('symbols are chosen by seed, and named the way someone would ask for them', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(sample(items, 5, 7)).toEqual(sample(items, 5, 7));
    expect(sample(items, 5, 7)).not.toEqual(sample(items, 5, 8));
    expect(sample(items, 500, 1)).toHaveLength(50);
    expect(wordsOf('getUserByID')).toBe('get user by id');
    expect(wordsOf('parse_http_request')).toBe('parse http request');
    expect(percentile([5, 1, 9, 3, 7], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
  });
});

function result(commit: string, metrics: Record<string, number>, ok = true): RepoResult {
  return {
    id: 'a/one',
    declared: factors() as never,
    commit,
    outcome: ok ? 'ok' : 'failed',
    steps: {},
    metrics,
  };
}

function run(id: string, ...results: RepoResult[]): RunRecord {
  return {
    id,
    startedAt: id,
    finishedAt: id,
    machine: { os: 'test', cpus: 1, cpuModel: 'x', memoryMb: 1 },
    program: { path: 'p', version: '0.1.0', sizeBytes: 1, modifiedAt: id, sha256: 'a'.repeat(64) },
    options: {
      dense: true,
      queries: 1,
      seed: 1,
      fresh: true,
      timeoutMs: null,
      since: '2025-01-01',
    },
    results,
  };
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const verdicts = (runs: RunRecord[], window = 3) =>
  Object.fromEntries(
    (compare(runs, { window })[0]?.deltas ?? []).map((delta) => [delta.key, delta.verdict]),
  );

describe('comparing the latest execution with the window before it', () => {
  const steady = {
    'structural.ms': 1000,
    symbols: 168,
    'query.exact.hitRate': 0.9,
    'health.failures': 0,
  };

  test('the first execution is a baseline', () => {
    const [only] = compare([run('r1', result(SHA_A, steady))], { window: 3 });
    expect(only?.state).toBe('baseline');
  });

  test('noise inside the window is stable; slower than the worst of it is a regression', () => {
    const before = [
      run('r1', result(SHA_A, { ...steady, 'structural.ms': 1000 })),
      run('r2', result(SHA_A, { ...steady, 'structural.ms': 1200 })),
    ];
    expect(
      verdicts([...before, run('r3', result(SHA_A, { ...steady, 'structural.ms': 1350 }))]),
    ).toMatchObject({
      'structural.ms': 'stable',
    });
    expect(
      verdicts([...before, run('r3', result(SHA_A, { ...steady, 'structural.ms': 2400 }))]),
    ).toMatchObject({
      'structural.ms': 'regression',
    });
    expect(
      verdicts([...before, run('r3', result(SHA_A, { ...steady, 'structural.ms': 300 }))]),
    ).toMatchObject({
      'structural.ms': 'improvement',
    });
  });

  test('a difference too small to matter in absolute terms is not a regression', () => {
    const before = [
      run('r1', result(SHA_A, { 'startup.ms': 10 })),
      run('r2', result(SHA_A, { 'startup.ms': 10 })),
    ];
    expect(
      verdicts([...before, run('r3', result(SHA_A, { 'startup.ms': 40 }))])['startup.ms'],
    ).toBe('stable');
  });

  test('counts that move, and quality that drops, are reported', () => {
    const before = [run('r1', result(SHA_A, steady)), run('r2', result(SHA_A, steady))];
    const after = run('r3', result(SHA_A, { ...steady, symbols: 150, 'query.exact.hitRate': 0.6 }));
    expect(verdicts([...before, after])).toMatchObject({
      symbols: 'changed',
      'query.exact.hitRate': 'regression',
    });
  });

  test('a repository that moved is compared only with runs at the same commit', () => {
    const runs = [
      run('r1', result(SHA_A, { 'structural.ms': 100 })),
      run('r2', result(SHA_B, { 'structural.ms': 5000 })),
      run('r3', result(SHA_B, { 'structural.ms': 5100 })),
    ];
    const [comparison] = compare(runs, { window: 3 });
    expect(comparison?.runs).toEqual(['r2', 'r3']);
    expect(comparison?.otherCommits).toBe(1);
    expect(comparison?.deltas[0]?.verdict).toBe('stable');
  });

  test('only the last window of executions counts', () => {
    const runs = [
      run('r1', result(SHA_A, { symbols: 1 })),
      run('r2', result(SHA_A, { symbols: 5 })),
      run('r3', result(SHA_A, { symbols: 5 })),
      run('r4', result(SHA_A, { symbols: 5 })),
    ];
    expect(compare(runs, { window: 3 })[0]?.runs).toEqual(['r2', 'r3', 'r4']);
    expect(verdicts(runs)).toMatchObject({ symbols: 'stable' });
  });

  test('a regression or a failed run blocks a release; a moved count or an improvement does not', () => {
    const before = [run('r1', result(SHA_A, steady)), run('r2', result(SHA_A, steady))];
    const gate = (last: RunRecord) => blocksRelease(compare([...before, last], { window: 3 }));
    expect(gate(run('r3', result(SHA_A, steady)))).toBe(false);
    expect(gate(run('r3', result(SHA_A, { ...steady, symbols: 150 })))).toBe(false);
    expect(gate(run('r3', result(SHA_A, { ...steady, 'structural.ms': 100 })))).toBe(false);
    expect(gate(run('r3', result(SHA_A, { ...steady, 'query.exact.hitRate': 0.6 })))).toBe(true);
    expect(gate(run('r3', result(SHA_A, steady, false)))).toBe(true);
  });

  test('a repository that starts failing is called out', () => {
    const runs = [
      run('r1', result(SHA_A, steady)),
      run('r2', result(SHA_A, { ...steady, 'health.failures': 1 }, false)),
    ];
    const text = renderComparison(compare(runs, { window: 3 }), runs, 3);
    expect(text).toContain('FAILED');
    expect(text).toContain('REGRESSION');
    expect(text).toContain('health.failures');
  });
});
