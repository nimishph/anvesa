import {
  type Deadline,
  decodeCursor,
  encodeCursor,
  type Page,
  resolveLimit,
} from '@cntxt-labs/anvesa-core';
import type { Card } from './card.ts';
import { type Embedder, embedAll } from './embedder.ts';
import { EmbedFailedError } from './errors.ts';
import type { RedTeamGate } from './redteam/index.ts';
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
  /**
   * Screen every card again as it comes back. Cards were screened when indexed, but the index can
   * have been written under an older policy, or edited since; a card the gate would not admit now
   * is withheld, and one it would clean is cleaned.
   */
  readonly gate?: RedTeamGate;
}

/** What the retrieval-time screen did to a page. */
export interface RetrievalScreen {
  /** Cards withheld because the gate would not admit them now. */
  readonly withheld: number;
  /** Cards returned with offending text removed. */
  readonly sanitized: number;
}

export type RetrievedPage = Page<SearchHit> & { readonly screen?: RetrievalScreen };

/**
 * Search one channel by meaning. Cards come back as data with their category and provenance, for
 * the caller to present as untrusted content.
 */
export async function retrieve(options: RetrieveOptions): Promise<RetrievedPage> {
  const { value: limit, source } = resolveLimit('limit', options.limit);
  const offset = options.cursor === undefined ? 0 : decodeCursor(options.cursor);

  const [vector] = await embedAll(options.embedder, [options.query], {
    ...(options.deadline ? { deadline: options.deadline } : {}),
  });
  if (!vector)
    throw new EmbedFailedError(options.embedder.info.id, 'returned no vector for the query');

  // Ask for one more than the page holds: that is how we know whether another page exists.
  const found = await options.store.search(vector, {
    channel: options.channel,
    model: options.embedder.info.id,
    limit: offset + limit + 1,
    collapse: options.collapse ?? true,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
  });
  const { hits, screen } = options.gate ? screenHits(options.gate, found) : { hits: found };
  const more = hits.length > offset + limit;
  return {
    items: hits.slice(offset, offset + limit),
    total: more ? null : hits.length,
    nextCursor: more ? encodeCursor(offset + limit) : null,
    limit: { name: 'limit', applied: limit, source, reached: more },
    ...(screen ? { screen } : {}),
  };
}

function screenHits(
  gate: RedTeamGate,
  found: readonly SearchHit[],
): { hits: SearchHit[]; screen: RetrievalScreen } {
  const hits: SearchHit[] = [];
  let withheld = 0;
  let sanitized = 0;
  for (const hit of found) {
    const result = gate.screen(hit.card);
    if (result.verdict === 'quarantine') {
      withheld += 1;
      continue;
    }
    if (result.verdict === 'sanitize') sanitized += 1;
    hits.push(result.verdict === 'sanitize' ? { ...hit, card: result.card } : hit);
  }
  return { hits, screen: { withheld, sanitized } };
}
