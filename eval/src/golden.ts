import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { CodeLensError, InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { Retriever } from '@cntxt-labs/anvesa-retriever';

/**
 * Golden-query regression suites. One folder per language under `eval/golden/`:
 *
 *   eval/golden/<language>/corpus/...     a small program in that language
 *   eval/golden/<language>/queries.json   questions about it, with the answers that are right
 *
 * The corpus is indexed from nothing (structure only, no model) and every query is asked through
 * the same `Retriever` the CLI uses. An answer is a set: a query passes when it returns exactly the
 * expected items, so a result that appears or disappears is a failure either way. Because the
 * answers are written by hand from the corpus, a change that makes the call graph or an outline
 * less accurate turns a query red before it ships.
 */

/** One question and its answer. Exactly one of `wql`, `callers`, `callees`, `dependents`. */
export interface GoldenQuery {
  readonly id: string;
  readonly why?: string;
  /** A WQL query. Items are `path:name`. */
  readonly wql?: string;
  /** Who calls this symbol (name, id or `path:line`). Items are the calling symbol's id. */
  readonly callers?: string;
  /** What this symbol calls. Items are the called symbol's id, or `external:<to>` / `unresolved:<name>`. */
  readonly callees?: string;
  /** Files that import this path. Items are paths. */
  readonly dependents?: string;
  /** Exactly these items, in any order. */
  readonly expect: readonly string[];
  /** For `callers`: how far each caller may be trusted, by item. Any item not listed is not checked. */
  readonly confidence?: Readonly<Record<string, 'exact' | 'inferred' | 'guess'>>;
}

export interface GoldenSuite {
  readonly language: string;
  readonly directory: string;
  readonly queries: readonly GoldenQuery[];
}

export interface GoldenOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly wrongConfidence: readonly string[];
}

export type GoldenResult =
  | {
      readonly language: string;
      readonly state: 'ran';
      readonly outcomes: readonly GoldenOutcome[];
    }
  | { readonly language: string; readonly state: 'skipped'; readonly reason: string };

/** A suite could not run for a reason that is not a wrong answer: a grammar that is not installed. */
export class GoldenSetupError extends CodeLensError {
  readonly code = 'EVAL_GOLDEN_SETUP';
  readonly subsystem = 'retriever' as const;
}

export const GOLDEN_ROOT = join(import.meta.dir, '..', 'golden');

/** Every suite under `eval/golden/`, by language. */
export function loadSuites(root = GOLDEN_ROOT): GoldenSuite[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadSuite(join(root, entry.name), entry.name))
    .sort((a, b) => a.language.localeCompare(b.language));
}

export function loadSuite(directory: string, language: string): GoldenSuite {
  const path = join(directory, 'queries.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (failure) {
    throw new InvalidArgumentError('golden suite', `a readable ${path}`, path, { cause: failure });
  }
  const queries = (raw as { queries?: unknown }).queries;
  if (!Array.isArray(queries)) {
    throw new InvalidArgumentError('golden suite', `${path} with a "queries" array`, raw);
  }
  const seen = new Set<string>();
  for (const query of queries as GoldenQuery[]) {
    const kinds = ['wql', 'callers', 'callees', 'dependents'].filter(
      (kind) => (query as unknown as Record<string, unknown>)[kind] !== undefined,
    );
    if (typeof query.id !== 'string' || kinds.length !== 1 || !Array.isArray(query.expect)) {
      throw new InvalidArgumentError(
        'golden query',
        'an id, one of wql/callers/callees/dependents, and an expect list',
        query,
        { context: { path } },
      );
    }
    if (seen.has(query.id)) {
      throw new InvalidArgumentError('golden query id', 'unique within a suite', query.id);
    }
    seen.add(query.id);
  }
  return { language, directory, queries: queries as GoldenQuery[] };
}

/** Where installed grammars may be: the checkout's own `.anvesa/grammars`, an override, the user's. */
function grammarDirectories(): string[] {
  const extra = process.env.ANVESA_GOLDEN_GRAMMARS;
  return [
    ...(extra ? extra.split(/[;:]/).filter(Boolean) : []),
    join(import.meta.dir, '..', '..', '.anvesa', 'grammars'),
    join(process.env.ANVESA_HOME ?? join(homedir(), '.anvesa'), 'grammars'),
  ].filter((directory) => existsSync(directory));
}

/**
 * Index a suite's corpus in a scratch copy and answer every query. `'skipped'` when the language's
 * grammar is not installed and `requireAll` is off; with it on, that is an error, so a release
 * cannot pass by quietly not testing a language.
 */
export async function runSuite(
  suite: GoldenSuite,
  options: { readonly requireAll?: boolean } = {},
): Promise<GoldenResult> {
  const scratch = mkdtempSync(join(tmpdir(), `anvesa-golden-${suite.language}-`));
  try {
    cpSync(join(suite.directory, 'corpus'), scratch, { recursive: true });
    const grammars = join(scratch, '.anvesa', 'grammars');
    mkdirSync(grammars, { recursive: true });
    for (const directory of grammarDirectories()) {
      for (const name of readdirSync(directory)) {
        if (name.endsWith('.wasm') && !existsSync(join(grammars, name))) {
          cpSync(join(directory, name), join(grammars, name));
        }
      }
    }

    const retriever = await Retriever.open({
      root: scratch,
      grammars: { npmFrom: import.meta.filename },
    });
    try {
      const { report } = await retriever.index();
      const unreadable = report.quarantined.filter((q) => /No grammar available/i.test(q.message));
      if (unreadable.length > 0) {
        const reason = `the ${suite.language} grammar is not installed (${unreadable.length} files could not be read)`;
        if (options.requireAll) throw new GoldenSetupError(reason);
        return { language: suite.language, state: 'skipped', reason };
      }
      const outcomes: GoldenOutcome[] = [];
      for (const query of suite.queries) outcomes.push(await answer(retriever, query));
      return { language: suite.language, state: 'ran', outcomes };
    } finally {
      await retriever.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

interface Found {
  readonly items: readonly string[];
  readonly confidence: ReadonlyMap<string, string>;
}

async function ask(retriever: Retriever, query: GoldenQuery): Promise<Found> {
  const confidence = new Map<string, string>();
  const all = { limit: 10_000 };
  if (query.wql !== undefined) {
    const page = await retriever.query(query.wql, all);
    return {
      items: page.items.map((hit) => `${hit.path ?? ''}:${hit.name ?? ''}`),
      confidence,
    };
  }
  if (query.callers !== undefined) {
    const { callers } = await retriever.callers(query.callers, all);
    for (const caller of callers.items) confidence.set(caller.from, caller.confidence);
    return { items: callers.items.map((caller) => caller.from), confidence };
  }
  if (query.callees !== undefined) {
    const { callees } = await retriever.callees(query.callees, all);
    return {
      items: callees.items.map((callee) =>
        callee.kind === 'external' || callee.kind === 'unresolved'
          ? `${callee.kind}:${callee.to}`
          : callee.to,
      ),
      confidence,
    };
  }
  const dependents = await retriever.dependents(query.dependents as string, { depth: 1 });
  return { items: dependents.dependents.map((dependent) => dependent.path), confidence };
}

async function answer(retriever: Retriever, query: GoldenQuery): Promise<GoldenOutcome> {
  const found = await ask(retriever, query);
  const got = new Set(found.items);
  const want = new Set(query.expect);
  const missing = [...want].filter((item) => !got.has(item)).sort();
  const unexpected = [...got].filter((item) => !want.has(item)).sort();
  const wrongConfidence = Object.entries(query.confidence ?? {})
    .filter(([item, expected]) => found.confidence.get(item) !== expected)
    .map(
      ([item, expected]) =>
        `${item}: expected ${expected}, got ${found.confidence.get(item) ?? 'none'}`,
    )
    .sort();
  return {
    id: query.id,
    passed: missing.length === 0 && unexpected.length === 0 && wrongConfidence.length === 0,
    missing,
    unexpected,
    wrongConfidence,
  };
}

export function renderGolden(results: readonly GoldenResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    if (result.state === 'skipped') {
      lines.push(`${result.language}: SKIPPED, ${result.reason}`);
      continue;
    }
    const failed = result.outcomes.filter((outcome) => !outcome.passed);
    lines.push(
      `${result.language}: ${result.outcomes.length - failed.length}/${result.outcomes.length} queries`,
    );
    for (const outcome of failed) {
      lines.push(`  FAIL ${outcome.id}`);
      for (const item of outcome.missing) lines.push(`    missing     ${item}`);
      for (const item of outcome.unexpected) lines.push(`    unexpected  ${item}`);
      for (const item of outcome.wrongConfidence) lines.push(`    confidence  ${item}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A suite's directory relative to the eval package, for messages. */
export const suiteName = (suite: GoldenSuite): string =>
  relative(dirname(GOLDEN_ROOT), suite.directory);
