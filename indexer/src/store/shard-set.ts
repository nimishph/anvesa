import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { VectorStore } from '@sutras/code-lens-dense';
import { ShardError } from '../errors.ts';
import { FragmentAssigner, type FragmentManifest, manifestText } from '../fragments/manifest.ts';
import { ShardedIndexStore, ShardedVectorStore, type ShardProvider } from './sharded.ts';
import { SqliteIndexStore } from './sqlite-index-store.ts';
import { SqliteVectorStore } from './sqlite-vector-store.ts';
import type { FileState, IndexStore } from './types.ts';

const META_SHARD = '_meta';
const MANIFEST_META_KEY = 'shards.manifest';

/** Something in a shard that the manifest sends elsewhere. */
export interface Misplaced {
  readonly path: string;
  readonly in: string;
  readonly belongsIn: string;
}

export interface ShardSummary {
  readonly id: string;
  readonly files: number;
  readonly quarantinedFiles: number;
  readonly symbols: number;
}

export interface DriftReport {
  /** The manifest differs from the one the shards were last settled against. */
  readonly manifestChanged: boolean;
  /** Indexed files whose shard is not the one the manifest names. */
  readonly misplacedFiles: readonly Misplaced[];
  /** Embedded sources (per channel) in the wrong shard. */
  readonly misplacedSources: readonly (Misplaced & { readonly channel: string })[];
  /** Shard databases on disk that no fragment of the manifest owns. */
  readonly orphanShards: readonly string[];
  readonly shards: readonly ShardSummary[];
}

export interface ShardSetOptions {
  /** The folder the shard databases live in. */
  readonly directory: string;
  readonly manifest: FragmentManifest;
}

/**
 * The stores of a sharded index: one database per fragment of a manifest, and the index and vector
 * views over them. The manifest is the whole truth about where a file lives, so a manifest that
 * changes leaves files in shards it no longer names; `drift` says which, and `settle` moves them by
 * forgetting them where they are, so the next run indexes them where they belong.
 */
export class ShardSet {
  readonly assigner: FragmentAssigner;
  readonly index: ShardedIndexStore;
  readonly vectors: ShardedVectorStore;
  readonly #directory: string;
  readonly #manifest: FragmentManifest;
  readonly #open = new Map<string, { index: SqliteIndexStore; vectors: SqliteVectorStore }>();
  readonly #meta: SqliteIndexStore;

  private constructor(options: ShardSetOptions, meta: SqliteIndexStore) {
    this.#directory = options.directory;
    this.#manifest = options.manifest;
    this.assigner = new FragmentAssigner(options.manifest);
    this.#meta = meta;
    const ids = () => this.#existing();
    const open = (id: string) => this.#shard(id);
    const indexShards: ShardProvider<IndexStore> = {
      existing: ids,
      get: (id) => open(id).index,
    };
    const vectorShards: ShardProvider<VectorStore> = {
      existing: ids,
      get: (id) => open(id).vectors,
    };
    this.index = new ShardedIndexStore({ assigner: this.assigner, shards: indexShards, meta });
    this.vectors = new ShardedVectorStore({ assigner: this.assigner, shards: vectorShards });
  }

  static async open(options: ShardSetOptions): Promise<ShardSet> {
    await mkdir(options.directory, { recursive: true });
    return new ShardSet(
      options,
      SqliteIndexStore.open(join(options.directory, `${META_SHARD}.db`)),
    );
  }

  #path(id: string): string {
    return join(this.#directory, `${id}.db`);
  }

  #shard(id: string): { index: SqliteIndexStore; vectors: SqliteVectorStore } {
    const held = this.#open.get(id);
    if (held) return held;
    if (!(id in this.#manifest.fragments)) {
      throw new ShardError(`"${id}" is not a fragment of the manifest`, {
        context: { fragments: Object.keys(this.#manifest.fragments) },
      });
    }
    const index = SqliteIndexStore.open(this.#path(id));
    const shard = { index, vectors: new SqliteVectorStore(index.database) };
    this.#open.set(id, shard);
    return shard;
  }

  /** Fragments that hold a database, whether it is open yet or not. */
  #existing(): readonly string[] {
    return Object.keys(this.#manifest.fragments)
      .filter((id) => this.#open.has(id) || existsSync(this.#path(id)))
      .sort();
  }

  /** Databases in the folder that belong to no fragment (a fragment that was removed or renamed). */
  #orphans(): readonly string[] {
    if (!existsSync(this.#directory)) return [];
    return readdirSync(this.#directory)
      .filter((name) => name.endsWith('.db'))
      .map((name) => name.slice(0, -'.db'.length))
      .filter((id) => id !== META_SHARD && !(id in this.#manifest.fragments))
      .sort();
  }

  get manifestSha256(): string {
    return createHash('sha256').update(manifestText(this.#manifest)).digest('hex');
  }

  /** What is out of place, and how the shards are filled. */
  async drift(channels: readonly string[] = []): Promise<DriftReport> {
    const misplacedFiles: Misplaced[] = [];
    const shards: ShardSummary[] = [];
    for (const id of this.#existing()) {
      const store = this.#shard(id).index;
      let cursor: string | undefined;
      do {
        const page = await store.files(cursor === undefined ? {} : { cursor });
        for (const file of page.items as readonly FileState[]) {
          const belongsIn = this.assigner.assign(file.path);
          if (belongsIn !== id) misplacedFiles.push({ path: file.path, in: id, belongsIn });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      const stats = await store.stats();
      shards.push({
        id,
        files: stats.files,
        quarantinedFiles: stats.quarantinedFiles,
        symbols: stats.symbols,
      });
    }
    const misplacedSources: (Misplaced & { channel: string })[] = [];
    for (const channel of channels) {
      for (const item of await this.vectors.misplaced(channel))
        misplacedSources.push({ ...item, channel });
    }
    return {
      manifestChanged: (await this.#meta.getMeta(MANIFEST_META_KEY)) !== this.manifestSha256,
      misplacedFiles,
      misplacedSources,
      orphanShards: this.#orphans(),
      shards,
    };
  }

  /**
   * Make the shards agree with the manifest: forget every file (and embedded source) that sits in a
   * shard the manifest does not send it to, and delete shard databases no fragment owns. What was
   * forgotten is indexed again, in the right place, by the next run. Records the manifest it settled
   * against, so a run can tell whether it needs to do this at all.
   */
  async settle(channels: readonly string[] = []): Promise<{
    readonly movedFiles: number;
    readonly movedSources: number;
    readonly removedShards: readonly string[];
  }> {
    const before = await this.drift(channels);
    let movedFiles = 0;
    for (const { path, in: shard } of before.misplacedFiles) {
      if (await this.#shard(shard).index.removeFile(path)) movedFiles += 1;
    }
    let movedSources = 0;
    for (const channel of channels) movedSources += await this.vectors.evictMisplaced(channel);
    for (const id of before.orphanShards) await rm(this.#path(id), { force: true });
    await this.#meta.setMeta(MANIFEST_META_KEY, this.manifestSha256);
    return { movedFiles, movedSources, removedShards: before.orphanShards };
  }

  /** Whether the shards were last settled against a different manifest than this one. */
  async needsSettling(): Promise<boolean> {
    const recorded = await this.#meta.getMeta(MANIFEST_META_KEY);
    if (recorded === this.manifestSha256) return false;
    // A set with nothing in it has nothing to move: it is simply recorded.
    return this.#existing().length > 0 || this.#orphans().length > 0;
  }

  async recordManifest(): Promise<void> {
    await this.#meta.setMeta(MANIFEST_META_KEY, this.manifestSha256);
  }

  async close(): Promise<void> {
    for (const { index } of this.#open.values()) await index.close();
    this.#open.clear();
    await this.#meta.close();
  }
}
