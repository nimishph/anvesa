/**
 * Reciprocal rank fusion: how results from several ranked lists become one.
 *
 * Each list ("lane") is ranked by its own score, and scores from different lanes (cosine
 * similarity, structural match order) are not comparable. Ranks are. An item's fused score is the
 * sum over lanes of `weight / (k + rank)`, so an item near the top of several lanes beats one at
 * the top of a single lane, and no lane's scale can drown another.
 */

/** The constant from the RRF paper; it damps the advantage of the very top ranks. */
export const DEFAULT_RRF_K = 60;

export interface Lane<T> {
  readonly name: string;
  /** How much this lane counts. 1 is neutral; 0 removes it. */
  readonly weight: number;
  /** Best first. `key` says which items are the same thing across lanes. */
  readonly hits: readonly { readonly key: string; readonly item: T; readonly score?: number }[];
}

export interface Contribution {
  readonly lane: string;
  /** 1-based position in that lane. */
  readonly rank: number;
  readonly weight: number;
  /** The lane's own score, when it has one. */
  readonly score: number | undefined;
}

export interface Fused<T> {
  readonly key: string;
  readonly item: T;
  /**
   * Reciprocal rank fusion score: position across lanes, not similarity. Two unrelated queries
   * can land the same top `score` if their best hit ranks first in as many lanes — it says "this
   * beat the others in this search," never "this is a good match." Compare items within one
   * result page with it; never compare it across queries, and never read it as a confidence level.
   */
  readonly score: number;
  /**
   * The strongest real similarity any lane reported for this item (e.g. a dense channel's cosine
   * score), or `undefined` when every lane that found it only ranks (structural has no such
   * score). This is the number to check for "is this actually relevant," since `score` cannot
   * answer that.
   */
  readonly bestScore: number | undefined;
  /** Which lanes found it and where: why it ranks where it does. */
  readonly foundBy: readonly Contribution[];
}

export function fuse<T>(lanes: readonly Lane<T>[], k: number = DEFAULT_RRF_K): Fused<T>[] {
  const combined = new Map<string, { item: T; score: number; foundBy: Contribution[] }>();
  for (const lane of lanes) {
    if (lane.weight <= 0) continue;
    // A lane may find the same thing more than once (two cards of one symbol). It counts once, at
    // its best rank, or a lane full of near-duplicates would outvote the others.
    const counted = new Set<string>();
    lane.hits.forEach((hit) => {
      if (counted.has(hit.key)) return;
      counted.add(hit.key);
      const rank = counted.size;
      const entry = combined.get(hit.key) ?? { item: hit.item, score: 0, foundBy: [] };
      entry.score += lane.weight / (k + rank);
      entry.foundBy.push({ lane: lane.name, rank, weight: lane.weight, score: hit.score });
      combined.set(hit.key, entry);
    });
  }
  return [...combined.entries()]
    .map(([key, entry]) => ({ key, ...entry, bestScore: bestRawScore(entry.foundBy) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.bestScore ?? Number.NEGATIVE_INFINITY) - (a.bestScore ?? Number.NEGATIVE_INFINITY) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
}

/**
 * Rank alone cannot tell a strong top hit from a weak one: two lanes with a different number-one
 * tie. When they do, the one a lane scored higher wins, and only then the key, so order is stable.
 */
function bestRawScore(found: readonly Contribution[]): number | undefined {
  const scored = found.map((entry) => entry.score).filter((score) => score !== undefined);
  return scored.length === 0 ? undefined : Math.max(...scored);
}
