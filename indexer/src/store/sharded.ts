import {
  InvalidArgumentError,
  type Page,
  type PageRequest,
  resolveLimit,
} from '@cntxt-labs/code-lens-core';
import {
  type ChannelStats,
  DimensionMismatchError,
  type QuarantinedCard,
  type SearchHit,
  type SearchOptions,
  type SourceState,
  type SourceUpdate,
  TopKCollector,
  type VectorStore,
} from '@cntxt-labs/code-lens-dense';
import type { FileFacts, SymbolFact } from '../extract/index.ts';
import type { FragmentAssigner } from '../fragments/manifest.ts';
import { comparePaths } from './memory-index-store.ts';
import type {
  CallQuery,
  CallRecord,
  CorpusQuery,
  EdgeQuery,
  EdgeRecord,
  FileListQuery,
  FileQuarantine,
  FileState,
  ImportQuery,
  ImportRecord,
  IndexedFile,
  IndexStats,
  IndexStore,
  StoredCorpusRecord,
  SymbolQuery,
} from './types.ts';

/** Where the shards of one kind are, and how to open one. */
export interface ShardProvider<T> {
  /** The shards that hold something, by id, in order. Fan-out reads visit exactly these. */
  existing(): readonly string[];
  /** The shard for an id, opened (and created) if need be. */
  get(id: string): T;
}

// --- reading one ordered sequence out of many ------------------------------------------------

interface ShardCursor {
  /** The shard's own cursor for the page that was being read, or `null` for its first page. */
  readonly after: string | null;
  /** How many items of that page have been handed out already. */
  readonly skip: number;
}

interface FanCursor {
  readonly v: 1;
  /** Page size each shard is asked for. Fixed for the life of a cursor. */
  readonly size: number;
  readonly shards: Readonly<Record<string, ShardCursor | 'done'>>;
}

const encode = (cursor: FanCursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decode(text: string): FanCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch (failure) {
    throw new InvalidArgumentError('cursor', 'a token from a previous page', text, {
      cause: failure,
    });
  }
  const candidate = parsed as Partial<FanCursor> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    candidate.v !== 1 ||
    typeof candidate.size !== 'number' ||
    typeof candidate.shards !== 'object' ||
    candidate.shards === null
  ) {
    throw new InvalidArgumentError('cursor', 'a token from a previous page', text);
  }
  return candidate as FanCursor;
}

/**
 * One page of a query that every shard can answer, in the order the shards themselves keep
 * (`compare` says how two items from different shards rank). Each shard is read a page at a time
 * and the smallest head is taken until `limit` items are out. The cursor records, for each shard,
 * which of its pages was being read and how far into it, so the next call picks up exactly where
 * this one stopped: nothing is skipped or repeated, however many pages there are.
 */
async function mergedPage<T>(
  shards: readonly {
    readonly id: string;
    readonly store: (request: PageRequest) => Promise<Page<T>>;
  }[],
  compare: (a: T, b: T) => number,
  request: PageRequest,
): Promise<Page<T>> {
  const { value: limit, source } = resolveLimit('limit', request.limit);
  const resumed = request.cursor === undefined ? undefined : decode(request.cursor);
  // A shard's page is refetched to be resumed, so it must be fetched the same size every time.
  const size = resumed?.size ?? limit;

  interface Reading {
    readonly id: string;
    readonly ask: (request: PageRequest) => Promise<Page<T>>;
    after: string | null;
    buffer: readonly T[];
    /** Items of `buffer` already handed out. */
    taken: number;
    next: string | null;
    done: boolean;
    total: number | null;
  }
  const readings: Reading[] = [];
  let total: number | null = 0;
  for (const shard of shards) {
    const state = resumed?.shards[shard.id];
    const reading: Reading = {
      id: shard.id,
      ask: shard.store,
      after: state && state !== 'done' ? state.after : null,
      buffer: [],
      taken: 0,
      next: null,
      done: state === 'done',
      total: null,
    };
    if (!reading.done) {
      const page = await shard.store({
        limit: size,
        ...(reading.after === null ? {} : { cursor: reading.after }),
      });
      reading.buffer = page.items;
      reading.taken = state && state !== 'done' ? state.skip : 0;
      reading.next = page.nextCursor;
      reading.total = page.total;
    } else {
      // A finished shard still counts towards the total, which needs its first page.
      reading.total = (await shard.store({ limit: 1 })).total;
    }
    total = total === null || reading.total === null ? null : total + reading.total;
    readings.push(reading);
  }

  const items: T[] = [];
  const head = (reading: Reading): T | undefined => reading.buffer[reading.taken];
  while (items.length < limit) {
    let best: Reading | undefined;
    for (const reading of readings) {
      if (reading.done) continue;
      if (head(reading) === undefined) {
        if (reading.next === null) {
          reading.done = true;
          continue;
        }
        const page = await reading.ask({ limit: size, cursor: reading.next });
        reading.after = reading.next;
        reading.buffer = page.items;
        reading.taken = 0;
        reading.next = page.nextCursor;
        if (head(reading) === undefined) {
          reading.done = reading.next === null;
          continue;
        }
      }
      if (best === undefined || compare(head(reading) as T, head(best) as T) < 0) best = reading;
    }
    if (best === undefined) break;
    items.push(head(best) as T);
    best.taken += 1;
  }

  const shardsLeft: Record<string, ShardCursor | 'done'> = {};
  let more = false;
  for (const reading of readings) {
    const exhausted = reading.done || (head(reading) === undefined && reading.next === null);
    shardsLeft[reading.id] = exhausted ? 'done' : { after: reading.after, skip: reading.taken };
    if (!exhausted) more = true;
  }
  return {
    items,
    total,
    nextCursor: more ? encode({ v: 1, size, shards: shardsLeft }) : null,
    limit: { name: 'limit', applied: limit, source, reached: more },
  };
}

/** A query without the paging that belongs to the caller: each shard is paged by the merge itself. */
function unpaged<Q extends PageRequest>(query: Q): Omit<Q, 'cursor' | 'limit'> {
  const { cursor: _cursor, limit: _limit, ...rest } = query;
  return rest;
}

/** The path a graph node belongs to: a file is its own path; a symbol id is `path#name`. */
export function sourcePathOf(node: string): string {
  const hash = node.indexOf('#', node.lastIndexOf('/') + 1);
  return hash === -1 ? node : node.slice(0, hash);
}

// --- the index --------------------------------------------------------------------------------

export interface ShardedIndexOptions {
  readonly assigner: FragmentAssigner;
  readonly shards: ShardProvider<IndexStore>;
  /** Holds what belongs to no file: the run's own bookkeeping. */
  readonly meta: IndexStore;
}

/**
 * An `IndexStore` spread over one store per fragment. A write goes to the fragment the manifest
 * puts the file in; a read that names a file goes there too; anything else asks every fragment and
 * merges the answers in the order a single store would have given them. Callers cannot tell the
 * difference, which is what the store contract checks.
 */
export class ShardedIndexStore implements IndexStore {
  readonly #assigner: FragmentAssigner;
  readonly #shards: ShardProvider<IndexStore>;
  readonly #meta: IndexStore;

  constructor(options: ShardedIndexOptions) {
    this.#assigner = options.assigner;
    this.#shards = options.shards;
    this.#meta = options.meta;
  }

  #of(path: string): IndexStore {
    return this.#shards.get(this.#assigner.assign(path));
  }

  #each(): readonly { readonly id: string; readonly store: IndexStore }[] {
    return this.#shards.existing().map((id) => ({ id, store: this.#shards.get(id) }));
  }

  /** The routed shard's answer, or, when it has none, whatever another shard holds. */
  async #find<T>(
    path: string,
    ask: (store: IndexStore) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    const routed = this.#assigner.assign(path);
    const direct = await ask(this.#shards.get(routed));
    if (direct !== undefined) return direct;
    for (const { id, store } of this.#each()) {
      if (id === routed) continue;
      const found = await ask(store);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  fileState(path: string): Promise<FileState | undefined> {
    return this.#find(path, (store) => store.fileState(path));
  }

  files(query: FileListQuery = {}): Promise<Page<FileState>> {
    return mergedPage(
      this.#each().map(({ id, store }) => ({
        id,
        store: (request) => store.files({ ...unpaged(query), ...request }),
      })),
      (a, b) => comparePaths(a.path, b.path),
      query,
    );
  }

  replaceFile(file: IndexedFile): Promise<void> {
    return this.#of(file.path).replaceFile(file);
  }

  quarantineFile(entry: FileQuarantine): Promise<void> {
    return this.#of(entry.path).quarantineFile(entry);
  }

  touchFile(path: string, size: number, mtimeMs: number): Promise<boolean> {
    return this.#of(path).touchFile(path, size, mtimeMs);
  }

  async removeFile(path: string): Promise<boolean> {
    // A file may sit in a shard the manifest no longer sends it to; removing it must find it there.
    let removed = false;
    for (const { store } of this.#each()) removed = (await store.removeFile(path)) || removed;
    return removed;
  }

  quarantinedFiles(request: PageRequest = {}): Promise<Page<FileQuarantine>> {
    return mergedPage(
      this.#each().map(({ id, store }) => ({
        id,
        store: (page) => store.quarantinedFiles({ ...unpaged(request), ...page }),
      })),
      (a, b) => comparePaths(a.path, b.path),
      request,
    );
  }

  facts(path: string): Promise<FileFacts | undefined> {
    return this.#find(path, (store) => store.facts(path));
  }

  wexpr(path: string, formatVersion: number): Promise<string | undefined> {
    return this.#find(path, (store) => store.wexpr(path, formatVersion));
  }

  symbol(id: string): Promise<SymbolFact | undefined> {
    return this.#find(sourcePathOf(id), (store) => store.symbol(id));
  }

  findSymbols(query: SymbolQuery = {}): Promise<Page<SymbolFact>> {
    if (query.path !== undefined) return this.#of(query.path).findSymbols(query);
    return mergedPage(
      this.#each().map(({ id, store }) => ({
        id,
        store: (page) => store.findSymbols({ ...unpaged(query), ...page }),
      })),
      (a, b) => comparePaths(a.path, b.path),
      query,
    );
  }

  findCalls(query: CallQuery = {}): Promise<Page<CallRecord>> {
    if (query.path !== undefined) return this.#of(query.path).findCalls(query);
    return mergedPage(
      this.#each().map(({ id, store }) => ({
        id,
        store: (page) => store.findCalls({ ...unpaged(query), ...page }),
      })),
      (a, b) => comparePaths(a.path, b.path),
      query,
    );
  }

  findImports(query: ImportQuery = {}): Promise<Page<ImportRecord>> {
    if (query.path !== undefined) return this.#of(query.path).findImports(query);
    return mergedPage(
      this.#each().map(({ id, store }) => ({
        id,
        store: (page) => store.findImports({ ...unpaged(query), ...page }),
      })),
      (a, b) => comparePaths(a.path, b.path),
      query,
    );
  }

  replaceEdges(sourcePath: string, edges: readonly EdgeRecord[]): Promise<void> {
    return this.#of(sourcePath).replaceEdges(sourcePath, edges);
  }

  findEdges(query: EdgeQuery = {}): Promise<Page<EdgeRecord>> {
    if (query.from !== undefined) return this.#of(sourcePathOf(query.from)).findEdges(query);
    return mergedPage(
      this.#each().map(({ id, store }) => ({
        id,
        store: (page) => store.findEdges({ ...unpaged(query), ...page }),
      })),
      (a, b) => comparePaths(sourcePathOf(a.from), sourcePathOf(b.from)),
      query,
    );
  }

  async putCorpusRecords(records: readonly StoredCorpusRecord[]): Promise<void> {
    const byShard = new Map<IndexStore, StoredCorpusRecord[]>();
    for (const record of records) {
      const target = this.#of(record.path);
      const list = byShard.get(target);
      if (list) list.push(record);
      else byShard.set(target, [record]);
    }
    await Promise.all([...byShard.entries()].map(([store, list]) => store.putCorpusRecords(list)));
  }

  findCorpusRecords(query: CorpusQuery = {}): Promise<Page<StoredCorpusRecord>> {
    if (query.path) return this.#of(query.path).findCorpusRecords(query);
    return mergedPage(
      this.#each().map(({ id, store }) => ({
        id,
        store: (page) => store.findCorpusRecords({ ...unpaged(query), ...page }),
      })),
      (a: StoredCorpusRecord, b: StoredCorpusRecord) => a.id.localeCompare(b.id),
      query,
    );
  }

  async corpusPaths(corpus: string): Promise<readonly string[]> {
    const lists = await Promise.all(this.#each().map(({ store }) => store.corpusPaths(corpus)));
    const merged = new Set<string>();
    for (const list of lists) {
      for (const p of list) merged.add(p);
    }
    return [...merged].sort((a, b) => a.localeCompare(b));
  }

  getMeta(key: string): Promise<string | undefined> {
    return this.#meta.getMeta(key);
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.#meta.setMeta(key, value);
  }

  deleteMeta(key: string): Promise<boolean> {
    return this.#meta.deleteMeta(key);
  }

  async stats(): Promise<IndexStats> {
    const total = { files: 0, quarantinedFiles: 0, symbols: 0, calls: 0, imports: 0, edges: 0 };
    const languages = new Map<string, number>();
    for (const { store } of this.#each()) {
      const stats = await store.stats();
      total.files += stats.files;
      total.quarantinedFiles += stats.quarantinedFiles;
      total.symbols += stats.symbols;
      total.calls += stats.calls;
      total.imports += stats.imports;
      total.edges += stats.edges;
      for (const { language, files } of stats.byLanguage) {
        languages.set(language, (languages.get(language) ?? 0) + files);
      }
    }
    return {
      ...total,
      byLanguage: [...languages]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([language, files]) => ({ language, files })),
    };
  }

  async close(): Promise<void> {
    for (const { store } of this.#each()) await store.close();
    await this.#meta.close();
  }
}

// --- the vectors ------------------------------------------------------------------------------

export interface ShardedVectorOptions {
  readonly assigner: FragmentAssigner;
  readonly shards: ShardProvider<VectorStore>;
}

/**
 * A `VectorStore` spread over one store per fragment, on the same footing as the index: a source
 * is kept in the fragment of its path (virtual paths, such as a digest record, fall to the
 * fallback fragment), and a search asks every fragment for its best and keeps the best of those.
 */
export class ShardedVectorStore implements VectorStore {
  readonly #assigner: FragmentAssigner;
  readonly #shards: ShardProvider<VectorStore>;

  constructor(options: ShardedVectorOptions) {
    this.#assigner = options.assigner;
    this.#shards = options.shards;
  }

  /** Vector size of each channel and model, fixed by the first vector stored, whichever shard held it. */
  readonly #dimensions = new Map<string, number>();

  #of(path: string): VectorStore {
    return this.#shards.get(this.#assigner.assign(path));
  }

  #each(): readonly { readonly id: string; readonly store: VectorStore }[] {
    return this.#shards.existing().map((id) => ({ id, store: this.#shards.get(id) }));
  }

  /** What size vectors a channel and model already hold, asking the shards once and remembering. */
  async #dimensionsOf(channel: string, model: string): Promise<number | undefined> {
    const key = `${channel} ${model}`;
    const known = this.#dimensions.get(key);
    if (known !== undefined) return known;
    for (const { store } of this.#each()) {
      const held = (await store.stats(channel)).models.find((entry) => entry.model === model);
      if (held && held.dimensions > 0) {
        this.#dimensions.set(key, held.dimensions);
        return held.dimensions;
      }
    }
    return undefined;
  }

  async replaceSource(update: SourceUpdate): Promise<void> {
    // One shard cannot see what the others hold, so the size a channel's vectors must have is
    // checked here, before anything is written.
    const first = update.cards[0]?.vector.length;
    if (first !== undefined) {
      const expected = await this.#dimensionsOf(update.channel, update.model);
      for (const { vector } of update.cards) {
        if (expected !== undefined && vector.length !== expected) {
          throw new DimensionMismatchError(update.channel, update.model, expected, vector.length);
        }
      }
      await this.#of(update.path).replaceSource(update);
      this.#dimensions.set(`${update.channel} ${update.model}`, expected ?? first);
      return;
    }
    await this.#of(update.path).replaceSource(update);
  }

  async removeSource(channel: string, path: string): Promise<boolean> {
    let removed = false;
    for (const { store } of this.#each())
      removed = (await store.removeSource(channel, path)) || removed;
    return removed;
  }

  async sourceState(channel: string, path: string): Promise<SourceState | undefined> {
    const routed = this.#assigner.assign(path);
    return (await this.#shards.get(routed).sourceState(channel, path)) ?? undefined;
  }

  async sourcePaths(channel: string): Promise<readonly string[]> {
    const all = new Set<string>();
    for (const { store } of this.#each())
      for (const path of await store.sourcePaths(channel)) all.add(path);
    return [...all].sort();
  }

  async cardCounts(channel: string): Promise<readonly number[]> {
    const counts: number[] = [];
    for (const { store } of this.#each()) counts.push(...(await store.cardCounts(channel)));
    return counts.sort((a, b) => a - b);
  }

  async search(query: Float32Array, options: SearchOptions): Promise<readonly SearchHit[]> {
    const stored = await this.#dimensionsOf(options.channel, options.model);
    if (stored !== undefined && query.length !== stored) {
      throw new DimensionMismatchError(options.channel, options.model, stored, query.length);
    }
    // A group (the parts of one symbol) lives in one source, so each shard collapses its own.
    const best = new TopKCollector<SearchHit & { id: string }>(options.limit);
    for (const { store } of this.#each()) {
      for (const hit of await store.search(query, options)) best.add({ ...hit, id: hit.card.id });
    }
    return best.result().map(({ id: _id, ...hit }) => hit);
  }

  async stats(channel: string): Promise<ChannelStats> {
    const counts = await this.cardCounts(channel);
    const middle = Math.floor(counts.length / 2);
    const median =
      counts.length === 0
        ? 0
        : counts.length % 2 === 1
          ? (counts[middle] as number)
          : ((counts[middle - 1] as number) + (counts[middle] as number)) / 2;
    const models = new Map<string, { dimensions: number; cards: number }>();
    let quarantined = 0;
    for (const { store } of this.#each()) {
      const stats = await store.stats(channel);
      quarantined += stats.quarantined;
      for (const model of stats.models) {
        const held = models.get(model.model) ?? { dimensions: model.dimensions, cards: 0 };
        held.cards += model.cards;
        if (held.dimensions === 0) held.dimensions = model.dimensions;
        models.set(model.model, held);
      }
    }
    return {
      channel,
      cards: counts.reduce((sum, n) => sum + n, 0),
      sources: counts.length,
      quarantined,
      medianCardsPerSource: median,
      models: [...models]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([model, held]) => ({ model, ...held })),
    };
  }

  async quarantined(channel: string): Promise<readonly QuarantinedCard[]> {
    const found: QuarantinedCard[] = [];
    for (const { store } of this.#each()) found.push(...(await store.quarantined(channel)));
    return found;
  }

  /** The sources of a channel that sit in a shard other than the one the manifest sends them to. */
  async misplaced(
    channel: string,
  ): Promise<readonly { path: string; in: string; belongsIn: string }[]> {
    const found: { path: string; in: string; belongsIn: string }[] = [];
    for (const { id, store } of this.#each()) {
      for (const path of await store.sourcePaths(channel)) {
        const belongsIn = this.#assigner.assign(path);
        if (belongsIn !== id) found.push({ path, in: id, belongsIn });
      }
    }
    return found;
  }

  /** Drop the sources `misplaced` reports, so they are embedded afresh where they belong. */
  async evictMisplaced(channel: string): Promise<number> {
    let evicted = 0;
    for (const { id, store } of this.#each()) {
      for (const path of await store.sourcePaths(channel)) {
        if (this.#assigner.assign(path) !== id && (await store.removeSource(channel, path)))
          evicted += 1;
      }
    }
    return evicted;
  }
}
