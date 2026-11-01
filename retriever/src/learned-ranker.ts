import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Card, cardTextFor } from '@cntxt-labs/anvesa-dense';
import { type IndexStore, StoreCorruptError, type StoreDatabase } from '@cntxt-labs/anvesa-indexer';
import { RankerError } from './errors.ts';

/**
 * How the symbols lane ranks, in two stages (anvesa-gen-lab, 2026-10-29). First, a symbol scores
 * as its best card's cosine to the query less a hub penalty, `hub` times the card's mean cosine to
 * its 10 nearest cards (cards that sit close to everything stop crowding every answer). Second, an
 * XGBoost LambdaMART ranker, the one that came with the encoder, reorders the top `depth` symbols
 * from cheap features of the query and each card. Both stages are recorded (`SearchStages`); only
 * the second's order is shown. The ranker computes every feature below, but the ones shipped leave
 * out word overlap (name, path and card matches, BM25): fit on generated queries, those features
 * hurt hand-written ones. The model names the features it reads; results are in
 * docs/learned-ranker.md.
 *
 * Everything here is a port of anvesa-gen-lab's `corpus_bench.py` (`score_repo`, `_features`) and
 * must stay equal to it: the ranker was trained on those numbers. `learned-ranker.test.ts` checks
 * this file against a fixture that Python wrote.
 */

/** How many nearest cards a card's crowding is measured over. */
export const HUB_NEIGHBOURS = 10;
export const DEFAULT_HUB = 0.3;
export const DEFAULT_DEPTH = 30;
const CHANNEL = 'symbols';
const STATE_META = 'ranking.hub';
const BM25_META = 'ranking.bm25';

// ------------------------------------------------------------------------- words and BM25

const STOP = new Set(
  'a an the to of in on for and or is are be it its this that with by from as at how do does what i my when which why where can get set'.split(
    ' ',
  ),
);

/** Lower-case words, identifiers split at their humps, stop words left out. */
export function words(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return (spaced.match(/[a-z0-9]+/g) ?? []).filter((word) => !STOP.has(word));
}

/** What BM25 needs to know about the collection: one document per symbol. */
export interface Bm25Stats {
  readonly docs: number;
  readonly avgLength: number;
  /** In how many documents each word appears. */
  readonly df: Readonly<Record<string, number>>;
}

export function bm25Stats(docs: readonly (readonly string[])[]): Bm25Stats {
  const df: Record<string, number> = {};
  let total = 0;
  for (const doc of docs) {
    total += doc.length;
    for (const word of new Set(doc)) df[word] = (df[word] ?? 0) + 1;
  }
  return { docs: docs.length, avgLength: docs.length > 0 ? total / docs.length : 1, df };
}

/** BM25 (k1 1.2, b 0.75) of one document for a query; a repeated query word counts each time. */
export function bm25(stats: Bm25Stats, query: readonly string[], doc: readonly string[]): number {
  const k1 = 1.2;
  const b = 0.75;
  const tf = new Map<string, number>();
  for (const word of doc) tf.set(word, (tf.get(word) ?? 0) + 1);
  let score = 0;
  for (const word of query) {
    const f = tf.get(word);
    if (f === undefined) continue;
    const n = stats.df[word] ?? 0;
    const idf = Math.log(1 + (stats.docs - n + 0.5) / (n + 0.5));
    score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / stats.avgLength));
  }
  return score;
}

// ------------------------------------------------------------------------- the hub penalty

/**
 * Each vector's mean cosine to its `k` nearest vectors, itself left out (the best match, which
 * for a card is itself). Vectors are unit length. Quadratic in the number of vectors: run at
 * index time, never per query.
 */
export function hubMeans(
  vectors: readonly Float32Array[],
  k: number = HUB_NEIGHBOURS,
): Float64Array {
  const n = vectors.length;
  const keep = Math.min(k + 1, n);
  // Per row, the `keep` largest similarities seen so far, ascending.
  const best = vectors.map(() => new Float64Array(keep).fill(Number.NEGATIVE_INFINITY));
  const offer = (row: Float64Array, value: number): void => {
    if (value <= (row[0] as number)) return;
    let at = 0;
    while (at + 1 < row.length && (row[at + 1] as number) < value) {
      row[at] = row[at + 1] as number;
      at += 1;
    }
    row[at] = value;
  };
  for (let i = 0; i < n; i += 1) {
    const a = vectors[i] as Float32Array;
    offer(best[i] as Float64Array, dot(a, a));
    for (let j = i + 1; j < n; j += 1) {
      const similarity = dot(a, vectors[j] as Float32Array);
      offer(best[i] as Float64Array, similarity);
      offer(best[j] as Float64Array, similarity);
    }
  }
  const means = new Float64Array(n);
  best.forEach((row, i) => {
    if (keep < 2) return;
    let sum = 0;
    for (let m = 0; m < keep - 1; m += 1) sum += row[m] as number;
    means[i] = sum / (keep - 1);
  });
  return means;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  const n = a.length;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    s0 += (a[i] as number) * (b[i] as number);
    s1 += (a[i + 1] as number) * (b[i + 1] as number);
    s2 += (a[i + 2] as number) * (b[i + 2] as number);
    s3 += (a[i + 3] as number) * (b[i + 3] as number);
  }
  for (; i < n; i += 1) s0 += (a[i] as number) * (b[i] as number);
  return s0 + s1 + s2 + s3;
}

// ------------------------------------------------------------------------- first stage

/** `a.go#Foo#2`, an overload, is the symbol `a.go#Foo`. */
export function symbolOf(group: string): string {
  return group.replace(/#\d+$/, '');
}

/** The part a card is of its symbol's card: `x#Foo~2` is the second. */
function partOf(id: string): number {
  const match = /~(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Whether card `a` comes before card `b` in a symbol: by group (overloads last), then by part. */
function before(a: { group: string; id: string }, b: { group: string; id: string }): boolean {
  if (a.group !== b.group) return a.group < b.group;
  return partOf(a.id) < partOf(b.id);
}

/** One searchable card: its vector (unit length) and how crowded it is. */
export interface VectorRow {
  readonly id: string;
  /** `path#group`, as the index keys it. */
  readonly group: string;
  readonly vector: Float32Array;
  /** Mean cosine to its nearest cards; 0 when not measured yet. */
  readonly hubMean: number;
}

/** A symbol as the first stage sees it. */
export interface SymbolScore {
  readonly symbol: string;
  /** Its best card's cosine less the hub penalty: what the first stage ranks by. */
  readonly score: number;
  /** The card that scored it, and that card's cosine. */
  readonly bestId: string;
  readonly bestCosine: number;
  /** The symbol's first card (its own group, first part): the card the features read. */
  readonly firstId: string;
  readonly firstCosine: number;
  readonly firstPenalty: number;
}

/**
 * Every symbol, best first; ties keep the order of their keys. Scores are 32-bit floats worked as
 * numpy works them (`cos - hub * mean`, each step rounded), so the ranker sees the numbers it was
 * trained on; only the dot product itself can differ from numpy's in its last bit.
 */
export function scoreSymbols(
  rows: readonly VectorRow[],
  query: Float32Array,
  hub: number,
): SymbolScore[] {
  const f = Math.fround;
  const weight = f(hub);
  const symbols = new Map<
    string,
    { score: number; bestId: string; bestCosine: number; first: VectorRow; firstCosine: number }
  >();
  for (const row of rows) {
    const cosine = f(dot(query, row.vector));
    const score = f(cosine - f(weight * f(row.hubMean)));
    const symbol = symbolOf(row.group);
    const held = symbols.get(symbol);
    if (!held) {
      symbols.set(symbol, {
        score,
        bestId: row.id,
        bestCosine: cosine,
        first: row,
        firstCosine: cosine,
      });
      continue;
    }
    if (score > held.score) {
      held.score = score;
      held.bestId = row.id;
      held.bestCosine = cosine;
    }
    if (before(row, held.first)) {
      held.first = row;
      held.firstCosine = cosine;
    }
  }
  return [...symbols.entries()]
    .map(([symbol, held]) => ({
      symbol,
      score: held.score,
      bestId: held.bestId,
      bestCosine: held.bestCosine,
      firstId: held.first.id,
      firstCosine: held.firstCosine,
      firstPenalty: f(weight * f(held.first.hubMean)),
    }))
    .sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

// ------------------------------------------------------------------------- features

const KINDS = [
  'function',
  'method',
  'type',
  'class',
  'interface',
  'variable',
  'constant',
  'field',
  'module',
  'enum',
];

/** A candidate the ranker reads: its first-stage numbers and its first card. */
export interface Candidate {
  readonly symbol: string;
  readonly score: number;
  readonly firstCosine: number;
  readonly firstPenalty: number;
  /** The first card, as indexed (with its WQL path line when the index has one). */
  readonly card: Pick<Card, 'text' | 'attrs' | 'source'>;
}

/** Every feature anvesa computes, by name, for the top candidates of one query (best first). */
export function rankerFeatures(
  query: string,
  top: readonly Candidate[],
  stats: Bm25Stats,
): Record<string, number>[] {
  const qw = words(query);
  const qset = new Set(qw);
  const overlap = (other: Set<string>): number => {
    let n = 0;
    for (const word of qset) if (other.has(word)) n += 1;
    return n;
  };
  const fileOf = (symbol: string): string => symbol.split('#')[0] as string;
  const files = new Map<string, number>();
  for (const candidate of top) {
    const file = fileOf(candidate.symbol);
    files.set(file, (files.get(file) ?? 0) + 1);
  }
  const lowered = query.toLowerCase();
  const head = top[0]?.score ?? 0;
  return top.map((candidate, rank) => {
    const { card } = candidate;
    const name = card.attrs.symbol ?? '';
    const file = card.source.path;
    const nameWords = new Set(words(name));
    const pathWords = new Set(words(file));
    const cardWords = new Set(words(card.text));
    const kind = card.attrs.kind ?? '';
    const features: Record<string, number> = {
      rank,
      fused: candidate.score,
      fused_gap: Math.fround(head - candidate.score),
      card_cos: candidate.firstCosine,
      hub_pen: candidate.firstPenalty,
      bm25_card: bm25(stats, qw, words(cardTextFor(card.text, 'nopath'))),
      name_hit: overlap(nameWords) / Math.max(qset.size, 1),
      name_cover: overlap(nameWords) / Math.max(nameWords.size, 1),
      path_hit: overlap(pathWords) / Math.max(qset.size, 1),
      card_hit: overlap(cardWords) / Math.max(qset.size, 1),
      names_symbol: nameWords.size > 0 && lowered.includes(name.toLowerCase()) ? 1 : 0,
      has_doc: card.attrs.hasDoc === 'true' ? 1 : 0,
      card_len: [...card.text].length,
      depth: file.split('/').length - 1,
      same_file: (files.get(fileOf(candidate.symbol)) ?? 1) - 1,
      q_len: qw.length,
    };
    for (const k of KINDS) features[`kind_${k}`] = kind === k ? 1 : 0;
    return features;
  });
}

// ------------------------------------------------------------------------- the trees

interface Tree {
  readonly left: Int32Array;
  readonly right: Int32Array;
  readonly feature: Int32Array;
  /** Split thresholds, and leaf values at the leaves. */
  readonly value: Float32Array;
  readonly defaultLeft: Uint8Array;
}

/**
 * An XGBoost tree ensemble read from its JSON model file (`Booster.save_model('x.json')`) and run
 * in plain TypeScript, as XGBoost's CPU predictor does: features as 32-bit floats, `x < threshold`
 * goes left, leaves summed in 32-bit floats onto the base score.
 */
export class TreeRanker {
  readonly features: readonly string[];
  readonly #trees: readonly Tree[];
  readonly #base: number;

  private constructor(features: readonly string[], trees: readonly Tree[], base: number) {
    this.features = features;
    this.#trees = trees;
    this.#base = base;
  }

  static parse(text: string, source: string): TreeRanker {
    const bad = (problem: string): never => {
      throw new RankerError(source, problem);
    };
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return bad('is not JSON (save the model with XGBoost `save_model("ranker.json")`)');
    }
    const learner = json.learner as Record<string, unknown> | undefined;
    const booster = learner?.gradient_booster as Record<string, unknown> | undefined;
    if (!learner || !booster) return bad('is not an XGBoost JSON model');
    if (booster.name !== 'gbtree') bad(`is a ${String(booster.name)} model; only gbtree is run`);
    const names = learner.feature_names;
    if (!Array.isArray(names) || names.length === 0) {
      bad('names no features: fit it on a DataFrame or set feature_names before saving');
    }
    const features = names as string[];
    const known = new Set(Object.keys(rankerFeatures('q', [SAMPLE], bm25Stats([]))[0] ?? {}));
    const unknown = features.filter((name) => !known.has(name));
    if (unknown.length > 0) bad(`wants features anvesa does not compute: ${unknown.join(', ')}`);
    const params = learner.learner_model_param as Record<string, unknown> | undefined;
    const base = Number(String(params?.base_score ?? '0').replace(/[[\]]/g, ''));
    if (!Number.isFinite(base)) bad('has a base score that is not a number');
    const model = booster.model as { trees?: Record<string, unknown>[] } | undefined;
    const trees = (model?.trees ?? []).map((tree, index): Tree => {
      const types = (tree.split_type as number[] | undefined) ?? [];
      if (types.some((type) => type !== 0)) bad(`tree ${index} has categorical splits`);
      const left = Int32Array.from(tree.left_children as number[]);
      const right = Int32Array.from(tree.right_children as number[]);
      const feature = Int32Array.from(tree.split_indices as number[]);
      const value = Float32Array.from(tree.split_conditions as number[]);
      const defaultLeft = Uint8Array.from(tree.default_left as number[]);
      const n = left.length;
      if ([right, feature, value, defaultLeft].some((array) => array.length !== n) || n === 0) {
        bad(`tree ${index} is malformed`);
      }
      for (let node = 0; node < n; node += 1) {
        if ((left[node] as number) !== -1 && (feature[node] as number) >= features.length) {
          bad(`tree ${index} splits on feature ${feature[node]}, which it does not name`);
        }
      }
      return { left, right, feature, value, defaultLeft };
    });
    if (trees.length === 0) bad('has no trees');
    return new TreeRanker(features, trees, base);
  }

  /** The ranker's score for each row of features (named as `rankerFeatures` names them). */
  score(rows: readonly Record<string, number>[]): Float32Array {
    const out = new Float32Array(rows.length);
    const x = new Float32Array(this.features.length);
    rows.forEach((row, r) => {
      this.features.forEach((name, i) => {
        x[i] = row[name] ?? Number.NaN;
      });
      let sum = Math.fround(this.#base);
      for (const tree of this.#trees) {
        let node = 0;
        while ((tree.left[node] as number) !== -1) {
          const v = x[tree.feature[node] as number] as number;
          const goLeft = Number.isNaN(v)
            ? tree.defaultLeft[node] === 1
            : v < (tree.value[node] as number);
          node = (goLeft ? tree.left[node] : tree.right[node]) as number;
        }
        sum = Math.fround(sum + (tree.value[node] as number));
      }
      out[r] = sum;
    });
    return out;
  }
}

/** A candidate with every feature defined, to read the feature names from. */
const SAMPLE: Candidate = {
  symbol: 'a#b',
  score: 0,
  firstCosine: 0,
  firstPenalty: 0,
  card: { text: 'b', attrs: {}, source: { path: 'a', contentHash: '' } },
};

/** Reorder `top` by the ranker's scores, best first; equal scores keep the first stage's order. */
export function rerank<T>(top: readonly T[], scores: Float32Array): T[] {
  return top
    .map((item, index) => ({ item, index, score: scores[index] as number }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

export async function loadTreeRanker(file: string): Promise<TreeRanker> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (failure) {
    throw new RankerError(file, 'it cannot be read', { cause: failure });
  }
  return TreeRanker.parse(text, file);
}

// ------------------------------------------------------------------------- the index

interface CardRow {
  id: string;
  group_key: string;
  card: string;
}

/** What bringing the hub means up to date measured, and what it cost. */
export interface HubReport {
  /** Symbol cards whose hub mean was measured, over every model. */
  readonly cards: number;
  /** Symbols BM25's statistics were taken over. */
  readonly symbols: number;
  /** Time spent on the hub means alone: quadratic in the cards of each model. */
  readonly hubMs: number;
  /** Time for the whole update: reading cards and vectors, the hub means, BM25, writing. */
  readonly totalMs: number;
}

/**
 * Bring the ranker's index-time numbers up to date: every symbol card's hub mean (per model), and
 * BM25's collection statistics over each symbol's first card. Recomputed only when the symbol
 * cards changed since the last run; `undefined` when nothing had to be.
 */
export async function syncHubMeans(
  store: IndexStore,
  database: StoreDatabase,
): Promise<HubReport | undefined> {
  const started = performance.now();
  const previous = await store.getMeta(STATE_META);

  // The symbol cards as they are now: their sources, and how propagation (which rewrites searched
  // vectors without touching a source) is set.
  const propagate = (await store.getMeta('experimental.propagate')) ?? '';
  const { fingerprint, complete } = database.guard('read symbol sources', (db) => {
    const hash = createHash('sha256');
    for (const row of db
      .query(
        `SELECT path, model, content_hash, transformer_version FROM vector_sources
          WHERE channel = ? ORDER BY path`,
      )
      .all(CHANNEL) as Record<string, string>[]) {
      hash.update(`${row.path}\0${row.model}\0${row.content_hash}\0${row.transformer_version}\n`);
    }
    hash.update(propagate);
    const count = (table: string): number =>
      (
        db.query(`SELECT count(*) AS n FROM ${table} WHERE channel = ?`).get(CHANNEL) as {
          n: number;
        }
      ).n;
    // A card rewritten since (by a watcher, say) lost its hub row with its old self.
    return {
      fingerprint: hash.digest('hex'),
      complete: count('card_hub') === count('card_vectors'),
    };
  });
  if (previous === fingerprint && complete) return undefined;

  const cards = database.guard('read symbol cards', (db) =>
    db.query('SELECT id, group_key, card FROM cards WHERE channel = ?').all(CHANNEL),
  ) as CardRow[];
  const first = new Map<string, CardRow>();
  for (const row of cards) {
    const symbol = symbolOf(row.group_key);
    const held = first.get(symbol);
    if (
      !held ||
      before({ group: row.group_key, id: row.id }, { group: held.group_key, id: held.id })
    ) {
      first.set(symbol, row);
    }
  }
  const stats = bm25Stats(
    [...first.values()].map((row) =>
      words(cardTextFor((JSON.parse(row.card) as Card).text, 'nopath')),
    ),
  );

  const byModel = new Map<string, { id: string; vector: Float32Array }[]>();
  database.guard('read symbol vectors', (db) => {
    for (const row of db
      .query('SELECT id, model, vector FROM card_vectors WHERE channel = ?')
      .iterate(CHANNEL) as Iterable<{ id: string; model: string; vector: Uint8Array }>) {
      const list = byModel.get(row.model) ?? [];
      list.push({ id: row.id, vector: floats(row.vector) });
      byModel.set(row.model, list);
    }
  });
  let measured = 0;
  const means = new Map<string, number>();
  const hubStarted = performance.now();
  for (const list of byModel.values()) {
    const found = hubMeans(list.map((entry) => entry.vector));
    list.forEach((entry, index) => {
      means.set(entry.id, found[index] as number);
    });
    measured += list.length;
  }
  const hubMs = performance.now() - hubStarted;
  database.transaction('store hub means', (db) => {
    db.query('DELETE FROM card_hub WHERE channel = ?').run(CHANNEL);
    const insert = db.query('INSERT INTO card_hub (channel, id, mean) VALUES (?, ?, ?)');
    for (const [id, mean] of means) insert.run(CHANNEL, id, mean);
  });
  await store.setMeta(BM25_META, JSON.stringify(stats));
  await store.setMeta(STATE_META, fingerprint);
  return { cards: measured, symbols: stats.docs, hubMs, totalMs: performance.now() - started };
}

function floats(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// ------------------------------------------------------------------------- search

export interface RankedHit {
  readonly card: Card;
  /** The cosine of the card shown: the similarity a reader can judge, not the rank. */
  readonly score: number;
}

/** One stage of a symbol search: the symbols it ranked, in its order, and how long it took. */
export interface SearchStage {
  readonly symbols: readonly { readonly symbol: string; readonly score: number }[];
  readonly ms: number;
}

/**
 * Both stages of one symbol search, for telemetry and evaluation: what the first stage alone would
 * have shown, and what the ranker made of it. Never shown to the user.
 */
export interface SearchStages {
  /** Cosine less the hub penalty: its top `depth`, the candidates the ranker saw. */
  readonly first: SearchStage;
  /** The ranker's order of those candidates. Absent when there was no ranker to run. */
  readonly ranked?: SearchStage;
}

/**
 * Symbols for a query, best first: the hub-penalised first stage over every symbol card, its top
 * `depth` reordered by the ranker when there is one. At most `limit` are returned, with both
 * stages as they were.
 */
export function rankSymbols(options: {
  readonly database: StoreDatabase;
  readonly model: string;
  readonly query: string;
  readonly vector: Float32Array;
  readonly limit: number;
  readonly hub: number;
  readonly depth: number;
  readonly ranker: TreeRanker | undefined;
  readonly stats: Bm25Stats | undefined;
  readonly include?: (path: string) => boolean;
}): { readonly hits: RankedHit[]; readonly stages: SearchStages } {
  const { database, hub, depth } = options;
  const firstStarted = performance.now();
  const query = unit(options.vector);
  const rows = database.guard('read symbol vectors', (db) => {
    const out: VectorRow[] = [];
    for (const row of db
      .query(
        `SELECT v.id, v.group_key, v.vector, c.path, h.mean
           FROM card_vectors v
           JOIN cards c ON c.channel = v.channel AND c.id = v.id
           LEFT JOIN card_hub h ON h.channel = v.channel AND h.id = v.id
          WHERE v.channel = ? AND v.model = ?`,
      )
      .iterate(CHANNEL, options.model) as Iterable<{
      id: string;
      group_key: string;
      vector: Uint8Array;
      path: string;
      mean: number | null;
    }>) {
      if (options.include && !options.include(row.path)) continue;
      out.push({
        id: row.id,
        group: row.group_key,
        vector: floats(row.vector),
        hubMean: row.mean ?? 0,
      });
    }
    return out;
  });
  const order = scoreSymbols(rows, query, hub);
  const first: SearchStage = {
    symbols: order.slice(0, depth).map(({ symbol, score }) => ({ symbol, score })),
    ms: performance.now() - firstStarted,
  };
  const cardOf = (id: string): Card =>
    database.guard('read a card', (db) => {
      const row = db
        .query('SELECT card FROM cards WHERE channel = ? AND id = ?')
        .get(CHANNEL, id) as { card: string } | null;
      if (!row) throw new StoreCorruptError('cards', id, 'the card vanished during a search');
      return JSON.parse(row.card) as Card;
    });

  let ranked = order;
  let second: SearchStage | undefined;
  if (options.ranker && options.stats && order.length > 1) {
    const rankStarted = performance.now();
    const top = order.slice(0, depth);
    const features = rankerFeatures(
      options.query,
      top.map((symbol) => ({ ...symbol, card: cardOf(symbol.firstId) })),
      options.stats,
    );
    const scores = options.ranker.score(features);
    const reordered = rerank(
      top.map((symbol, index) => ({ symbol, score: scores[index] as number })),
      scores,
    );
    ranked = [...reordered.map((entry) => entry.symbol), ...order.slice(depth)];
    second = {
      symbols: reordered.map((entry) => ({ symbol: entry.symbol.symbol, score: entry.score })),
      ms: performance.now() - rankStarted,
    };
  }
  return {
    hits: ranked.slice(0, options.limit).map((symbol) => ({
      card: cardOf(symbol.bestId),
      score: symbol.bestCosine,
    })),
    stages: second ? { first, ranked: second } : { first },
  };
}

/**
 * What ranking did, told to `RetrieverOptions.onRanking` as it happens: the hub means an index run
 * brought up to date, or both stages of a symbol search. Local and complete (it names symbols and
 * carries the query); what may leave the machine is `summarizeStages` of it.
 */
export type RankingEvent =
  | { readonly kind: 'index'; readonly hub: HubReport }
  | {
      readonly kind: 'search';
      readonly query: string;
      readonly model: string;
      readonly stages: SearchStages;
    };

/**
 * What telemetry may carry of a search's stages: how much the ranker moved, and how long each
 * stage took. No symbol, path or query: only ranks, counts and times.
 */
export interface StagesSummary {
  /** Candidates the first stage handed on. */
  readonly candidates: number;
  /** Whether the ranker ran. */
  readonly reranked: boolean;
  /** Whether the result shown first differs from the first stage's first. */
  readonly topChanged: boolean;
  /** Where the result shown first stood in the first stage (0 is first). */
  readonly shownTopFirstRank: number | undefined;
  /** Share of the first stage's top 10 that is also in the top 10 shown. */
  readonly overlapAt10: number;
  readonly firstMs: number;
  readonly rankedMs: number | undefined;
}

export function summarizeStages(stages: SearchStages): StagesSummary {
  const first = stages.first.symbols.map((entry) => entry.symbol);
  const shown = (stages.ranked ?? stages.first).symbols.map((entry) => entry.symbol);
  // biome-ignore lint/plugin: the top 10 is what overlap@10 is defined over, not a cap on results
  const head = new Set(first.slice(0, 10));
  // biome-ignore lint/plugin: as above, the metric's own window
  const kept = shown.slice(0, 10).filter((symbol) => head.has(symbol)).length;
  const top = shown[0];
  return {
    candidates: first.length,
    reranked: stages.ranked !== undefined,
    topChanged: top !== first[0],
    shownTopFirstRank: top === undefined ? undefined : first.indexOf(top),
    overlapAt10: head.size > 0 ? kept / head.size : 1,
    firstMs: stages.first.ms,
    rankedMs: stages.ranked?.ms,
  };
}

/** BM25 statistics stored at index time, or undefined before the first index with the ranker. */
export async function storedBm25(store: IndexStore): Promise<Bm25Stats | undefined> {
  const raw = await store.getMeta(BM25_META);
  return raw === undefined ? undefined : (JSON.parse(raw) as Bm25Stats);
}

function unit(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
}
