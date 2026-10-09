import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Which commands this user runs, kept on this machine only, so `anvesa --help` can put the ones
 * they use now first. It holds a command's name and nothing else: no arguments, queries, paths or
 * project. Each use adds 1 to the command's score, and a score halves every two weeks, so what
 * was used a lot last month falls behind what is used this week. `ANVESA_NO_USAGE=1` turns it
 * off; deleting the file forgets it. Nothing here may ever fail a command.
 */

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** A score below this (one use, about two months ago) is not recent any more. */
const RECENT_MIN = 0.05;
const FILE = 'usage.json';

interface Use {
  /** The score at `last`; it has decayed since. */
  readonly score: number;
  /** When the command was last run, in ms since the epoch. */
  readonly last: number;
}

type Usage = Record<string, Use>;

type Env = Readonly<Record<string, string | undefined>>;

/** Where the record is kept, or `undefined` when it is off or there is no home to keep it in. */
export function usageFile(env: Env): string | undefined {
  if (env.ANVESA_NO_USAGE === '1') return undefined;
  if (env.ANVESA_HOME) return join(env.ANVESA_HOME, FILE);
  const home = env.HOME ?? env.USERPROFILE;
  return home ? join(home, '.anvesa', FILE) : undefined;
}

function read(path: string): Usage {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Missing, unreadable or not JSON: start again rather than fail a command over it.
    return {};
  }
  const usage: Usage = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return usage;
  for (const [name, value] of Object.entries(raw)) {
    const { score, last } = (value ?? {}) as Partial<Use>;
    if (Number.isFinite(score) && Number.isFinite(last)) {
      usage[name] = { score: score as number, last: last as number };
    }
  }
  return usage;
}

function decayed(use: Use, now: number): number {
  return use.score * 2 ** (-Math.max(0, now - use.last) / HALF_LIFE_MS);
}

/**
 * Count one use of `command`, if it is one of `known` (so the file can only ever hold command
 * names). Written to a temporary file and renamed over the old one, so a reader never sees half.
 * Says whether it was recorded; a failure to write (a read-only home, a full disk) is not an
 * error, it only means the help is not reordered.
 */
export function recordUse(
  env: Env,
  command: string,
  known: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  const path = usageFile(env);
  if (!path || !known.has(command)) return false;
  try {
    const usage = read(path);
    const before = usage[command];
    for (const name of Object.keys(usage)) if (!known.has(name)) delete usage[name];
    usage[command] = { score: (before ? decayed(before, now) : 0) + 1, last: now };
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(usage)}\n`, 'utf8');
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commands used most lately, best first: at most `limit` (all by default), none gone quiet.
 * The help limits its block itself, after merging names that share a line.
 */
export function recentCommands(env: Env, now = Date.now(), limit = Infinity): string[] {
  const path = usageFile(env);
  if (!path) return [];
  return Object.entries(read(path))
    .map(([name, use]) => ({ name, score: decayed(use, now) }))
    .filter((entry) => entry.score >= RECENT_MIN)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}
