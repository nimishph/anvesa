import { describe, expect, test } from 'bun:test';
import { compare, isFatal, renderComparison } from './compare.ts';
import { complexityOf, structureOf } from './footprint.ts';
import { byFactor, parseManifest, StressError, select } from './manifest.ts';
import {
  failureDetail,
  percentile,
  type RepoResult,
  type RunRecord,
  sample,
  wordsOf,
} from './measure.ts';
import { buildVersion, newerFirst } from './program.ts';

describe('local build discovery', () => {
  const here = `${process.platform}-${process.arch}`;

  test('finds release and prerelease builds for this platform only', () => {
    expect(buildVersion(`anvesa-0.7.4-${here}`)).toBe('0.7.4');
    expect(buildVersion(`anvesa-0.8.0-alpha.0-${here}`)).toBe('0.8.0-alpha.0');
    expect(buildVersion(`anvesa-1.0.0-rc.1-${here}`)).toBe('1.0.0-rc.1');
    expect(buildVersion(`anvesa-0.8.0-alpha.0-${here}.zip`)).toBeUndefined();
    expect(buildVersion('anvesa-0.8.0-plan9-mips')).toBeUndefined();
    expect(buildVersion('release-0.5.2')).toBeUndefined();
  });

  test('orders versions newest first, as semver does', () => {
    const versions = [
      '0.7.4',
      '0.8.0-alpha.0',
      '0.8.0',
      '0.8.0-alpha.10',
      '0.8.0-beta',
      '0.8.0-alpha.2',
      '0.10.0',
      '0.8.0-alpha',
    ];
    expect([...versions].sort(newerFirst)).toEqual([
      '0.10.0',
      '0.8.0',
      '0.8.0-beta',
      '0.8.0-alpha.10',
      '0.8.0-alpha.2',
      '0.8.0-alpha.0',
      '0.8.0-alpha',
      '0.7.4',
    ]);
  });
});

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
  test('a failed step is reported by the error anvesa printed, not its closing braces', () => {
    const stderr = [
      'note: recorded "model": "anvesa-code-150m" in .anvesa/config.json',
      JSON.stringify(
        {
          error: {
            code: 'INDEXER_STORE_OPERATION',
            message: 'Index database failed to close the database',
            cause: { name: 'Error', message: 'database is locked' },
          },
        },
        null,
        2,
      ),
    ].join('\n');
    expect(failureDetail(stderr)).toBe(
      'INDEXER_STORE_OPERATION: Index database failed to close the database (database is locked)',
    );
    expect(failureDetail('one\ntwo\nthree\nfour')).toBe('two | three | four');
  });

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
const movements = (runs: RunRecord[], window = 3) =>
  Object.fromEntries(
    (compare(runs, { window })[0]?.deltas ?? []).map((delta) => [delta.key, delta.movement]),
  );

describe('comparing the latest execution with the average of those before it', () => {
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

  test('a time is set against the average of the earlier runs, and only its direction is said', () => {
    const before = [
      run('r1', result(SHA_A, { ...steady, 'structural.ms': 1000 })),
      run('r2', result(SHA_A, { ...steady, 'structural.ms': 1200 })),
    ];
    const at = (ms: number) =>
      movements([...before, run('r3', result(SHA_A, { ...steady, 'structural.ms': ms }))])[
        'structural.ms'
      ];
    // Average 1100: within 25% (and the 200 ms floor) either way is stable.
    expect(at(1350)).toBe('stable');
    expect(at(1400)).toBe('higher');
    expect(at(800)).toBe('lower');
    const [comparison] = compare(
      [...before, run('r3', result(SHA_A, { ...steady, 'structural.ms': 1400 }))],
      { window: 3 },
    );
    expect(comparison?.deltas.find((d) => d.key === 'structural.ms')?.baseline).toBe(1100);
  });

  test('a difference too small to matter in absolute terms is stable', () => {
    const before = [
      run('r1', result(SHA_A, { 'startup.ms': 10 })),
      run('r2', result(SHA_A, { 'startup.ms': 10 })),
    ];
    expect(
      movements([...before, run('r3', result(SHA_A, { 'startup.ms': 40 }))])['startup.ms'],
    ).toBe('stable');
  });

  test('hosted-runner timing noise under the absolute floor is stable', () => {
    const before = [
      run('r1', result(SHA_A, { 'incremental.ms': 222 })),
      run('r2', result(SHA_A, { 'incremental.ms': 222 })),
    ];
    expect(
      movements([...before, run('r3', result(SHA_A, { 'incremental.ms': 366 }))])['incremental.ms'],
    ).toBe('stable');
  });

  test('counts that move, and rates that move, are reported', () => {
    const before = [run('r1', result(SHA_A, steady)), run('r2', result(SHA_A, steady))];
    const after = run('r3', result(SHA_A, { ...steady, symbols: 150, 'query.exact.hitRate': 0.6 }));
    expect(movements([...before, after])).toMatchObject({
      symbols: 'changed',
      'query.exact.hitRate': 'lower',
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
    expect(comparison?.deltas[0]?.movement).toBe('stable');
  });

  test('the average is over the last `window` earlier executions', () => {
    const runs = [
      run('r1', result(SHA_A, { symbols: 1 })),
      run('r2', result(SHA_A, { symbols: 5 })),
      run('r3', result(SHA_A, { symbols: 5 })),
      run('r4', result(SHA_A, { symbols: 5 })),
      run('r5', result(SHA_A, { symbols: 5 })),
    ];
    expect(compare(runs, { window: 3 })[0]?.runs).toEqual(['r2', 'r3', 'r4', 'r5']);
    expect(movements(runs)).toMatchObject({ symbols: 'stable' });
  });

  test('only a run that did not finish is fatal; numbers that moved, however far, are not', () => {
    const before = [run('r1', result(SHA_A, steady)), run('r2', result(SHA_A, steady))];
    const fatal = (last: RunRecord) => isFatal(compare([...before, last], { window: 3 }));
    expect(fatal(run('r3', result(SHA_A, steady)))).toBe(false);
    expect(fatal(run('r3', result(SHA_A, { ...steady, symbols: 150 })))).toBe(false);
    expect(fatal(run('r3', result(SHA_A, { ...steady, 'structural.ms': 9000 })))).toBe(false);
    expect(fatal(run('r3', result(SHA_A, { ...steady, 'query.exact.hitRate': 0.1 })))).toBe(false);
    expect(fatal(run('r3', result(SHA_A, steady, false)))).toBe(true);
    // An earlier failure that has since been fixed does not stop this release.
    const recovered = [run('r1', result(SHA_A, steady, false)), run('r2', result(SHA_A, steady))];
    expect(isFatal(compare(recovered, { window: 3 }))).toBe(false);
  });

  test('the report is neutral, names each run’s processor, and calls out a run that failed', () => {
    const runs = [
      run('r1', result(SHA_A, steady)),
      run('r2', result(SHA_A, { ...steady, 'structural.ms': 1400 })),
      run('r3', {
        ...result(SHA_A, { ...steady, 'health.failures': 1 }, false),
        failure: { step: 'dense', message: 'timed out', exitCode: null, timedOut: true },
      }),
    ];
    const text = renderComparison(compare(runs, { window: 3 }), runs, 3);
    expect(text).toContain('FATAL: the latest run did not finish: dense: timed out');
    expect(text).toContain('1 repository run(s) FAILED');
    expect(text).toContain('anvesa 0.1.0');
    expect(text).toContain('x (1 cores)');
    expect(text).toContain('changed  health.failures');
    expect(text).not.toMatch(/regression|improve/i);
    const moved = [
      run('r1', result(SHA_A, steady)),
      run('r2', result(SHA_A, { ...steady, 'structural.ms': 1400 })),
    ];
    expect(renderComparison(compare(moved, { window: 3 }), moved, 3)).toContain(
      'higher   structural.ms              1000ms (avg 1000ms) -> 1400ms  +40%',
    );
  });

  test('a number measured for the first time is shown as new', () => {
    const runs = [
      run('r1', result(SHA_A, steady)),
      run('r2', result(SHA_A, { ...steady, 'query.search.recall5': 0.75 })),
    ];
    expect(renderComparison(compare(runs, { window: 3 }), runs, 3)).toContain(
      'new      query.search.recall5       75.0%',
    );
  });
});
