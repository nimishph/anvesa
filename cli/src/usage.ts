import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * How this user runs each command, kept on this machine only and never sent anywhere (telemetry
 * included). `anvesa --help` uses it to put the commands they use now first; the rest is there to
 * show how useful and how accurate each command has been for them. It holds a known command's name
 * and numbers about its runs, each field one fact: no arguments, queries, paths or project.
 * `ANVESA_NO_USAGE=1` turns it off; deleting the file forgets it. Nothing here may ever fail a
 * command.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 14;
const HALF_LIFE_MS = HALF_LIFE_DAYS * DAY_MS;
/** A score below this (one use, about two months ago) is not recent any more. */
const RECENT_MIN = 0.05;
/** A run this soon after the last run of the same command counts as a repeat. */
const REPEAT_WINDOW_MS = 2 * 60 * 1000;
const FORMAT = 2;
const FILE = 'usage.json';

/** One command's record. Every field is one fact; counts start at 0, times are ms since the epoch. */
export interface CommandUsage {
  /** When it first ran since counting began; absent for a command carried over from format 1. */
  readonly first_used?: number;
  /** When it last ran, whatever the outcome. */
  readonly last_used: number;
  /** When it last failed (exit 1); absent if it never has. */
  readonly last_failed?: number;

  // Usefulness and accuracy.
  /** Every run, whatever the outcome: succeeded + failed + misused. */
  readonly runs: number;
  /** Runs that finished (exit 0). */
  readonly succeeded: number;
  /** Runs where the operation failed (exit 1). */
  readonly failed: number;
  /** Runs where the command line was wrong (exit 2). */
  readonly misused: number;
  /** Successful runs that returned results and found at least one (search, query, callers...). */
  readonly found: number;
  /** Successful runs that returned results and found none. */
  readonly empty: number;
  /** Runs started within two minutes of this command's previous run: often a retry or rewording. */
  readonly repeated: number;

  // Over time.
  /** Successful runs, each worth 1 and halving every `half_life_days`, as of `last_used`. */
  readonly score: number;
  /** Distinct local calendar days it ran on. */
  readonly active_days: number;

  // Extras.
  /** Wall time of every timed run added up, in ms (a server's lifetime is not timed). */
  readonly total_ms: number;
  /** Wall time of the last timed run, in ms. */
  readonly last_ms?: number;
  /** The anvesa version that last ran it. */
  readonly last_version?: string;
}

export interface UsageFile {
  /** The layout of this file: 2. Format 1 was `{ <command>: { score, last } }`. */
  readonly format: number;
  /** How many days a score takes to halve. */
  readonly half_life_days: number;
  /** When the counts in this file began. */
  readonly counting_since: number;
  readonly commands: Readonly<Record<string, CommandUsage>>;
}

/** What one run came to: its exit code and, when known, how long it took and what it found. */
export interface RunOutcome {
  /** 0 done, 1 the operation failed, 2 the command line was wrong. Defaults to 0. */
  readonly exit?: 0 | 1 | 2;
  readonly ms?: number;
  /** How many results it returned, for a command that returns results. */
  readonly results?: number;
  readonly version?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Where the record is kept, or `undefined` when it is off or there is no home to keep it in. */
export function usageFile(env: Env): string | undefined {
  if (env.ANVESA_NO_USAGE === '1') return undefined;
  if (env.ANVESA_HOME) return join(env.ANVESA_HOME, FILE);
  const home = env.HOME ?? env.USERPROFILE;
  return home ? join(home, '.anvesa', FILE) : undefined;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): number => (finite(value) && value >= 0 ? Math.floor(value) : 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A stored entry, cleaned: every field checked on its own, so one bad value loses only itself. */
function commandFrom(value: unknown): CommandUsage | undefined {
  if (!isRecord(value)) return undefined;
  // Format 1 kept `last` and a score as of then.
  const lastUsed = finite(value.last_used) ? value.last_used : value.last;
  if (!finite(lastUsed)) return undefined;
  const score = finite(value.score) && value.score >= 0 ? value.score : 0;
  return {
    ...(finite(value.first_used) ? { first_used: value.first_used } : {}),
    last_used: lastUsed,
    ...(finite(value.last_failed) ? { last_failed: value.last_failed } : {}),
    runs: count(value.runs),
    succeeded: count(value.succeeded),
    failed: count(value.failed),
    misused: count(value.misused),
    found: count(value.found),
    empty: count(value.empty),
    repeated: count(value.repeated),
    score,
    active_days: count(value.active_days),
    total_ms: count(value.total_ms),
    ...(finite(value.last_ms) && value.last_ms >= 0 ? { last_ms: Math.round(value.last_ms) } : {}),
    ...(typeof value.last_version === 'string' && /^[\w.+-]{1,32}$/.test(value.last_version)
      ? { last_version: value.last_version }
      : {}),
  };
}

function read(path: string, now: number): UsageFile {
  const fresh: UsageFile = {
    format: FORMAT,
    half_life_days: HALF_LIFE_DAYS,
    counting_since: now,
    commands: {},
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Missing, unreadable or not JSON: start again rather than fail a command over it.
    return fresh;
  }
  if (!isRecord(raw)) return fresh;
  // Format 2 nests the commands; format 1 was the commands themselves.
  const entries = raw.format === FORMAT && isRecord(raw.commands) ? raw.commands : raw;
  const commands: Record<string, CommandUsage> = {};
  for (const [name, value] of Object.entries(entries)) {
    const use = commandFrom(value);
    if (use) commands[name] = use;
  }
  const since =
    raw.format === FORMAT && finite(raw.counting_since) ? raw.counting_since : fresh.counting_since;
  return { ...fresh, counting_since: since, commands };
}

function decayed(use: CommandUsage, now: number): number {
  return use.score * 2 ** (-Math.max(0, now - use.last_used) / HALF_LIFE_MS);
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** `before` with one more run of `outcome` at `now`. */
export function withRun(
  before: CommandUsage | undefined,
  outcome: RunOutcome,
  now: number,
): CommandUsage {
  const exit = outcome.exit ?? 0;
  const ok = exit === 0;
  const results = ok && finite(outcome.results) ? outcome.results : undefined;
  const ms = finite(outcome.ms) && outcome.ms >= 0 ? Math.round(outcome.ms) : undefined;
  const firstUsed = before ? before.first_used : now;
  const lastFailed = exit === 1 ? now : before?.last_failed;
  const lastMs = ms ?? before?.last_ms;
  const version = outcome.version ?? before?.last_version;
  return {
    ...(firstUsed === undefined ? {} : { first_used: firstUsed }),
    last_used: now,
    ...(lastFailed === undefined ? {} : { last_failed: lastFailed }),
    runs: (before?.runs ?? 0) + 1,
    succeeded: (before?.succeeded ?? 0) + (ok ? 1 : 0),
    failed: (before?.failed ?? 0) + (exit === 1 ? 1 : 0),
    misused: (before?.misused ?? 0) + (exit === 2 ? 1 : 0),
    found: (before?.found ?? 0) + (results !== undefined && results > 0 ? 1 : 0),
    empty: (before?.empty ?? 0) + (results === 0 ? 1 : 0),
    repeated:
      (before?.repeated ?? 0) +
      (before && now >= before.last_used && now - before.last_used <= REPEAT_WINDOW_MS ? 1 : 0),
    // The help ranks what works: only a successful run adds to the score.
    score: (before ? decayed(before, now) : 0) + (ok ? 1 : 0),
    active_days:
      (before?.active_days ?? 0) + (before && sameLocalDay(before.last_used, now) ? 0 : 1),
    total_ms: (before?.total_ms ?? 0) + (ms ?? 0),
    ...(lastMs === undefined ? {} : { last_ms: lastMs }),
    ...(version === undefined ? {} : { last_version: version }),
  };
}

/**
 * Count one run of `command`, if it is one of `known` (so the file can only ever hold command
 * names). Written to a temporary file and renamed over the old one, so a reader never sees half.
 * Says whether it was recorded; a failure to write (a read-only home, a full disk) is not an
 * error, it only means the help is not reordered.
 */
export function recordUse(
  env: Env,
  command: string,
  known: ReadonlySet<string>,
  outcome: RunOutcome = {},
  now = Date.now(),
): boolean {
  const path = usageFile(env);
  if (!path || !known.has(command)) return false;
  try {
    const usage = read(path, now);
    const commands: Record<string, CommandUsage> = {};
    for (const [name, use] of Object.entries(usage.commands)) {
      if (known.has(name)) commands[name] = use;
    }
    commands[command] = withRun(commands[command], outcome, now);
    const next: UsageFile = { ...usage, format: FORMAT, half_life_days: HALF_LIFE_DAYS, commands };
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/** The whole record as it stands, or `undefined` when it is off. */
export function readUsage(env: Env, now = Date.now()): UsageFile | undefined {
  const path = usageFile(env);
  return path ? read(path, now) : undefined;
}

/**
 * The commands used most lately, best first: at most `limit` (all by default), none gone quiet.
 * The help limits its block itself, after merging names that share a line.
 */
export function recentCommands(env: Env, now = Date.now(), limit = Infinity): string[] {
  const usage = readUsage(env, now);
  if (!usage) return [];
  return Object.entries(usage.commands)
    .map(([name, use]) => ({ name, score: decayed(use, now) }))
    .filter((entry) => entry.score >= RECENT_MIN)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}
