/**
 * The stress-test manifest: which open-source repositories to run anvesa on, and what each one
 * is (its language and stack, how big, how it is laid out, how much of it is old human-written code
 * and how much is recent and AI-assisted).
 *
 * It is a flat map, id -> factors, so a repository is listed once whatever it is; `byFactor` gives
 * the per-language (or per-anything) view. The file lives in the person's own stress home, outside
 * every repository, and is never committed: it is a list of what one machine likes to test against.
 */
import { CodeLensError } from '@cntxt-labs/anvesa-core';

export class StressError extends CodeLensError {
  readonly code = 'CLI_STRESS_FAILED';
  readonly subsystem = 'cli';
}

export const STRUCTURES = ['single', 'monorepo', 'polyglot', 'nested'] as const;
export const COMPLEXITIES = ['small', 'medium', 'large', 'huge'] as const;
/**
 * How the code came to be. `legacy`: mature code written by people, mostly before 2018.
 * `modern`: human-written since then. `ai-era`: started or largely rewritten in the years of coding
 * assistants. A declaration, checked by what the run measures (`aiCommitShare`, agent marker files).
 */
export const ERAS = ['legacy', 'modern', 'ai-era'] as const;

export type Structure = (typeof STRUCTURES)[number];
export type Complexity = (typeof COMPLEXITIES)[number];
export type Era = (typeof ERAS)[number];

/** What GitHub said about the repository the last time it was asked. */
export interface GithubFacts {
  readonly stars: number;
  readonly sizeKb: number;
  readonly createdAt: string;
  readonly pushedAt: string;
  readonly defaultBranch: string;
  readonly archived: boolean;
  readonly checkedAt: string;
}

export interface RepoFactors {
  /** The commit runs check out. Without one, a run uses the tip of the default branch and records it. */
  readonly ref?: string;
  /** Lowercase, as medha names it: `typescript`, `python`, `go`... */
  readonly language: string;
  /** Other languages that matter in it. */
  readonly languages?: readonly string[];
  /** What it is: `web-framework`, `compiler`, `database`, `cli`, `ui`... Free words. */
  readonly stack: readonly string[];
  readonly structure: Structure;
  readonly complexity: Complexity;
  readonly era: Era;
  /** Index only this folder, for a repository too big to be tested whole. */
  readonly scope?: string;
  readonly notes?: string;
  readonly github?: GithubFacts;
}

export interface Manifest {
  readonly version: 1;
  readonly repos: Readonly<Record<string, RepoFactors>>;
}

const ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function emptyManifest(): Manifest {
  return { version: 1, repos: {} };
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  source: string,
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new StressError(`${source}: ${field} must be one of ${allowed.join(', ')}`, {
    context: { field, received: value },
  });
}

function words(value: unknown, field: string, source: string): string[] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '')) {
    return value as string[];
  }
  throw new StressError(`${source}: ${field} must be a list of non-empty words`, {
    context: { field, received: value },
  });
}

/** Check what a manifest file holds. Every problem names the repository and the field. */
export function parseManifest(raw: unknown, source: string): Manifest {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.repos)) {
    throw new StressError(
      `${source} is not a stress manifest: expected {"version":1,"repos":{...}}`,
    );
  }
  const repos: Record<string, RepoFactors> = {};
  for (const [id, entry] of Object.entries(raw.repos)) {
    const where = `${source}: ${id}`;
    if (!ID.test(id)) throw new StressError(`${where} is not an owner/name repository id`);
    if (!isRecord(entry)) throw new StressError(`${where} must be an object`);
    if (typeof entry.language !== 'string' || entry.language === '') {
      throw new StressError(`${where}: language must be a non-empty string`);
    }
    if (entry.ref !== undefined && !(typeof entry.ref === 'string' && SHA.test(entry.ref))) {
      throw new StressError(`${where}: ref must be a full 40-character commit hash`);
    }
    repos[id] = {
      ...(entry.ref === undefined ? {} : { ref: entry.ref as string }),
      language: entry.language,
      ...(entry.languages === undefined
        ? {}
        : { languages: words(entry.languages, 'languages', where) }),
      stack: words(entry.stack ?? [], 'stack', where),
      structure: oneOf(entry.structure, STRUCTURES, 'structure', where),
      complexity: oneOf(entry.complexity, COMPLEXITIES, 'complexity', where),
      era: oneOf(entry.era, ERAS, 'era', where),
      ...(typeof entry.scope === 'string' ? { scope: entry.scope } : {}),
      ...(typeof entry.notes === 'string' ? { notes: entry.notes } : {}),
      ...(isRecord(entry.github) ? { github: entry.github as unknown as GithubFacts } : {}),
    };
  }
  return { version: 1, repos };
}

/** Which repositories a run or a listing is about. Every field narrows; several values mean "any of". */
export interface Filter {
  readonly ids?: readonly string[];
  readonly language?: readonly string[];
  readonly stack?: readonly string[];
  readonly structure?: readonly string[];
  readonly complexity?: readonly string[];
  readonly era?: readonly string[];
  /** A cap the caller asks for, on how many are taken (in id order). */
  readonly limit?: number;
}

export interface Entry {
  readonly id: string;
  readonly factors: RepoFactors;
}

const anyOf = (wanted: readonly string[] | undefined, have: readonly string[]): boolean =>
  wanted === undefined || wanted.length === 0 || wanted.some((word) => have.includes(word));

export function select(manifest: Manifest, filter: Filter = {}): Entry[] {
  const chosen = Object.entries(manifest.repos)
    .filter(([id, f]) => {
      if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(id)) return false;
      return (
        anyOf(filter.language, [f.language, ...(f.languages ?? [])]) &&
        anyOf(filter.stack, f.stack) &&
        anyOf(filter.structure, [f.structure]) &&
        anyOf(filter.complexity, [f.complexity]) &&
        anyOf(filter.era, [f.era])
      );
    })
    .map(([id, factors]) => ({ id, factors }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return filter.limit === undefined ? chosen : chosen.slice(0, filter.limit);
}

/** The per-factor view of the flat map: for `language`, typescript -> [ids]. */
export function byFactor(
  manifest: Manifest,
  factor: 'language' | 'structure' | 'complexity' | 'era',
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [id, factors] of Object.entries(manifest.repos)) {
    const key = factors[factor];
    const list = groups.get(key);
    if (list) list.push(id);
    else groups.set(key, [id]);
  }
  for (const list of groups.values()) list.sort();
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/** The size class GitHub's own number suggests, before a clone can say how many files there are. */
export function complexityFromSize(sizeKb: number): Complexity {
  if (sizeKb < 5_000) return 'small';
  if (sizeKb < 60_000) return 'medium';
  if (sizeKb < 400_000) return 'large';
  return 'huge';
}
