import { InvalidArgumentError } from './errors.ts';

/**
 * The single place a numeric limit may be declared as a constant. Everything else takes its limit
 * from the caller, derives it from a real constraint (a model's token window, available memory),
 * and reports it through `LimitReport`. A limit that applies is never silent.
 */

/**
 * Page size used when the caller does not give one. Deliberately high: it exists so an unbounded
 * result set cannot be returned by accident, not to shape results. Interfaces that feed a model
 * (the MCP server) pass their own, smaller, limit.
 */
export const DEFAULT_RESULT_LIMIT = 1000;

export type LimitSource = 'caller' | 'default' | 'derived';

/** What limit was applied, where it came from, and whether it actually cut anything off. */
export interface LimitReport {
  readonly name: string;
  readonly applied: number;
  readonly source: LimitSource;
  readonly reached: boolean;
  /** Why a derived limit has this value, e.g. "encoder window 512 tokens". */
  readonly reason?: string;
}

export interface PageRequest {
  readonly limit?: number;
  /** Opaque token from a previous page's `nextCursor`. */
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Total matches when the source knows it; `null` for streamed sources. */
  readonly total: number | null;
  /** Present when more results exist. Pass it back as `cursor` to continue. */
  readonly nextCursor: string | null;
  readonly limit: LimitReport;
}

export interface ResolvedLimit {
  readonly value: number;
  readonly source: Extract<LimitSource, 'caller' | 'default'>;
}

export function resolveLimit(name: string, requested: number | undefined): ResolvedLimit {
  if (requested === undefined) return { value: DEFAULT_RESULT_LIMIT, source: 'default' };
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new InvalidArgumentError(name, 'a positive integer', requested);
  }
  return { value: requested, source: 'caller' };
}

interface CursorPayload {
  readonly v: 1;
  readonly offset: number;
}

export function encodeCursor(offset: number): string {
  const payload: CursorPayload = { v: 1, offset };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): number {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (parseFailure) {
    throw new InvalidArgumentError('cursor', 'a token from a previous page', cursor, {
      cause: parseFailure,
    });
  }
  const candidate = payload as Partial<CursorPayload> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    candidate.v !== 1 ||
    typeof candidate.offset !== 'number' ||
    !Number.isSafeInteger(candidate.offset) ||
    candidate.offset < 0
  ) {
    throw new InvalidArgumentError('cursor', 'a token from a previous page', cursor);
  }
  return candidate.offset;
}

/** Slice an in-memory result list into a page, reporting the limit that was applied. */
export function paginate<T>(all: readonly T[], request: PageRequest = {}): Page<T> {
  const { value: limit, source } = resolveLimit('limit', request.limit);
  const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor);
  const end = offset + limit;
  const items = all.slice(offset, end);
  const more = end < all.length;
  return {
    items,
    total: all.length,
    nextCursor: more ? encodeCursor(end) : null,
    limit: { name: 'limit', applied: limit, source, reached: more },
  };
}
