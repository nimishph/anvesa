/**
 * Compare the latest execution with the ones before it, per repository: each number against the
 * average of up to `window` earlier executions (three by default). Only runs of the same commit of
 * a repository are compared: when the repository moved, the numbers move for reasons that have
 * nothing to do with anvesa.
 *
 * The comparison is neutral. It says which way a number moved, and by how much, when the move is
 * bigger than the tolerance; it does not call that good or bad. Runs on hosted CI land on different
 * processors from one release to the next, so a timing that moved may be the machine: the report
 * names each run's processor so a reader can tell. Only a repository whose latest run did not
 * finish (a step crashed, timed out or printed no answer) is fatal.
 */
import type { RepoResult, RunRecord } from './measure.ts';
import { lastOf, short, withoutLast } from './text.ts';

type Kind = 'time' | 'memory' | 'size' | 'ratio' | 'fact';

const KINDS: Readonly<Record<string, Kind>> = {
  'startup.ms': 'time',
  'structural.ms': 'time',
  'structural.cpuMs': 'time',
  'dense.ms': 'time',
  'incremental.ms': 'time',
  'query.exact.p50Ms': 'time',
  'query.exact.p95Ms': 'time',
  'query.callers.p50Ms': 'time',
  'query.search.p50Ms': 'time',
  'query.search.p95Ms': 'time',
  'structural.rssMb': 'memory',
  'dense.rssMb': 'memory',
  'db.bytes': 'size',
  'link.callsResolvedRatio': 'ratio',
  'link.importsDanglingRatio': 'ratio',
  'query.exact.hitRate': 'ratio',
  'query.search.recall5': 'ratio',
  'repo.aiCommitShare': 'ratio',
};

export interface Tolerances {
  /** How far from the earlier runs' average a number may move unremarked, as a fraction. */
  readonly relative: number;
  /** A time difference under this many milliseconds is noise whatever the fraction. */
  readonly floorMs: number;
  readonly floorMb: number;
  readonly floorBytes: number;
  /** For ratios (hit rates, resolved shares): how far they may move. */
  readonly ratio: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  relative: 0.25,
  floorMs: 200,
  floorMb: 16,
  floorBytes: 64 * 1024,
  ratio: 0.02,
};

/**
 * Which way a number moved from the earlier runs' average, beyond the tolerance. `changed` is a
 * count (files, symbols, links) that is not one of the earlier values. No movement is a verdict.
 */
export type Movement = 'higher' | 'lower' | 'changed' | 'stable';

export interface Delta {
  readonly key: string;
  /** Oldest first; the latest run is last. */
  readonly values: readonly number[];
  /** The average of the earlier runs' values; NaN when there are none. */
  readonly baseline: number;
  readonly movement: Movement;
}

export interface Comparison {
  readonly id: string;
  readonly commit: string;
  /** Run ids, oldest first, that this comparison is made of; the latest is last. */
  readonly runs: readonly string[];
  /** `baseline`: there is nothing earlier to compare with yet. */
  readonly state: 'compared' | 'baseline';
  /** Runs of this repository skipped because it was at another commit. */
  readonly otherCommits: number;
  readonly outcome: readonly ('ok' | 'failed')[];
  /** Why the latest run did not finish, when it did not. */
  readonly failure?: string;
  readonly deltas: readonly Delta[];
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

function move(key: string, values: readonly number[], tolerances: Tolerances): Delta {
  const latest = values.at(-1) as number;
  const before = withoutLast(values).filter((value) => Number.isFinite(value));
  const baseline = mean(before);
  const delta = (movement: Movement): Delta => ({ key, values, baseline, movement });
  if (before.length === 0 || !Number.isFinite(latest)) return delta('stable');
  const kind = KINDS[key] ?? 'fact';
  switch (kind) {
    case 'time':
    case 'memory':
    case 'size': {
      const floor =
        kind === 'time'
          ? tolerances.floorMs
          : kind === 'memory'
            ? tolerances.floorMb
            : tolerances.floorBytes;
      const apart = Math.abs(latest - baseline);
      if (apart <= floor || apart <= baseline * tolerances.relative) return delta('stable');
      return delta(latest > baseline ? 'higher' : 'lower');
    }
    case 'ratio':
      if (Math.abs(latest - baseline) <= tolerances.ratio) return delta('stable');
      return delta(latest > baseline ? 'higher' : 'lower');
    default:
      // A count should not move while the commit and the program stay the same.
      return delta(before.includes(latest) ? 'stable' : 'changed');
  }
}

/** One repository's runs at one commit, oldest first: up to `window` earlier ones and the latest. */
function windowOf(
  runs: readonly RunRecord[],
  id: string,
  commit: string,
  window: number,
): { readonly picked: { run: RunRecord; result: RepoResult }[]; readonly others: number } {
  const all = runs.flatMap((run) => {
    const result = run.results.find((entry) => entry.id === id);
    return result ? [{ run, result }] : [];
  });
  const same = all.filter(({ result }) => result.commit === commit);
  return { picked: lastOf(same, window + 1), others: all.length - same.length };
}

export function compare(
  runs: readonly RunRecord[],
  options: {
    /** How many earlier executions the average is taken over. */
    readonly window: number;
    readonly tolerances?: Tolerances;
    readonly ids?: readonly string[];
  },
): Comparison[] {
  const tolerances = options.tolerances ?? DEFAULT_TOLERANCES;
  const latest = runs.at(-1);
  if (!latest) return [];
  const comparisons: Comparison[] = [];
  for (const result of latest.results) {
    if (options.ids && options.ids.length > 0 && !options.ids.includes(result.id)) continue;
    const { picked, others } = windowOf(runs, result.id, result.commit, options.window);
    const keys = [...new Set(picked.flatMap(({ result: r }) => Object.keys(r.metrics)))].sort();
    const deltas = keys.map((key) =>
      move(
        key,
        picked.map(({ result: r }) => r.metrics[key] ?? Number.NaN),
        tolerances,
      ),
    );
    comparisons.push({
      id: result.id,
      commit: result.commit,
      runs: picked.map(({ run }) => run.id),
      state: picked.length < 2 ? 'baseline' : 'compared',
      otherCommits: others,
      outcome: picked.map(({ result: r }) => r.outcome),
      ...(result.failure ? { failure: `${result.failure.step}: ${result.failure.message}` } : {}),
      deltas,
    });
  }
  return comparisons;
}

/** A repository whose latest run did not finish: the one thing that stops a release. */
export function isFatal(comparisons: readonly Comparison[]): boolean {
  return comparisons.some((entry) => entry.outcome.at(-1) === 'failed');
}

const formatValue = (key: string, value: number): string => {
  if (!Number.isFinite(value)) return '-';
  const kind = KINDS[key] ?? 'fact';
  if (kind === 'time') return `${Math.round(value)}ms`;
  if (kind === 'memory') return `${Math.round(value)}MB`;
  if (kind === 'size') return `${(value / 1_048_576).toFixed(1)}MB`;
  if (kind === 'ratio') return `${(value * 100).toFixed(1)}%`;
  return String(Math.round(value));
};

/** How far the latest is from the average, as a signed percentage; empty when it cannot be said. */
function percent(latest: number, baseline: number): string {
  if (!Number.isFinite(latest) || !Number.isFinite(baseline) || baseline === 0) return '';
  const change = ((latest - baseline) / baseline) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(0)}%`;
}

export function renderComparison(
  comparisons: readonly Comparison[],
  runs: readonly RunRecord[],
  window: number,
): string {
  const lines = [`the latest execution against the average of up to ${window} earlier ones`, ''];
  // Timings depend on the processor, and on hosted CI it changes from run to run: name it.
  for (const run of lastOf(runs, window + 1)) {
    lines.push(
      `  ${run.id}  anvesa ${run.program.version.padEnd(14)} ${run.machine.cpuModel} (${run.machine.cpus} cores)${run.options.dense ? '' : ', no dense'}`,
    );
  }
  const newest = runs.at(-1);
  if (newest) lines.push(`  latest program sha ${short(newest.program.sha256)}`);

  let moved = 0;
  let failed = 0;
  for (const c of comparisons) {
    const shifts = c.deltas.filter((d) => d.movement !== 'stable');
    const fresh = c.deltas.filter(
      (d) =>
        d.values.length > 1 &&
        Number.isFinite(d.values.at(-1)) &&
        withoutLast(d.values).every((value) => !Number.isFinite(value)),
    );
    moved += shifts.length;
    const fatal = c.outcome.at(-1) === 'failed';
    if (fatal) failed += 1;
    const status =
      c.state === 'baseline'
        ? 'baseline (nothing earlier at this commit)'
        : `${shifts.length} moved, ${c.deltas.length - shifts.length - fresh.length} within tolerance${fresh.length > 0 ? `, ${fresh.length} measured for the first time` : ''}`;
    lines.push('', `${c.id} @ ${short(c.commit)}  ${status}`);
    if (c.otherCommits > 0)
      lines.push(`  (${c.otherCommits} earlier run(s) at other commits are not compared)`);
    if (fatal)
      lines.push(`  FATAL: the latest run did not finish${c.failure ? `: ${c.failure}` : ''}`);
    for (const d of shifts) {
      const latest = d.values.at(-1) as number;
      const earlier = withoutLast(d.values).map((value) => formatValue(d.key, value));
      lines.push(
        `  ${d.movement.padEnd(8)} ${d.key.padEnd(26)} ${earlier.join(', ')} (avg ${formatValue(d.key, d.baseline)}) -> ${formatValue(d.key, latest)}  ${percent(latest, d.baseline)}`.trimEnd(),
      );
    }
    for (const d of fresh) {
      lines.push(`  new      ${d.key.padEnd(26)} ${formatValue(d.key, d.values.at(-1) as number)}`);
    }
  }
  lines.push(
    '',
    `${moved} number(s) moved beyond the tolerance; ${failed === 0 ? 'no repository failed' : `${failed} repository run(s) FAILED`}`,
  );
  return `${lines.join('\n')}\n`;
}
