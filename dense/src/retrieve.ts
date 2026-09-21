import {
  type Deadline,
  decodeCursor,
  encodeCursor,
  type Page,
  resolveLimit,
} from '@sutras/code-lens-core';
import type { Card } from './card.ts';
import { type Embedder, embedAll } from './embedder.ts';
import { EmbedFailedError } from './errors.ts';
import type { SearchHit, VectorStore } from './store.ts';

export interface RetrieveOptions {
  readonly embedder: Embedder;
  readonly store: VectorStore;
  readonly channel: string;
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly deadline?: Deadline;
  readonly filter?: (card: Card) => boolean;
  /** Show the best part of each item once. On by default. */
  readonly collapse?: boolean;
}

/**
 * Search one channel by meaning. Cards come back as data with their category and provenance, for
 * the caller to present as untrusted content.
 */
export async function retrieve(options: RetrieveOptions): Promise<Page<SearchHit>> {
  const { value: limit, source } = resolveLimit('limit', options.limit);
  const offset = options.cursor === undefined ? 0 : decodeCursor(options.cursor);

  const [vector] = await embedAll(options.embedder, [options.query], {
    ...(options.deadline ? { deadline: options.deadline } : {}),
  });
  if (!vector)
    throw new EmbedFailedError(options.embedder.info.id, 'returned no vector for the query');

  // Ask for one more than the page holds: that is how we know whether another page exists.
  const hits = await options.store.search(vector, {
    channel: options.channel,
    model: options.embedder.info.id,
    limit: offset + limit + 1,
    collapse: options.collapse ?? true,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
  });
  const more = hits.length > offset + limit;
  return {
    items: hits.slice(offset, offset + limit),
    total: more ? null : hits.length,
    nextCursor: more ? encodeCursor(offset + limit) : null,
    limit: { name: 'limit', applied: limit, source, reached: more },
  };
}
