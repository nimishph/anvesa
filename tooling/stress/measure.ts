/**
 * One stress run: for each chosen repository, get it at its pinned commit, measure what it is, run
 * anvesa on it the way a person would (index, index again, ask questions) and record numbers.
 *
 * A step that fails is a result, not a reason to stop: the run records what failed and where, and
 * goes on to the next repository. The record is what `compare` reads later.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { type Footprint, measureFootprint } from './footprint.ts';
import { checkout, type History, history } from './git.ts';
import { type Entry, type RepoFactors, StressError } from './manifest.ts';
import type { Program } from './program.ts';
import { short, tailLines } from './text.ts';

export interface RunOptions {
  readonly program: Program;
  readonly reposRoot: string;
  /** Embed and measure dense search, or leave the model out. */
  readonly dense: boolean;
  /** Symbols to ask about per repository. */
  readonly queries: number;
  /** Chooses which symbols: the same seed asks about the same ones. */
  readonly seed: number;
  /** Start every repository from no index. Without it the previous index is reused. */
  readonly fresh: boolean;
  /** Give up on one step after this long. Chosen by the caller; there is none by default. */
  readonly timeoutMs?: number | undefined;
  /** Commits since this date are read for signs of an assistant. */
  readonly since: string;
  readonly onProgress?: ((message: string) => void) | undefined;
}

export interface StepResult {
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly maxRssMb: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface Failure {
  readonly step: string;
  readonly message: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface RepoResult {
  readonly id: string;
  readonly declared: RepoFactors;
  readonly commit: string;
  readonly outcome: 'ok' | 'failed';
  readonly failure?: Failure;
  readonly footprint?: Footprint;
  readonly history?: History;
  readonly embedder?: string;
  readonly steps: Readonly<Record<string, StepResult>>;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface RunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly machine: {
    readonly os: string;
    readonly cpus: number;
    readonly cpuModel: string;
    readonly memoryMb: number;
  };
  readonly program: Omit<Program, 'path'> & { readonly path: string };
  readonly options: {
    readonly dense: boolean;
    readonly queries: number;
    readonly seed: number;
    readonly fresh: boolean;
    readonly timeoutMs: number | null;
    readonly since: string;
  };
  readonly results: readonly RepoResult[];
}

interface Executed extends StepResult {
  readonly stdout: string;
  readonly stderr: string;
}

async function execute(
  program: Program,
  args: readonly string[],
  directory: string,
  timeoutMs: number | undefined,
): Promise<Executed> {
  const started = performance.now();
  const child = Bun.spawn({
    cmd: [program.path, ...args, '--root', directory],
    stdout: 'pipe',
    stderr: 'pipe',
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  const wallMs = performance.now() - started;
  const usage = child.resourceUsage();
  const rss = usage?.maxRSS ?? 0;
  return {
    wallMs,
    cpuMs: usage ? Number(usage.cpuTime.total) / 1000 : 0,
    // Windows and Linux report kilobytes, macOS bytes.
    maxRssMb: platform() === 'darwin' ? rss / 1_048_576 : rss / 1024,
    exitCode: code,
    timedOut: timeoutMs !== undefined && wallMs >= timeoutMs && code !== 0,
    stdout,
    stderr,
  };
}

/** The number of bytes under a folder. */
function sizeOfTree(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? sizeOfTree(child) : statSync(child).size;
  }
  return total;
}

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  ] as number;
}

/** A small deterministic generator, so a seed always picks the same symbols. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample<T>(items: readonly T[], count: number, seed: number): T[] {
  const random = generator(seed);
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as T, shuffled[i] as T];
  }
  return shuffled.slice(0, count);
}

/** `getUserByID` and `get_user_by_id` both become "get user by id": how someone would ask for it. */
export function wordsOf(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.$]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** JSON that code-lens printed, read by the paths this file knows. */
interface Json {
  // biome-ignore lint/suspicious/noExplicitAny: parsed output of another program, checked where each field is used
  [key: string]: any;
}

class StepFailed extends StressError {
  constructor(readonly failure: Failure) {
    super(failure.message, { context: { ...failure } });
  }
}

async function measureRepo(entry: Entry, options: RunOptions): Promise<RepoResult> {
  const say = options.onProgress ?? (() => undefined);
  const { id, factors } = entry;
  const steps: Record<string, StepResult> = {};
  const metrics: Record<string, number> = {};

  say(`${id}: getting it${factors.ref ? ` at ${short(factors.ref)}` : ''}`);
  let placed: Awaited<ReturnType<typeof checkout>>;
  try {
    placed = await checkout(options.reposRoot, id, factors.ref, factors.scope);
  } catch (failure) {
    if (!(failure instanceof StressError)) throw failure;
    return {
      id,
      declared: factors,
      commit: factors.ref ?? 'unknown',
      outcome: 'failed',
      failure: { step: 'checkout', message: failure.message, exitCode: null, timedOut: false },
      steps,
      metrics: { 'health.failures': 1 },
    };
  }
  const { directory, commit } = placed;

  say(`${id}: measuring what it is`);
  const footprint = await measureFootprint(directory, factors.scope);
  const commits = await history(directory, options.since);
  metrics['repo.sourceFiles'] = footprint.sourceFiles;
  metrics['repo.sourceLines'] = footprint.sourceLines;
  metrics['repo.aiCommitShare'] =
    commits.recent === 0 ? 0 : commits.recentAssisted / commits.recent;

  const run = async (step: string, args: string[], expectOk = true): Promise<Executed> => {
    say(`${id}: ${step}`);
    const done = await execute(options.program, args, directory, options.timeoutMs);
    steps[step] = {
      wallMs: done.wallMs,
      cpuMs: done.cpuMs,
      maxRssMb: done.maxRssMb,
      exitCode: done.exitCode,
      timedOut: done.timedOut,
    };
    if (expectOk && done.exitCode !== 0) {
      const detail = tailLines(done.stderr.trim() || done.stdout.trim(), 3);
      throw new StepFailed({
        step,
        message: done.timedOut
          ? `${step} did not finish in ${options.timeoutMs} ms`
          : `${step} exited with ${done.exitCode}: ${detail}`,
        exitCode: done.exitCode,
        timedOut: done.timedOut,
      });
    }
    return done;
  };
  const json = (text: string, step: string): Json => {
    try {
      return JSON.parse(text) as Json;
    } catch (cause) {
      throw new StepFailed({
        step,
        message: `${step} did not print JSON: ${(cause as Error).message}`,
        exitCode: 0,
        timedOut: false,
      });
    }
  };

  let embedder: string | undefined;
  let failure: Failure | undefined;
  try {
    if (options.fresh) {
      try {
        rmSync(join(directory, '.anvesa'), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      } catch (cause) {
        throw new StepFailed({
          step: 'reset',
          message: `could not remove the previous index (is an anvesa still running there?): ${(cause as Error).message}`,
          exitCode: null,
          timedOut: false,
        });
      }
    }
    const scope = factors.scope === undefined ? [] : ['--scope', factors.scope];

    const startup = await run('startup', ['--version']);
    metrics['startup.ms'] = startup.wallMs;

    const structural = json(
      (await run('structural', ['index', '--no-embed', '--json', ...scope])).stdout,
      'structural',
    ).report as Json;
    metrics['structural.ms'] = steps.structural?.wallMs ?? Number.NaN;
    metrics['structural.rssMb'] = steps.structural?.maxRssMb ?? Number.NaN;
    metrics['structural.cpuMs'] = steps.structural?.cpuMs ?? Number.NaN;
    const files = structural.files as Json;
    metrics['files.seen'] = files.seen;
    metrics['files.indexed'] = files.added + files.modified + files.unchanged + files.touched;
    metrics['files.quarantined'] = files.quarantined + files.stillQuarantined;
    const link = structural.link as Json | undefined;
    if (link) {
      const calls = link.calls as Json;
      const callTotal = calls.resolved + calls.byName + calls.external + calls.unresolved;
      metrics['link.callsResolvedRatio'] = callTotal === 0 ? 1 : calls.resolved / callTotal;
      const imports = link.imports as Json;
      const importTotal = imports.resolved + imports.asset + imports.external + imports.dangling;
      metrics['link.importsDanglingRatio'] = importTotal === 0 ? 0 : imports.dangling / importTotal;
    }

    if (options.dense) {
      const dense = json((await run('dense', ['index', '--json', ...scope])).stdout, 'dense');
      metrics['dense.ms'] = steps.dense?.wallMs ?? Number.NaN;
      metrics['dense.rssMb'] = steps.dense?.maxRssMb ?? Number.NaN;
      metrics['dense.cards'] = (dense.report as Json).dense?.cards ?? 0;
    }

    // Without dense the second run must not embed either: it measures a run with nothing to do.
    await run('incremental', [
      'index',
      '--json',
      ...(options.dense ? [] : ['--no-embed']),
      ...scope,
    ]);
    metrics['incremental.ms'] = steps.incremental?.wallMs ?? Number.NaN;

    const status = json((await run('status', ['status', '--json'])).stdout, 'status');
    const index = status.index as Json;
    metrics.symbols = index.symbols;
    metrics.calls = index.calls;
    metrics.imports = index.imports;
    metrics.edges = index.edges;
    if (options.dense) {
      // `status` does not open the model; the doctor says which one an index would use here.
      const doctor = await run('model', ['model', 'doctor'], false);
      embedder = /would use: (\S+)/.exec(doctor.stdout)?.[1];
    }
    metrics['db.bytes'] = sizeOfTree(join(directory, '.anvesa'));

    await asking(options, metrics, run, json, options.dense && (metrics['dense.cards'] ?? 0) > 0);
  } catch (caught) {
    if (!(caught instanceof StepFailed)) throw caught;
    failure = caught.failure;
    metrics['health.failures'] = 1;
  }
  metrics['health.failures'] ??= 0;

  return {
    id,
    declared: factors,
    commit,
    outcome: failure ? 'failed' : 'ok',
    ...(failure ? { failure } : {}),
    footprint,
    history: commits,
    ...(embedder === undefined ? {} : { embedder }),
    steps,
    metrics,
  };
}

/** Ask about symbols the index holds: by exact name, in words, and for who calls them. */
async function asking(
  options: RunOptions,
  metrics: Record<string, number>,
  run: (step: string, args: string[], expectOk?: boolean) => Promise<Executed>,
  json: (text: string, step: string) => Json,
  dense: boolean,
): Promise<void> {
  if (options.queries === 0) return;
  const pool = json(
    (
      await run('symbols', [
        'query',
        '//function[@declaration]',
        '--json',
        '--limit',
        String(options.queries * 25),
      ])
    ).stdout,
    'symbols',
  );
  const seen = new Set<string>();
  const candidates: { name: string; path: string }[] = [];
  for (const item of (pool.items ?? []) as Json[]) {
    const name = String(item.name ?? '');
    // Names that cannot sit inside a WQL string, or that repeat, would not be a clean question.
    if (name === '' || /["\\]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    candidates.push({ name, path: String(item.path) });
  }
  const chosen = sample(candidates, options.queries, options.seed);
  metrics['queries.asked'] = chosen.length;

  const structuralMs: number[] = [];
  const denseMs: number[] = [];
  const callerMs: number[] = [];
  let exact = 0;
  let recalled = 0;
  for (const symbol of chosen) {
    const exactRun = await run('exact', [
      'query',
      `//*[@name="${symbol.name}"][@declaration]`,
      '--json',
    ]);
    structuralMs.push(exactRun.wallMs);
    const found = json(exactRun.stdout, 'exact');
    if (((found.items ?? []) as Json[]).some((item) => item.path === symbol.path)) exact += 1;

    const callersRun = await run(
      'callers',
      ['callers', symbol.name, '--json', '--limit', '20'],
      false,
    );
    callerMs.push(callersRun.wallMs);

    if (dense) {
      const searchRun = await run('search', [
        'search',
        wordsOf(symbol.name),
        '--json',
        '--limit',
        '5',
      ]);
      denseMs.push(searchRun.wallMs);
      const asked = json(searchRun.stdout, 'search');
      if (((asked.items ?? []) as Json[]).some((item) => item.path === symbol.path)) recalled += 1;
    }
  }
  if (chosen.length === 0) return;
  metrics['query.exact.p50Ms'] = percentile(structuralMs, 0.5);
  metrics['query.exact.p95Ms'] = percentile(structuralMs, 0.95);
  metrics['query.exact.hitRate'] = exact / chosen.length;
  metrics['query.callers.p50Ms'] = percentile(callerMs, 0.5);
  if (dense) {
    metrics['query.search.p50Ms'] = percentile(denseMs, 0.5);
    metrics['query.search.p95Ms'] = percentile(denseMs, 0.95);
    metrics['query.search.recall5'] = recalled / chosen.length;
  }
}

export async function runStress(
  entries: readonly Entry[],
  options: RunOptions,
): Promise<RunRecord> {
  const startedAt = new Date();
  const results: RepoResult[] = [];
  for (const entry of entries) {
    const result = await measureRepo(entry, options);
    results.push(result);
    options.onProgress?.(
      `${entry.id}: ${result.outcome}${result.failure ? ` (${result.failure.message})` : ''}`,
    );
  }
  const finishedAt = new Date();
  return {
    id: startedAt.toISOString().replace(/[:.]/g, '-'),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    machine: {
      os: `${platform()} ${release()}`,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      memoryMb: Math.round(totalmem() / 1_048_576),
    },
    program: options.program,
    options: {
      dense: options.dense,
      queries: options.queries,
      seed: options.seed,
      fresh: options.fresh,
      timeoutMs: options.timeoutMs ?? null,
      since: options.since,
    },
    results,
  };
}
