import type { Database } from 'bun:sqlite';
import {
  type Card,
  type ChannelStats,
  DimensionMismatchError,
  dot,
  normalize,
  type QuarantinedCard,
  type ScoredId,
  type SearchHit,
  type SearchOptions,
  type SourceState,
  type SourceUpdate,
  TopKCollector,
  type VectorStore,
} from '@cntxt-labs/anvesa-dense';
import { StoreCorruptError } from '../errors.ts';
import { allRows, getRow, type StoreDatabase } from './database.ts';

/** How often a scan checks its deadline. A pacing interval, not a limit on what is searched. */
const DEADLINE_CHECK_EVERY = 1024;

/** Vectors are stored as the raw bytes of a `Float32Array`, in the machine's byte order. */
const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;

interface ScanRow {
  id: string;
  group_key: string;
  dims: number;
  vector: Uint8Array;
}

interface Scored extends ScoredId {
  readonly group: string;
}

/**
 * Card vectors on SQLite. Search is exact: every stored vector of the channel and model is
 * compared, one row at a time, so memory use stays flat however many cards there are. Only the
 * winners' cards are read back.
 *
 * Vectors are stored already normalised, so a cosine similarity is one dot product.
 */
export class SqliteVectorStore implements VectorStore {
  readonly #database: StoreDatabase;

  constructor(database: StoreDatabase) {
    this.#database = database;
  }

  get database(): StoreDatabase {
    return this.#database;
  }

  async replaceSource(update: SourceUpdate): Promise<void> {
    // Normalising can refuse a zero vector; do it before anything is written.
    const prepared = update.cards.map(({ card, vector }) => ({ card, unit: normalize(vector) }));

    this.#database.transaction('store cards', (db) => {
      const known = dimensionsOf(db, update.channel, update.model);
      const first = prepared[0]?.unit.length;
      const expected = known ?? first;
      for (const { unit } of prepared) {
        if (expected !== undefined && unit.length !== expected) {
          throw new DimensionMismatchError(update.channel, update.model, expected, unit.length);
        }
      }

      db.query('DELETE FROM vector_sources WHERE channel = ? AND path = ?').run(
        update.channel,
        update.path,
      );
      db.query(
        `INSERT INTO vector_sources
           (channel, path, model, content_hash, transformer_version, cards, quarantined)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        update.channel,
        update.path,
        update.model,
        update.contentHash,
        update.transformerVersion,
        prepared.length,
        update.quarantined.length,
      );
      if (known === undefined && first !== undefined) {
        db.query('INSERT INTO vector_dims (channel, model, dims) VALUES (?, ?, ?)').run(
          update.channel,
          update.model,
          first,
        );
      }

      const insertCard = db.query(
        `INSERT INTO cards (channel, id, path, model, group_key, card, dims, vector)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { card, unit } of prepared) {
        insertCard.run(
          update.channel,
          card.id,
          update.path,
          update.model,
          card.attrs.group ?? card.id,
          JSON.stringify(card),
          unit.length,
          Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength),
        );
      }

      const insertQuarantine = db.query(
        'INSERT INTO card_quarantine (channel, path, seq, entry) VALUES (?, ?, ?, ?)',
      );
      update.quarantined.forEach((entry, seq) => {
        insertQuarantine.run(update.channel, update.path, seq, JSON.stringify(entry));
      });
    });
  }

  async removeSource(channel: string, path: string): Promise<boolean> {
    return this.#database.transaction(
      'remove cards',
      (db) =>
        db.query('DELETE FROM vector_sources WHERE channel = ? AND path = ?').run(channel, path)
          .changes > 0,
    );
  }

  async sourceState(channel: string, path: string): Promise<SourceState | undefined> {
    return this.#database.guard('read a source state', (db) => {
      const row = getRow(
        db,
        `SELECT content_hash, transformer_version, model, cards, quarantined
           FROM vector_sources WHERE channel = ? AND path = ?`,
        channel,
        path,
      ) as {
        content_hash: string;
        transformer_version: string;
        model: string;
        cards: number;
        quarantined: number;
      } | null;
      return row
        ? {
            contentHash: row.content_hash,
            transformerVersion: row.transformer_version,
            model: row.model,
            cards: row.cards,
            quarantined: row.quarantined,
          }
        : undefined;
    });
  }

  async sourcePaths(channel: string): Promise<readonly string[]> {
    return this.#database.guard('list sources', (db) =>
      (
        allRows(db, 'SELECT path FROM vector_sources WHERE channel = ? ORDER BY path', channel) as {
          path: string;
        }[]
      ).map((row) => row.path),
    );
  }

  async search(query: Float32Array, options: SearchOptions): Promise<readonly SearchHit[]> {
    return this.#database.guard('search cards', (db) => {
      const stored = dimensionsOf(db, options.channel, options.model);
      if (stored === undefined) return [];
      if (query.length !== stored) {
        throw new DimensionMismatchError(options.channel, options.model, stored, query.length);
      }
      const unit = normalize(query);
      const best = this.#scan(db, unit, stored, options);

      return best.map((entry): SearchHit => {
        const row = getRow(
          db,
          'SELECT card FROM cards WHERE channel = ? AND id = ?',
          options.channel,
          entry.id,
        ) as { card: string } | null;
        if (!row) {
          throw new StoreCorruptError('cards', entry.id, 'the card vanished during a search');
        }
        return { card: parseCard(row.card, entry.id), score: entry.score };
      });
    });
  }

  /** The best `limit` (id, score) pairs, streaming over the channel's vectors. */
  #scan(db: Database, unit: Float32Array, dims: number, options: SearchOptions): Scored[] {
    const scratch = new Float32Array(dims);
    const scratchBytes = new Uint8Array(scratch.buffer);
    const select = options.filter
      ? 'SELECT id, group_key, dims, vector, card FROM cards WHERE channel = ? AND model = ?'
      : 'SELECT id, group_key, dims, vector FROM cards WHERE channel = ? AND model = ?';

    const collector = new TopKCollector<Scored>(options.limit);
    const groups = new Map<string, Scored>();
    let seen = 0;
    for (const row of db.query(select).iterate(options.channel, options.model) as Iterable<
      ScanRow & { card?: string }
    >) {
      seen += 1;
      if (seen % DEADLINE_CHECK_EVERY === 0) {
        options.deadline?.throwIfExpired('search the vector store');
      }
      if (row.vector.byteLength !== dims * BYTES_PER_FLOAT || row.dims !== dims) {
        throw new StoreCorruptError('cards', row.id, 'the stored vector has the wrong length', {
          context: { expectedBytes: dims * BYTES_PER_FLOAT, actualBytes: row.vector.byteLength },
        });
      }
      if (options.filter && row.card !== undefined) {
        if (!options.filter(parseCard(row.card, row.id))) continue;
      }
      // Copy into aligned memory: the row's bytes may start at any offset.
      scratchBytes.set(row.vector);
      const scored: Scored = { id: row.id, score: dot(unit, scratch), group: row.group_key };

      if (options.collapse) {
        const current = groups.get(scored.group);
        if (!current || rankedAbove(scored, current)) groups.set(scored.group, scored);
      } else {
        collector.add(scored);
      }
    }

    if (!options.collapse) return collector.result();
    for (const entry of groups.values()) collector.add(entry);
    return collector.result();
  }

  async cardCounts(channel: string): Promise<readonly number[]> {
    return this.#database.guard('count cards per source', (db) =>
      (
        allRows(
          db,
          'SELECT cards FROM vector_sources WHERE channel = ? ORDER BY cards',
          channel,
        ) as { cards: number }[]
      ).map((row) => row.cards),
    );
  }

  async stats(channel: string): Promise<ChannelStats> {
    return this.#database.guard('count cards', (db) => {
      const totals = allRows(
        db,
        `SELECT model, sum(cards) AS cards FROM vector_sources
           WHERE channel = ? GROUP BY model ORDER BY model`,
        channel,
      ) as { model: string; cards: number }[];
      const dims = new Map(
        (
          allRows(db, 'SELECT model, dims FROM vector_dims WHERE channel = ?', channel) as {
            model: string;
            dims: number;
          }[]
        ).map((row) => [row.model, row.dims]),
      );
      const counted = getRow(
        db,
        `SELECT count(*) AS sources, coalesce(sum(cards), 0) AS cards,
                coalesce(sum(quarantined), 0) AS quarantined
         FROM vector_sources WHERE channel = ?`,
        channel,
      ) as { sources: number; cards: number; quarantined: number };

      return {
        channel,
        cards: counted.cards,
        sources: counted.sources,
        quarantined: counted.quarantined,
        medianCardsPerSource: medianCardsPerSource(db, channel, counted.sources),
        models: totals.map((row) => ({
          model: row.model,
          dimensions: dims.get(row.model) ?? 0,
          cards: row.cards,
        })),
      };
    });
  }

  async quarantined(channel: string): Promise<readonly QuarantinedCard[]> {
    return this.#database.guard('read quarantined cards', (db) => {
      const rows = allRows(
        db,
        'SELECT path, seq, entry FROM card_quarantine WHERE channel = ? ORDER BY path, seq',
        channel,
      ) as { path: string; seq: number; entry: string }[];
      return rows.map((row) => {
        try {
          return JSON.parse(row.entry) as QuarantinedCard;
        } catch (failure) {
          throw new StoreCorruptError(
            'card_quarantine',
            `${channel}/${row.path}#${row.seq}`,
            'not JSON',
            {
              cause: failure,
            },
          );
        }
      });
    });
  }
}

function dimensionsOf(db: Database, channel: string, model: string): number | undefined {
  const row = getRow(
    db,
    'SELECT dims FROM vector_dims WHERE channel = ? AND model = ?',
    channel,
    model,
  ) as { dims: number } | null;
  return row?.dims;
}

/** The middle of the per-source card counts, read by position so no count list is loaded. */
function medianCardsPerSource(db: Database, channel: string, sources: number): number {
  if (sources === 0) return 0;
  const middle = Math.floor(sources / 2);
  const take = sources % 2 === 1 ? 1 : 2;
  const rows = allRows(
    db,
    'SELECT cards FROM vector_sources WHERE channel = ? ORDER BY cards LIMIT ? OFFSET ?',
    channel,
    take,
    sources % 2 === 1 ? middle : middle - 1,
  ) as { cards: number }[];
  return rows.reduce((sum, row) => sum + row.cards, 0) / rows.length;
}

/** Whether `a` outranks `b`: higher score, or on equal scores the earlier id. */
function rankedAbove(a: ScoredId, b: ScoredId): boolean {
  return a.score > b.score || (a.score === b.score && a.id < b.id);
}

function parseCard(text: string, id: string): Card {
  try {
    return JSON.parse(text) as Card;
  } catch (failure) {
    throw new StoreCorruptError('cards', id, 'the stored card is not JSON', { cause: failure });
  }
}
