import type { Deadline } from '@sutras/code-lens-core';
import type { Card } from './card.ts';
import { DimensionMismatchError } from './errors.ts';
import type { QuarantinedCard } from './redteam/index.ts';
import { dot, normalize } from './vectors.ts';

export interface StoredCard {
  readonly card: Card;
  readonly vector: Float32Array;
}

/** Everything a source (usually one file) contributes to a channel, replaced as a unit. */
export interface SourceUpdate {
  readonly channel: string;
  readonly path: string;
  readonly model: string;
  readonly contentHash: string;
  readonly transformerVersion: string;
  readonly cards: readonly StoredCard[];
  readonly quarantined: readonly QuarantinedCard[];
}

export interface SourceState {
  readonly contentHash: string;
  readonly transformerVersion: string;
  readonly model: string;
  readonly cards: number;
  readonly quarantined: number;
}

export interface SearchOptions {
  readonly channel: string;
  readonly model: string;
  /** How many hits to return. Required: the store applies no limit of its own. */
  readonly limit: number;
  readonly filter?: (card: Card) => boolean;
  /** Keep only the best-scoring card of each `group`, so the parts of one symbol appear once. */
  readonly collapse?: boolean;
  readonly deadline?: Deadline;
}

export interface SearchHit {
  readonly card: Card;
  /** Cosine similarity, -1 to 1. */
  readonly score: number;
}

export interface ChannelStats {
  readonly channel: string;
  readonly cards: number;
  readonly sources: number;
  readonly quarantined: number;
  /** Typical number of cards per source, for the red-team flood check. 0 when empty. */
  readonly medianCardsPerSource: number;
  readonly models: readonly {
    readonly model: string;
    readonly dimensions: number;
    readonly cards: number;
  }[];
}

/**
 * Where vectors live, keyed by channel and model. The indexer supplies a SQLite implementation;
 * `MemoryVectorStore` is the reference and the one tests use.
 */
export interface VectorStore {
  replaceSource(update: SourceUpdate): Promise<void>;
  removeSource(channel: string, path: string): Promise<boolean>;
  sourceState(channel: string, path: string): Promise<SourceState | undefined>;
  /** Every source a channel holds, by path, in order. */
  sourcePaths(channel: string): Promise<readonly string[]>;
  /**
   * How many cards each source of a channel holds, smallest first. It is what a store spread over
   * several places needs to say what is typical (`ChannelStats.medianCardsPerSource`) without
   * guessing from partial answers.
   */
  cardCounts(channel: string): Promise<readonly number[]>;
  search(query: Float32Array, options: SearchOptions): Promise<readonly SearchHit[]>;
  stats(channel: string): Promise<ChannelStats>;
  quarantined(channel: string): Promise<readonly QuarantinedCard[]>;
}

interface Held {
  readonly card: Card;
  readonly unit: Float32Array;
}

interface Source {
  readonly state: SourceState;
  readonly cards: readonly Held[];
  readonly quarantined: readonly QuarantinedCard[];
}

/** An in-memory store. Search is exact: every stored vector is compared. */
export class MemoryVectorStore implements VectorStore {
  readonly #channels = new Map<string, Map<string, Source>>();
  /** channel -> model -> dimensions, fixed by the first vector stored. */
  readonly #dimensions = new Map<string, Map<string, number>>();

  async replaceSource(update: SourceUpdate): Promise<void> {
    const dims = this.#dimensions.get(update.channel) ?? new Map<string, number>();
    const first = update.cards[0]?.vector.length;
    const known = dims.get(update.model);
    for (const { vector } of update.cards) {
      const expected = known ?? first;
      if (expected !== undefined && vector.length !== expected) {
        throw new DimensionMismatchError(update.channel, update.model, expected, vector.length);
      }
    }
    if (first !== undefined && known === undefined) dims.set(update.model, first);
    this.#dimensions.set(update.channel, dims);

    const sources = this.#channels.get(update.channel) ?? new Map<string, Source>();
    sources.set(update.path, {
      state: {
        contentHash: update.contentHash,
        transformerVersion: update.transformerVersion,
        model: update.model,
        cards: update.cards.length,
        quarantined: update.quarantined.length,
      },
      cards: update.cards.map(({ card, vector }) => ({ card, unit: normalize(vector) })),
      quarantined: update.quarantined,
    });
    this.#channels.set(update.channel, sources);
  }

  async removeSource(channel: string, path: string): Promise<boolean> {
    return this.#channels.get(channel)?.delete(path) ?? false;
  }

  async sourceState(channel: string, path: string): Promise<SourceState | undefined> {
    return this.#channels.get(channel)?.get(path)?.state;
  }

  async sourcePaths(channel: string): Promise<readonly string[]> {
    return [...(this.#channels.get(channel)?.keys() ?? [])].sort();
  }

  async cardCounts(channel: string): Promise<readonly number[]> {
    return [...(this.#channels.get(channel)?.values() ?? [])]
      .map((source) => source.cards.length)
      .sort((a, b) => a - b);
  }

  async search(query: Float32Array, options: SearchOptions): Promise<readonly SearchHit[]> {
    const stored = this.#dimensions.get(options.channel)?.get(options.model);
    if (stored !== undefined && query.length !== stored) {
      throw new DimensionMismatchError(options.channel, options.model, stored, query.length);
    }
    const unit = normalize(query);
    const best = new Map<string, SearchHit>();
    let sequence = 0;
    for (const source of this.#channels.get(options.channel)?.values() ?? []) {
      if (source.state.model !== options.model) continue;
      for (const held of source.cards) {
        if (options.filter && !options.filter(held.card)) continue;
        sequence += 1;
        if (sequence % SEARCH_DEADLINE_CHECK_EVERY === 0) {
          options.deadline?.throwIfExpired('search the vector store');
        }
        const hit: SearchHit = { card: held.card, score: dot(unit, held.unit) };
        const key = options.collapse ? (held.card.attrs.group ?? held.card.id) : held.card.id;
        const current = best.get(key);
        if (!current || hit.score > current.score) best.set(key, hit);
      }
    }
    return topK([...best.values()], options.limit);
  }

  async stats(channel: string): Promise<ChannelStats> {
    const sources = [...(this.#channels.get(channel)?.values() ?? [])];
    const perModel = new Map<string, { dimensions: number; cards: number }>();
    for (const source of sources) {
      const dimensions =
        source.cards[0]?.unit.length ?? this.#dimensions.get(channel)?.get(source.state.model) ?? 0;
      const entry = perModel.get(source.state.model) ?? { dimensions, cards: 0 };
      entry.cards += source.cards.length;
      perModel.set(source.state.model, entry);
    }
    const counts = sources.map((source) => source.cards.length).sort((a, b) => a - b);
    const middle = Math.floor(counts.length / 2);
    const median =
      counts.length === 0
        ? 0
        : counts.length % 2 === 1
          ? (counts[middle] as number)
          : ((counts[middle - 1] as number) + (counts[middle] as number)) / 2;
    return {
      channel,
      cards: counts.reduce((a, b) => a + b, 0),
      sources: sources.length,
      quarantined: sources.reduce((a, s) => a + s.quarantined.length, 0),
      medianCardsPerSource: median,
      models: [...perModel.entries()].map(([model, value]) => ({ model, ...value })),
    };
  }

  async quarantined(channel: string): Promise<readonly QuarantinedCard[]> {
    return [...(this.#channels.get(channel)?.values() ?? [])].flatMap(
      (source) => source.quarantined,
    );
  }
}

/** How often a scan checks its deadline. A pacing interval, not a limit on results. */
const SEARCH_DEADLINE_CHECK_EVERY = 1024;

/** Whether `a` ranks below `b`: lower score, or on equal scores the later card id. */
function ranksBelow(a: ScoredId, b: ScoredId): boolean {
  return a.score < b.score || (a.score === b.score && a.id > b.id);
}

/** Something with a score and a stable id: all top-k selection needs to know about a hit. */
export interface ScoredId {
  readonly id: string;
  readonly score: number;
}

/**
 * Keeps the `limit` best items of a stream, best first, with ties broken by id so results are
 * reproducible. A bounded min-heap makes a scan linear in the number of items and constant in
 * memory beyond `limit`, so a store can rank millions of vectors without holding them.
 */
export class TopKCollector<T extends ScoredId> {
  readonly #limit: number;
  readonly #heap: T[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get size(): number {
    return this.#heap.length;
  }

  add(item: T): void {
    const heap = this.#heap;
    if (heap.length < this.#limit) {
      heap.push(item);
      this.#siftUp(heap.length - 1);
    } else if (heap.length > 0 && ranksBelow(heap[0] as T, item)) {
      heap[0] = item;
      this.#siftDown(0);
    }
  }

  /** The kept items, best first. The collector stays usable. */
  result(): T[] {
    return [...this.#heap].sort((a, b) => (ranksBelow(a, b) ? 1 : ranksBelow(b, a) ? -1 : 0));
  }

  #swap(i: number, j: number): void {
    const heap = this.#heap;
    [heap[i], heap[j]] = [heap[j] as T, heap[i] as T];
  }

  #siftUp(from: number): void {
    const heap = this.#heap;
    for (let i = from; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!ranksBelow(heap[i] as T, heap[parent] as T)) break;
      this.#swap(i, parent);
      i = parent;
    }
  }

  #siftDown(from: number): void {
    const heap = this.#heap;
    for (let i = from; ; ) {
      const left = 2 * i + 1;
      const right = left + 1;
      let worst = i;
      if (left < heap.length && ranksBelow(heap[left] as T, heap[worst] as T)) worst = left;
      if (right < heap.length && ranksBelow(heap[right] as T, heap[worst] as T)) worst = right;
      if (worst === i) break;
      this.#swap(i, worst);
      i = worst;
    }
  }
}

/** The `limit` best hits, best first, ties broken by card id. */
export function topK(hits: readonly SearchHit[], limit: number): SearchHit[] {
  const collector = new TopKCollector<SearchHit & ScoredId>(limit);
  for (const hit of hits) collector.add({ ...hit, id: hit.card.id });
  return collector.result().map(({ card, score }) => ({ card, score }));
}
