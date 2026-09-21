import { describe, expect, test } from 'bun:test';
import { InvalidArgumentError } from './errors.ts';
import {
  DEFAULT_RESULT_LIMIT,
  decodeCursor,
  encodeCursor,
  paginate,
  resolveLimit,
} from './limits.ts';

const numbers = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('resolveLimit', () => {
  test('falls back to the documented default and says so', () => {
    expect(resolveLimit('limit', undefined)).toEqual({
      value: DEFAULT_RESULT_LIMIT,
      source: 'default',
    });
  });

  test('honours a caller limit and says so', () => {
    expect(resolveLimit('limit', 5)).toEqual({ value: 5, source: 'caller' });
  });

  test('rejects zero, negatives, fractions and non-finite values', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveLimit('limit', bad)).toThrow(InvalidArgumentError);
    }
  });
});

describe('cursor', () => {
  test('round-trips', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });

  test('rejects wrong version and negative offsets', () => {
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, offset: 1 })).toString('base64url');
    expect(() => decodeCursor(wrongVersion)).toThrow(InvalidArgumentError);
    const negative = Buffer.from(JSON.stringify({ v: 1, offset: -1 })).toString('base64url');
    expect(() => decodeCursor(negative)).toThrow(InvalidArgumentError);
  });

  test('rejects garbage and keeps the parse failure as the cause', () => {
    expect(() => decodeCursor('not json at all')).toThrow(InvalidArgumentError);
    const failure = (() => {
      try {
        return decodeCursor('not json at all');
      } catch (thrown) {
        return thrown as InvalidArgumentError;
      }
    })();
    expect(failure).toBeInstanceOf(InvalidArgumentError);
    expect((failure as InvalidArgumentError).cause).toBeDefined();
  });
});

describe('paginate', () => {
  test('walking every page yields all items once, in order', () => {
    const all = numbers(23);
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = paginate(all, cursor === undefined ? { limit: 10 } : { limit: 10, cursor });
      seen.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(seen).toEqual(all);
    expect(pages).toBe(3);
  });

  test('reports the limit and whether it cut anything off', () => {
    const cut = paginate(numbers(5), { limit: 3 });
    expect(cut.limit).toEqual({ name: 'limit', applied: 3, source: 'caller', reached: true });
    expect(cut.total).toBe(5);
    expect(cut.nextCursor).not.toBeNull();
    const whole = paginate(numbers(5), { limit: 5 });
    expect(whole.limit.reached).toBe(false);
    expect(whole.nextCursor).toBeNull();
  });

  test('the default limit is reported as default and does not cut small results', () => {
    const page = paginate(numbers(3));
    expect(page.items).toHaveLength(3);
    expect(page.limit).toMatchObject({
      applied: DEFAULT_RESULT_LIMIT,
      source: 'default',
      reached: false,
    });
  });

  test('a cursor past the end yields an empty final page', () => {
    const page = paginate(numbers(3), { limit: 2, cursor: encodeCursor(99) });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
