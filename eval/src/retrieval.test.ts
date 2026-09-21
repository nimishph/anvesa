import { describe, expect, test } from 'bun:test';
import type { SymbolFact } from '@sutras/code-lens-indexer';
import {
  firstSentence,
  generateQueries,
  percentile,
  rankOf,
  score,
  spread,
  words,
} from './retrieval.ts';

const symbol = (over: Partial<SymbolFact> & { path: string; baseName: string }): SymbolFact => ({
  id: `${over.path}#${over.baseName}`,
  name: over.baseName,
  kind: 'function',
  parentId: undefined,
  exported: true,
  startLine: 1,
  endLine: 2,
  signature: undefined,
  doc: undefined,
  ...over,
});

describe('query generation', () => {
  test('splits identifiers into words', () => {
    expect(words('parseHTTPConfig')).toEqual(['parse', 'http', 'config']);
    expect(words('load_user_data')).toEqual(['load', 'user', 'data']);
    expect(words('Server')).toEqual(['server']);
  });

  test('takes the first sentence of a doc comment, without markers or tags', () => {
    expect(firstSentence('/**\n * Parse the file. It is slow.\n * @param x the input\n */')).toBe(
      'Parse the file',
    );
  });

  test('identifier and exact-name queries count every file defining the name as correct', () => {
    const queries = generateQueries([
      symbol({ path: 'a.ts', baseName: 'loadUserData' }),
      symbol({ path: 'b.ts', baseName: 'loadUserData' }),
      symbol({ path: 'c.ts', baseName: 'run' }),
    ]);
    const identifier = queries.find((q) => q.population === 'identifier');
    expect(identifier?.text).toBe('load user data');
    expect([...(identifier?.relevant ?? [])].sort()).toEqual(['a.ts', 'b.ts']);
    expect(queries.find((q) => q.population === 'exact-name')?.text).toBe(
      '//function[@name="loadUserData"]',
    );
    expect(queries.filter((q) => q.population === 'identifier')).toHaveLength(1);
  });

  test('an intent query leaves the symbol name out and is only asked when long enough', () => {
    const queries = generateQueries([
      symbol({
        path: 'a.ts',
        baseName: 'retryRequest',
        doc: '/** Retry the request with exponential backoff until it succeeds. */',
      }),
      symbol({ path: 'b.ts', baseName: 'tiny', doc: '/** Does a thing. */' }),
    ]);
    const intent = queries.filter((q) => q.population === 'intent');
    expect(intent).toHaveLength(1);
    expect(intent[0]?.text).toBe('the with exponential backoff until it succeeds');
    expect(intent[0]?.text).not.toContain('retry');
  });

  test('test files are not asked about', () => {
    const queries = generateQueries([
      symbol({ path: 'src/__tests__/a.ts', baseName: 'loadUserData' }),
    ]);
    expect(queries).toEqual([]);
  });

  test('a per-population limit is spread over the eligible symbols, not taken from the front', () => {
    expect(spread([1, 2, 3, 4, 5, 6], 3)).toEqual([1, 3, 5]);
    expect(spread([1, 2], 5)).toEqual([1, 2]);
    expect(spread([1, 2], undefined)).toEqual([1, 2]);
  });
});

describe('scoring', () => {
  test('rank counts distinct files in the order returned', () => {
    expect(rankOf(['a', 'a', 'b', 'c'], new Set(['c']))).toBe(3);
    expect(rankOf(['a'], new Set(['z']))).toBeUndefined();
  });

  test('recall and MRR', () => {
    const result = score([1, 3, undefined, 12], [1, 5, 10, 50]);
    expect(result.queries).toBe(4);
    expect(result.recall.get(1)).toBe(0.25);
    expect(result.recall.get(5)).toBe(0.5);
    expect(result.recall.get(50)).toBe(0.75);
    expect(result.misses).toBe(1);
    expect(result.mrr).toBeCloseTo((1 + 1 / 3 + 0 + 1 / 12) / 4);
    expect(score([], [1]).recall.get(1)).toBe(0);
  });

  test('percentile by nearest rank', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(percentile([], 0.5)).toBeUndefined();
  });
});
