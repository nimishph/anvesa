#!/usr/bin/env bun
/**
 * Stress-test anvesa on real open-source repositories.
 *
 *   bun run stress list [--by language] [filters]      what is in the manifest
 *   bun run stress add owner/name [--stack a,b ...]    put a repository in it (facts from GitHub)
 *   bun run stress refresh [--repin] [--prune]         re-read GitHub's facts; pin commits
 *   bun run stress discover --language go ...          find candidates by parameters
 *   bun run stress setup                               install the grammars the manifest needs
 *   bun run stress run [filters] [--no-dense ...]      clone, index, ask, record, compare
 *   bun run stress compare [--window 3]                the latest execution against those before it
 *                                                      (--fail-on-regression: exit 1 on a regression or a failed run;
 *                                                       also accepted by `run`; `add --if-missing` keeps an existing pin)
 *   bun run stress runs                                what has been recorded
 *
 * Filters: --id --language --stack --structure --complexity --era --limit (comma-separated lists).
 * Everything lives in ANVESA_STRESS_HOME (default ~/.anvesa/stress): never in a repository.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { blocksRelease, compare, DEFAULT_TOLERANCES, renderComparison } from './compare.ts';
import { ghApi, spawnText } from './git.ts';
import { readManifest, readRuns, stressHome, writeManifest, writeRun } from './home.ts';
import {
  byFactor,
  COMPLEXITIES,
  complexityFromSize,
  type Entry,
  ERAS,
  type Era,
  type Filter,
  type GithubFacts,
  type Manifest,
  type RepoFactors,
  STRUCTURES,
  StressError,
  select,
} from './manifest.ts';
import { runStress } from './measure.ts';
import { resolveProgram } from './program.ts';
import { dayOf, short } from './text.ts';

const OPTIONS = {
  id: { type: 'string' },
  language: { type: 'string' },
  stack: { type: 'string' },
  structure: { type: 'string' },
  complexity: { type: 'string' },
  era: { type: 'string' },
  limit: { type: 'string' },
  by: { type: 'string' },
  json: { type: 'boolean' },
  scope: { type: 'string' },
  notes: { type: 'string' },
  ref: { type: 'string' },
  'no-pin': { type: 'boolean' },
  'if-missing': { type: 'boolean' },
  'fail-on-regression': { type: 'boolean' },
  repin: { type: 'boolean' },
  prune: { type: 'boolean' },
  stars: { type: 'string' },
  size: { type: 'string' },
  topic: { type: 'string' },
  'created-after': { type: 'string' },
  'pushed-after': { type: 'string' },
  add: { type: 'boolean' },
  program: { type: 'string' },
  'no-dense': { type: 'boolean' },
  queries: { type: 'string' },
  seed: { type: 'string' },
  keep: { type: 'boolean' },
  'timeout-min': { type: 'string' },
  since: { type: 'string' },
  window: { type: 'string' },
  tolerance: { type: 'string' },
  download: { type: 'boolean' },
} as const;

const list = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);

function number(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new StressError(`--${name} must be a non-negative number, not "${value}"`);
  }
  return parsed;
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new StressError(`--${name} must be one of ${allowed.join(', ')}, not "${value}"`);
  }
  return value as T;
}

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values'];

function filterOf(values: Values): Filter {
  return {
    ...(values.id ? { ids: list(values.id) as string[] } : {}),
    ...(values.language ? { language: list(values.language) as string[] } : {}),
    ...(values.stack ? { stack: list(values.stack) as string[] } : {}),
    ...(values.structure ? { structure: list(values.structure) as string[] } : {}),
    ...(values.complexity ? { complexity: list(values.complexity) as string[] } : {}),
    ...(values.era ? { era: list(values.era) as string[] } : {}),
    ...(values.limit ? { limit: number(values.limit, 'limit', 0) } : {}),
  };
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  'c++': 'cpp',
  'c#': 'csharp',
  vue: 'vue',
};
const languageOf = (githubName: string | null | undefined): string =>
  LANGUAGE_NAMES[(githubName ?? 'unknown').toLowerCase()] ??
  (githubName ?? 'unknown').toLowerCase();

interface GithubRepo {
  readonly full_name: string;
  readonly language: string | null;
  readonly stargazers_count: number;
  readonly size: number;
  readonly created_at: string;
  readonly pushed_at: string;
  readonly default_branch: string;
  readonly archived: boolean;
  readonly fork?: boolean;
}

const factsOf = (repo: GithubRepo): GithubFacts => ({
  stars: repo.stargazers_count,
  sizeKb: repo.size,
  createdAt: repo.created_at,
  pushedAt: repo.pushed_at,
  defaultBranch: repo.default_branch,
  archived: repo.archived,
  checkedAt: new Date().toISOString(),
});

/** The commit at the tip of a repository's default branch. */
async function tipOf(id: string, branch: string): Promise<string> {
  return (await ghApi<{ sha: string }>(`repos/${id}/commits/${branch}`)).sha;
}

/** A guess from the year a repository started, for `discover` and `add`; runs check it against history. */
function eraFromCreation(createdAt: string): Era {
  const year = new Date(createdAt).getUTCFullYear();
  if (year <= 2017) return 'legacy';
  return year >= 2024 ? 'ai-era' : 'modern';
}

async function add(manifest: Manifest, id: string, values: Values): Promise<Manifest> {
  // A release run keeps the pinned commit it recorded, so its numbers stay comparable.
  if (
    values['if-missing'] &&
    Object.keys(manifest.repos).some((known) => known.toLowerCase() === id.toLowerCase())
  ) {
    return manifest;
  }
  const repo = await ghApi<GithubRepo>(`repos/${id}`);
  const facts = factsOf(repo);
  const ref = values.ref || (values['no-pin'] ? undefined : await tipOf(id, repo.default_branch));
  const entry: RepoFactors = {
    ...(ref ? { ref } : {}),
    language: values.language || languageOf(repo.language),
    stack: list(values.stack) ?? [],
    structure: oneOf(values.structure, STRUCTURES, 'structure') ?? 'single',
    complexity:
      oneOf(values.complexity, COMPLEXITIES, 'complexity') ?? complexityFromSize(repo.size),
    era: oneOf(values.era, ERAS, 'era') ?? eraFromCreation(repo.created_at),
    ...(values.scope ? { scope: values.scope } : {}),
    ...(values.notes ? { notes: values.notes } : {}),
    github: facts,
  };
  return { version: 1, repos: { ...manifest.repos, [repo.full_name]: entry } };
}

async function refresh(
  manifest: Manifest,
  entries: readonly Entry[],
  values: Values,
): Promise<Manifest> {
  const repos = { ...manifest.repos };
  for (const { id, factors } of entries) {
    try {
      const repo = await ghApi<GithubRepo>(`repos/${id}`);
      const pin =
        factors.ref === undefined || values.repin
          ? await tipOf(id, repo.default_branch)
          : factors.ref;
      repos[id] = { ...factors, ref: pin, github: factsOf(repo) };
      const moved = factors.ref !== undefined && factors.ref !== pin;
      process.stdout.write(
        `${id}: ok${moved ? ` (repinned ${factors.ref ? short(factors.ref) : 'none'} -> ${short(pin)})` : ''}\n`,
      );
    } catch (failure) {
      if (!(failure instanceof StressError)) throw failure;
      process.stdout.write(`${id}: ${failure.message.split('\n')[0]}\n`);
      if (values.prune) delete repos[id];
    }
  }
  return { version: 1, repos };
}

async function discover(values: Values, manifest: Manifest): Promise<Manifest> {
  const parts: string[] = ['fork:false', 'archived:false'];
  if (values.language) parts.push(`language:${values.language}`);
  parts.push(`stars:${values.stars ?? '100..20000'}`);
  if (values.size) parts.push(`size:${values.size}`);
  if (values.topic) parts.push(`topic:${values.topic}`);
  if (values['created-after']) parts.push(`created:>=${values['created-after']}`);
  if (values['pushed-after']) parts.push(`pushed:>=${values['pushed-after']}`);
  const perPage = number(values.limit, 'limit', 20);
  const found = await ghApi<{ items: GithubRepo[] }>(
    `search/repositories?q=${encodeURIComponent(parts.join(' '))}&sort=stars&per_page=${perPage}`,
  );
  let next = manifest;
  for (const repo of found.items) {
    const known = repo.full_name in manifest.repos;
    process.stdout.write(
      `${known ? '=' : '+'} ${repo.full_name.padEnd(40)} ${languageOf(repo.language).padEnd(11)} ${String(repo.stargazers_count).padStart(6)} stars  ${(repo.size / 1024).toFixed(0).padStart(5)} MB  created ${new Date(repo.created_at).getUTCFullYear()}\n`,
    );
    if (values.add && !known)
      next = await add(next, repo.full_name, { ...values, language: '', ref: '' });
  }
  return next;
}

/** wasm names by language, for the grammars this checkout has installed for its own tests. */
const GRAMMAR_FILES: Readonly<Record<string, readonly [string, string]>> = {
  python: ['tree-sitter-python', 'tree-sitter-python.wasm'],
  go: ['tree-sitter-go', 'tree-sitter-go.wasm'],
  rust: ['tree-sitter-rust', 'tree-sitter-rust.wasm'],
  java: ['tree-sitter-java', 'tree-sitter-java.wasm'],
  c: ['tree-sitter-c', 'tree-sitter-c.wasm'],
  cpp: ['tree-sitter-cpp', 'tree-sitter-cpp.wasm'],
  ruby: ['tree-sitter-ruby', 'tree-sitter-ruby.wasm'],
  csharp: ['tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm'],
  css: ['tree-sitter-css', 'tree-sitter-css.wasm'],
  php: ['tree-sitter-php', 'tree-sitter-php.wasm'],
};

function findGrammar(language: string): string | undefined {
  const named = GRAMMAR_FILES[language];
  if (!named) return undefined;
  const store = resolve(import.meta.dir, '..', '..', 'node_modules', '.bun');
  if (!existsSync(store)) return undefined;
  const [pkg, file] = named;
  for (const folder of readdirSync(store)
    .filter((name) => name.startsWith(`${pkg}@`))
    .sort()
    .reverse()) {
    const path = join(store, folder, 'node_modules', pkg, file);
    if (existsSync(path)) return path;
  }
  return undefined;
}

async function setup(entries: readonly Entry[], values: Values): Promise<void> {
  const program = await resolveProgram(values.program);
  const listing = await spawnText([program.path, 'grammar', 'list', '--json']);
  const grammars = JSON.parse(listing.stdout) as { language: string; state: string }[];
  const missing = new Set(grammars.filter((g) => g.state !== 'ready').map((g) => g.language));
  const needed = new Set(
    entries.flatMap((e) => [e.factors.language, ...(e.factors.languages ?? [])]),
  );
  for (const language of [...needed].sort()) {
    if (!missing.has(language)) continue;
    const wasm = findGrammar(language);
    const args = wasm
      ? ['grammar', 'install', language, '--user', '--from', wasm]
      : values.download
        ? ['grammar', 'install', language, '--user', '--download']
        : undefined;
    if (!args) {
      process.stdout.write(
        `${language}: no grammar here to install (try --download); its files will be quarantined\n`,
      );
      continue;
    }
    const ran = await spawnText([program.path, ...args]);
    process.stdout.write(
      `${language}: ${ran.code === 0 ? 'installed' : `failed: ${ran.stderr.trim()}`}\n`,
    );
  }
}

function table(entries: readonly Entry[]): string {
  const rows = entries.map(({ id, factors: f }) =>
    [
      id,
      f.language,
      f.structure,
      f.complexity,
      f.era,
      f.stack.join(','),
      f.ref ? short(f.ref) : 'unpinned',
    ].join('\t'),
  );
  return `${['id', 'language', 'structure', 'complexity', 'era', 'stack', 'pin'].join('\t')}\n${rows.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;
  const home = stressHome();
  const manifest = readManifest(home);
  const entries = select(manifest, filterOf(values));

  switch (command) {
    case 'list': {
      if (values.by) {
        const factor = oneOf(
          values.by,
          ['language', 'structure', 'complexity', 'era'] as const,
          'by',
        ) as 'language' | 'structure' | 'complexity' | 'era';
        for (const [key, ids] of byFactor(manifest, factor))
          process.stdout.write(`${key} (${ids.length}): ${ids.join(', ')}\n`);
      } else if (values.json) {
        process.stdout.write(
          `${JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, e.factors])), null, 2)}\n`,
        );
      } else {
        process.stdout.write(table(entries));
      }
      return;
    }
    case 'add': {
      let next = manifest;
      for (const id of rest) next = await add(next, id, values);
      writeManifest(home, next);
      process.stdout.write(
        `manifest: ${Object.keys(next.repos).length} repositories (${home.manifest})\n`,
      );
      return;
    }
    case 'refresh': {
      writeManifest(home, await refresh(manifest, entries, values));
      return;
    }
    case 'discover': {
      const next = await discover(values, manifest);
      if (values.add) writeManifest(home, next);
      return;
    }
    case 'setup': {
      await setup(entries, values);
      return;
    }
    case 'run': {
      if (entries.length === 0) throw new StressError('No repository matches; see `stress list`.');
      const program = await resolveProgram(values.program);
      const yearAgo = dayOf(new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString());
      const record = await runStress(entries, {
        program,
        reposRoot: home.repos,
        dense: !values['no-dense'],
        queries: number(values.queries, 'queries', 8),
        seed: number(values.seed, 'seed', 1),
        fresh: !values.keep,
        ...(values['timeout-min']
          ? { timeoutMs: number(values['timeout-min'], 'timeout-min', 0) * 60_000 }
          : {}),
        since: values.since ?? yearAgo,
        onProgress: (message) => process.stderr.write(`${message}\n`),
      });
      const path = writeRun(home, record);
      process.stdout.write(`recorded ${path}\n\n`);
      const window = number(values.window, 'window', 3);
      const runs = readRuns(home);
      const comparisons = compare(runs, { window, ids: entries.map((e) => e.id) });
      process.stdout.write(renderComparison(comparisons, runs, window));
      if (values['fail-on-regression'] && blocksRelease(comparisons)) process.exitCode = 1;
      return;
    }
    case 'compare': {
      const window = number(values.window, 'window', 3);
      const runs = readRuns(home);
      const tolerances = {
        ...DEFAULT_TOLERANCES,
        relative: number(values.tolerance, 'tolerance', DEFAULT_TOLERANCES.relative),
      };
      const comparisons = compare(runs, {
        window,
        tolerances,
        ...(values.id || values.language ? { ids: entries.map((e) => e.id) } : {}),
      });
      process.stdout.write(
        values.json
          ? `${JSON.stringify(comparisons, null, 2)}\n`
          : renderComparison(comparisons, runs, window),
      );
      if (values['fail-on-regression'] && blocksRelease(comparisons)) process.exitCode = 1;
      return;
    }
    case 'runs': {
      for (const run of readRuns(home)) {
        const failed = run.results.filter((r) => r.outcome === 'failed').length;
        process.stdout.write(
          `${run.id}  anvesa ${run.program.version} ${short(run.program.sha256)}  ${run.results.length} repos, ${failed} failed\n`,
        );
      }
      return;
    }
    default:
      process.stdout.write(
        `${(await Bun.file(import.meta.filename).text()).split('*/')[0]?.replace(/^#!.*\n/, '')}*/\n`,
      );
  }
}

try {
  await main();
} catch (failure) {
  if (failure instanceof StressError) {
    process.stderr.write(
      `error: ${failure.message}\n${failure.hint ? `hint: ${failure.hint}\n` : ''}`,
    );
    process.exitCode = 1;
  } else {
    throw failure;
  }
}
