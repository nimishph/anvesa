import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  applyScipOverlay,
  decodeScip,
  type EdgeRecord,
  type IndexStore,
  type StoreDatabase,
  type SymbolFact,
} from '@cntxt-labs/anvesa-indexer';
import type { ExperimentalConfig, PropagateConfig } from './config.ts';

/**
 * Experiments run after an index pass, in order: a SCIP index replaces call edges, then symbol
 * vectors are mixed with their graph neighbours'. Each says what it did, as a line of the report.
 */
export async function runExperiments(
  root: string,
  config: ExperimentalConfig | undefined,
  store: IndexStore,
  database: StoreDatabase | undefined,
): Promise<string[]> {
  const notes: string[] = [];
  if (config?.scip) {
    const path = isAbsolute(config.scip) ? config.scip : join(root, config.scip);
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    const report = await applyScipOverlay(store, decodeScip(new Uint8Array(bytes)), {
      indexedAtMs: info.mtimeMs,
    });
    notes.push(
      `experimental scip: ${report.documents} documents (${report.skipped} skipped as changed or not indexed), ` +
        `${report.mapped}/${report.definitions} definitions matched to symbols, ` +
        `${report.edges.calls} call, ${report.edges.types} type and ${report.edges.values} value edges ` +
        `replacing ${report.replaced} call edges`,
    );
  }
  if (database) {
    const note = await syncPropagation(store, database, config?.propagate);
    if (note) notes.push(note);
  } else if (config?.propagate) {
    notes.push(
      'experimental propagate: skipped, it needs a single index database (fragments are on)',
    );
  }
  return notes;
}

const PROPAGATE_META = 'experimental.propagate';
const CHANNEL = 'symbols';

async function all<T>(
  fetch: (
    cursor: string | undefined,
  ) => Promise<{ items: readonly T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

const unit = (vector: Float32Array): Float32Array => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
};

/**
 * Searched symbol vectors become `unit(raw + alpha * mean(neighbour raw))`, from the vectors the
 * encoder made (`card_vectors_raw`), so running it again never compounds. A symbol's neighbours
 * are the symbols it shares an edge of the configured kinds with, either way, and its parent and
 * members. Without a config, a previous propagation is undone.
 */
async function syncPropagation(
  store: IndexStore,
  database: StoreDatabase,
  config: PropagateConfig | undefined,
): Promise<string | undefined> {
  const previous = await store.getMeta(PROPAGATE_META);
  if (!config && previous === undefined) return undefined;

  const rows = database.guard('read raw vectors', (db) =>
    db
      .query(
        `SELECT r.id AS id, c.group_key AS grp, r.vector AS vector
           FROM card_vectors_raw r JOIN cards c ON c.channel = r.channel AND c.id = r.id
          WHERE r.channel = ?`,
      )
      .all(CHANNEL),
  ) as { id: string; grp: string; vector: Uint8Array }[];
  const raw = new Map<string, Float32Array>();
  const cardsOf = new Map<string, string[]>();
  for (const row of rows) {
    const bytes = new Uint8Array(row.vector);
    raw.set(row.id, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    const group = cardsOf.get(row.grp) ?? [];
    group.push(row.id);
    cardsOf.set(row.grp, group);
  }

  const next = new Map<string, Float32Array>(raw);
  let mixed = 0;
  if (config) {
    // A symbol's cards share a group, keyed by the symbol's id (duplicates aside).
    const groupVector = new Map<string, Float32Array>();
    for (const [group, ids] of cardsOf) {
      const first = raw.get(ids[0] as string) as Float32Array;
      const sum = new Float32Array(first.length);
      for (const id of ids) {
        (raw.get(id) as Float32Array).forEach((v, i) => {
          sum[i] = (sum[i] as number) + v;
        });
      }
      groupVector.set(group, unit(sum));
    }
    const neighbours = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
      if (a === b || !groupVector.has(a) || !groupVector.has(b)) return;
      (neighbours.get(a) ?? (neighbours.set(a, new Set()).get(a) as Set<string>)).add(b);
      (neighbours.get(b) ?? (neighbours.set(b, new Set()).get(b) as Set<string>)).add(a);
    };
    const edges = await all<EdgeRecord>((cursor) =>
      store.findEdges({ kinds: config.edges, ...(cursor ? { cursor } : {}) }),
    );
    for (const edge of edges) link(edge.from, edge.to);
    const symbols = await all<SymbolFact>((cursor) =>
      store.findSymbols({ ...(cursor ? { cursor } : {}) }),
    );
    for (const symbol of symbols) if (symbol.parentId) link(symbol.id, symbol.parentId);

    for (const [group, around] of neighbours) {
      const mean = new Float32Array((groupVector.get(group) as Float32Array).length);
      for (const other of around) {
        (groupVector.get(other) as Float32Array).forEach((v, i) => {
          mean[i] = (mean[i] as number) + v / around.size;
        });
      }
      for (const id of cardsOf.get(group) ?? []) {
        const own = raw.get(id) as Float32Array;
        next.set(id, unit(own.map((v, i) => v + config.alpha * (mean[i] as number))));
        mixed += 1;
      }
    }
  }

  database.transaction('store propagated vectors', (db) => {
    // Prepared and finalised, not `db.query`: past bun's 20 cached statements that hands back one
    // nothing finalises, and the strict close of the database fails.
    const update = db.prepare('UPDATE card_vectors SET vector = ? WHERE channel = ? AND id = ?');
    try {
      for (const [id, vector] of next) {
        update.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), CHANNEL, id);
      }
    } finally {
      update.finalize();
    }
  });
  if (config) await store.setMeta(PROPAGATE_META, JSON.stringify(config));
  else await store.deleteMeta(PROPAGATE_META);
  return config
    ? `experimental propagate: ${mixed} of ${raw.size} symbol cards mixed with their neighbours (alpha ${config.alpha}, edges ${config.edges.join(', ')} and containment)`
    : `experimental propagate: off, ${raw.size} symbol vectors restored`;
}
