/**
 * Compare the latest execution with the ones before it, per repository, over a window of the last
 * few executions (three by default). Only runs of the same commit of a repository are compared:
 * when the repository moved, the numbers move for reasons that have nothing to do with medha.
 *
 * A timing or size is a regression when it is worse than the *worst* of the window by more than the
 * tolerance, and an improvement when it is better than the best by more than it, so ordinary
 * run-to-run noise (the window's own spread) does not raise an alarm. A count that should not move
 * without the code or the program having changed is reported when it does.
 */
import type { RepoResult, RunRecord } from './measure.ts';
import { lastOf, short, withoutLast } from './text.ts';

type Kind = 'time' | 'memory' | 'size' | 'higher' | 'lower' | 'count' | 'fact';

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
  'link.callsResolvedRatio': 'higher',
  'link.importsDanglingRatio': 'lower',
  'query.exact.hitRate': 'higher',
  'query.search.recall5': 'higher',
  'health.failures': 'lower',
  'repo.sourceFiles': 'fact',
  'repo.sourceLines': 'fact',
  'repo.aiCommitShare': 'fact',
  'queries.asked': 'fact',
};

export interface Tolerances {
  /** How much worse than the window's worst (or better than its best) counts, as a fraction. */
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
  floorMs: 100,
  floorMb: 16,
  floorBytes: 64 * 1024,
  ratio: 0.02,
};

export type Verdict = 'regression' | 'improvement' | 'changed' | 'stable';

export interface Delta {
  readonly key: string;
  /** Oldest first; the latest run is last. */
  readonly values: readonly number[];
  readonly verdict: Verdict;
}

export interface Comparison {
  readonly id: string;
  readonly commit: string;
  /** Run ids, oldest first, that this comparison is made of. */
  readonly runs: readonly string[];
  /** `baseline`: there is nothing earlier to compare with yet. */
  readonly state: 'compared' | 'baseline';
  /** Runs of this repository skipped because it was at another commit. */
  readonly otherCommits: number;
  readonly outcome: readonly ('ok' | 'failed')[];
  readonly deltas: readonly Delta[];
}

function judge(key: string, values: readonly number[], tolerances: Tolerances): Verdict {
  const latest = values.at(-1) as number;
  const before = withoutLast(values).filter((value) => Number.isFinite(value));
  if (before.length === 0 || !Number.isFinite(latest)) return 'stable';
  const worst = Math.max(...before);
  const best = Math.min(...before);
  const kind = KINDS[key] ?? 'count';
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
      if (latest > worst * (1 + tolerances.relative) && latest - worst > floor) return 'regression';
      if (latest < best * (1 - tolerances.relative) && best - latest > floor) return 'improvement';
      return 'stable';
    }
    case 'higher':
      if (latest < best - tolerances.ratio) return 'regression';
      return latest > worst + tolerances.ratio ? 'improvement' : 'stable';
    case 'lower':
      if (latest > worst + tolerances.ratio) return 'regression';
      return latest < best - tolerances.ratio ? 'improvement' : 'stable';
    default:
      return before.includes(latest) ? 'stable' : 'changed';
  }
}

/** The runs of one repository at one commit, oldest first, up to `window` of them ending at the latest. */
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
  return { picked: lastOf(same, window), others: all.length - same.length };
}

export function compare(
  runs: readonly RunRecord[],
  options: {
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
    const deltas: Delta[] = keys.map((key) => {
      const values = picked.map(({ result: r }) => r.metrics[key] ?? Number.NaN);
      return { key, values, verdict: judge(key, values, tolerances) };
    });
    comparisons.push({
      id: result.id,
      commit: result.commit,
      runs: picked.map(({ run }) => run.id),
      state: picked.length < 2 ? 'baseline' : 'compared',
      otherCommits: others,
      outcome: picked.map(({ result: r }) => r.outcome),
      deltas,
    });
  }
  return comparisons;
}

const formatValue = (key: string, value: number): string => {
  if (!Number.isFinite(value)) return '-';
  const kind = KINDS[key] ?? 'count';
  if (kind === 'time') return `${Math.round(value)}ms`;
  if (kind === 'memory') return `${Math.round(value)}MB`;
  if (kind === 'size') return `${(value / 1_048_576).toFixed(1)}MB`;
  if (kind === 'higher' || kind === 'lower' || key === 'repo.aiCommitShare')
    return `${(value * 100).toFixed(1)}%`;
  return String(Math.round(value));
};

export function renderComparison(
  comparisons: readonly Comparison[],
  runs: readonly RunRecord[],
  window: number,
): string {
  const lines: string[] = [];
  const shown = lastOf(runs, window);
  lines.push(
    `window: last ${window} executions (${shown.map((run) => run.id).join(', ') || 'none'})`,
  );
  const newest = runs.at(-1);
  if (newest) {
    lines.push(
      `latest program: anvesa ${newest.program.version}, sha ${short(newest.program.sha256)}`,
    );
  }
  let regressions = 0;
  for (const c of comparisons) {
    const bad = c.deltas.filter((d) => d.verdict === 'regression');
    const good = c.deltas.filter((d) => d.verdict === 'improvement');
    const moved = c.deltas.filter((d) => d.verdict === 'changed');
    regressions +=
      bad.length + (c.outcome.at(-1) === 'failed' && withoutLast(c.outcome).includes('ok') ? 1 : 0);
    const status =
      c.state === 'baseline'
        ? 'baseline (nothing earlier at this commit)'
        : `${bad.length} regressions, ${good.length} improvements, ${moved.length} changed, ${c.deltas.length - bad.length - good.length - moved.length} stable`;
    lines.push('', `${c.id} @ ${short(c.commit)}  ${status}`);
    if (c.otherCommits > 0)
      lines.push(`  (${c.otherCommits} earlier run(s) at other commits are not compared)`);
    if (c.outcome.at(-1) === 'failed') lines.push('  the latest run of this repository FAILED');
    for (const [label, list] of [
      ['REGRESSION', bad],
      ['improved', good],
      ['changed', moved],
    ] as const) {
      for (const d of list) {
        lines.push(
          `  ${label.padEnd(10)} ${d.key.padEnd(28)} ${d.values.map((v) => formatValue(d.key, v)).join(' -> ')}`,
        );
      }
    }
  }
  lines.push('', regressions === 0 ? 'no regressions' : `${regressions} regression(s)`);
  return `${lines.join('\n')}\n`;
}
