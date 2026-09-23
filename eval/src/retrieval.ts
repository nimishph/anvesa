import type { SymbolFact } from '@cntxt-labs/anvesa-indexer';

/**
 * How a query is phrased, which decides which lane can be expected to find it:
 * - `identifier`: the words of a symbol's name, as someone who remembers the name loosely would type.
 * - `intent`: what the symbol does, from its documentation, with the words of its own name taken out
 *   so the query is not the name in disguise.
 * - `doc`: a sentence from the first paragraph of a documentation file, which that file answers.
 * - `exact-name`: a WQL query for a definition by kind and name (`[@declaration]` leaves out mentions), which the structural lane answers.
 */
export type Population = 'identifier' | 'intent' | 'exact-name' | 'doc';

export interface EvalQuery {
  readonly population: Population;
  readonly text: string;
  /** Files that count as a correct answer. */
  readonly relevant: ReadonlySet<string>;
  /** The symbol the query was made from. */
  readonly symbol: string;
}

/** Split `parseHTTPConfig`, `parse_config` and `ParseConfig` into lower-case words. */
export function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/** The first sentence of a doc comment, without comment markers or tags. */
export function firstSentence(doc: string): string {
  const cleaned = doc
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#)\s?/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('@'))
    .join(' ');
  const end = cleaned.search(/[.!?](\s|$)/);
  return (end === -1 ? cleaned : cleaned.slice(0, end)).trim();
}

export interface QueryOptions {
  /** Fewest words a query must have to be asked. Shorter ones are too vague to have one answer. */
  readonly minWords: number;
  /** Ask at most this many queries of each population, spread evenly over the eligible symbols. */
  readonly perPopulation?: number;
}

export const DEFAULT_QUERY_OPTIONS: QueryOptions = { minWords: 3 };

/** Spread `count` picks evenly over `items`; all of them when `count` is undefined or enough. */
export function spread<T>(items: readonly T[], count: number | undefined): T[] {
  if (count === undefined || count >= items.length) return [...items];
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const item = items[Math.floor((i * items.length) / count)];
    if (item !== undefined) picked.push(item);
  }
  return picked;
}

const isTest = (path: string): boolean =>
  /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$/.test(path);

/**
 * Queries derived from what the index holds, so the set grows with the repository and needs no
 * hand-written list. Every query is answered by a file, and a name several files define counts all
 * of them as correct:
 * - identifier and exact-name queries use one exported symbol per name of two or more words;
 * - intent queries use documented symbols, and the answer is the file that defines them.
 */
export function generateQueries(
  symbols: Iterable<SymbolFact>,
  options: QueryOptions = DEFAULT_QUERY_OPTIONS,
  documents: readonly { readonly path: string; readonly content: string }[] = [],
): EvalQuery[] {
  const byName = new Map<string, Set<string>>();
  const eligible: SymbolFact[] = [];
  for (const symbol of symbols) {
    if (isTest(symbol.path)) continue;
    const files = byName.get(symbol.baseName) ?? new Set<string>();
    files.add(symbol.path);
    byName.set(symbol.baseName, files);
    eligible.push(symbol);
  }

  const identifiers = new Map<string, SymbolFact>();
  const documented: SymbolFact[] = [];
  for (const symbol of eligible) {
    if (
      symbol.exported &&
      words(symbol.baseName).length >= 2 &&
      !identifiers.has(symbol.baseName)
    ) {
      identifiers.set(symbol.baseName, symbol);
    }
    if (symbol.doc) documented.push(symbol);
  }

  const queries: EvalQuery[] = [];
  const named = spread([...identifiers.values()], options.perPopulation);
  for (const symbol of named) {
    const relevant = byName.get(symbol.baseName) ?? new Set([symbol.path]);
    const text = words(symbol.baseName).join(' ');
    queries.push({ population: 'identifier', text, relevant, symbol: symbol.id });
    queries.push({
      population: 'exact-name',
      text: `//${symbol.kind}[@name="${symbol.baseName}"][@declaration]`,
      relevant,
      symbol: symbol.id,
    });
  }

  const intent: EvalQuery[] = [];
  for (const symbol of documented) {
    const own = new Set(words(symbol.baseName));
    const text = words(firstSentence(symbol.doc ?? ''))
      .filter((word) => !own.has(word))
      .join(' ');
    if (text.split(' ').length >= Math.max(options.minWords, 5)) {
      intent.push({
        population: 'intent',
        text,
        relevant: new Set([symbol.path]),
        symbol: symbol.id,
      });
    }
  }
  queries.push(...spread(intent, options.perPopulation));
  queries.push(...spread(documentQueries(documents, options.minWords), options.perPopulation));
  return queries;
}

/** The 1-based rank of the first relevant file among the files a search returned, in order. */
export function rankOf(
  returned: readonly string[],
  relevant: ReadonlySet<string>,
): number | undefined {
  const seen = new Set<string>();
  let rank = 0;
  for (const path of returned) {
    if (seen.has(path)) continue;
    seen.add(path);
    rank += 1;
    if (relevant.has(path)) return rank;
  }
  return undefined;
}

export interface Score {
  readonly queries: number;
  /** Fraction of queries whose answer was within the top k, by k. */
  readonly recall: ReadonlyMap<number, number>;
  /** Mean of 1/rank over the queries, 0 for a miss. */
  readonly mrr: number;
  readonly misses: number;
}

/** Score ranks (`undefined` = not found) at each cutoff. */
export function score(ranks: readonly (number | undefined)[], cutoffs: readonly number[]): Score {
  const recall = new Map<number, number>();
  for (const k of cutoffs) {
    const hit = ranks.filter((rank) => rank !== undefined && rank <= k).length;
    recall.set(k, ranks.length === 0 ? 0 : hit / ranks.length);
  }
  const mrr = ranks.reduce<number>((sum, rank) => sum + (rank === undefined ? 0 : 1 / rank), 0);
  return {
    queries: ranks.length,
    recall,
    mrr: ranks.length === 0 ? 0 : mrr / ranks.length,
    misses: ranks.filter((rank) => rank === undefined).length,
  };
}

/** The value at fraction `p` (0..1) of `values`, by nearest rank. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** The first sentence of the first paragraph of a document, if it is long enough to be a question. */
export function documentQueries(
  documents: readonly { readonly path: string; readonly content: string }[],
  minWords: number,
): EvalQuery[] {
  const queries: EvalQuery[] = [];
  for (const { path, content } of documents) {
    if (isTest(path)) continue;
    const paragraph = content
      .split(/\r?\n\s*\r?\n/)
      .map((block) => block.trim())
      .find(
        (block) =>
          block !== '' &&
          !block.startsWith('#') &&
          !block.startsWith('```') &&
          !block.startsWith('|') &&
          !block.startsWith('<'),
      );
    if (!paragraph) continue;
    const text = firstSentence(paragraph.replace(/\s+/g, ' ').replace(/[`*_>[\]()]/g, ''));
    if (text.split(' ').length >= Math.max(minWords, 6)) {
      queries.push({ population: 'doc', text, relevant: new Set([path]), symbol: path });
    }
  }
  return queries;
}
