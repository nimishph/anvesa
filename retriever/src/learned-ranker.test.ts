import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cardTextFor } from '@cntxt-labs/anvesa-dense';
import { ProjectConfigError } from './errors.ts';
import {
  bm25,
  bm25Stats,
  type Candidate,
  hubMeans,
  rankerFeatures,
  rerank,
  type SearchStage,
  scoreSymbols,
  summarizeStages,
  symbolOf,
  TreeRanker,
  type VectorRow,
  words,
} from './learned-ranker.ts';

describe('the stages telemetry may carry', () => {
  const stage = (symbols: string[], ms: number): SearchStage => ({
    symbols: symbols.map((symbol, rank) => ({ symbol, score: 1 - rank / 10 })),
    ms,
  });

  test('how far the ranker moved the first stage, in ranks and times only', () => {
    const first = stage(['a#A', 'b#B', 'c#C', 'd#D'], 4);
    const summary = summarizeStages({ first, ranked: stage(['c#C', 'a#A', 'b#B', 'd#D'], 2) });
    expect(summary).toEqual({
      candidates: 4,
      reranked: true,
      topChanged: true,
      shownTopFirstRank: 2,
      overlapAt10: 1,
      firstMs: 4,
      rankedMs: 2,
    });
    // Nothing in it names a symbol.
    expect(JSON.stringify(summary)).not.toMatch(/#/);
  });

  test('without a ranker, what was shown is the first stage', () => {
    expect(summarizeStages({ first: stage(['a#A'], 1) })).toEqual({
      candidates: 1,
      reranked: false,
      topChanged: false,
      shownTopFirstRank: 0,
      overlapAt10: 1,
      firstMs: 1,
      rankedMs: undefined,
    });
    expect(summarizeStages({ first: stage([], 1) }).shownTopFirstRank).toBeUndefined();
  });
});

/**
 * The port must give the numbers anvesa-gen-lab's corpus_bench.py gives, or the ranker reads
 * features it was not trained on. The fixture was written by `ranker_fixture.py` there, from
 * corpus_bench.py's own functions and a small XGBoost ranker fit on their output.
 */
const FIXTURE = resolve(import.meta.dir, '__fixtures__', 'learned-ranker');

interface FixtureCard {
  id: string;
  group: string;
  text: string;
  attrs: Record<string, string>;
  source: { path: string; contentHash: string };
  vector: number[];
  hubMean: number;
}
interface FixtureQuery {
  q: string;
  vector: number[];
  hubOrder: string[];
  features: Record<string, number>[];
  scores: number[];
  order: string[];
}
const fixture = JSON.parse(readFileSync(resolve(FIXTURE, 'fixture.json'), 'utf8')) as {
  hub: number;
  depth: number;
  cards: FixtureCard[];
  queries: FixtureQuery[];
};
const ranker = TreeRanker.parse(readFileSync(resolve(FIXTURE, 'ranker.json'), 'utf8'), 'ranker');
const vectors = fixture.cards.map((card) => Float32Array.from(card.vector));
const means = hubMeans(vectors);
const rows: VectorRow[] = fixture.cards.map((card, index) => ({
  id: card.id,
  group: card.group,
  vector: vectors[index] as Float32Array,
  hubMean: means[index] as number,
}));

/** BM25 over each symbol's first card without its path line, as `syncHubMeans` builds it. */
const stats = (() => {
  const first = new Map<string, FixtureCard>();
  for (const card of fixture.cards) {
    if (!first.has(symbolOf(card.group))) first.set(symbolOf(card.group), card);
  }
  return bm25Stats([...first.values()].map((card) => words(cardTextFor(card.text, 'nopath'))));
})();

function candidates(query: FixtureQuery): Candidate[] {
  const byId = new Map(fixture.cards.map((card) => [card.id, card]));
  return scoreSymbols(rows, Float32Array.from(query.vector), fixture.hub)
    .slice(0, fixture.depth)
    .map((symbol) => ({ ...symbol, card: byId.get(symbol.firstId) as FixtureCard }));
}

describe('the learned ranker matches corpus_bench.py', () => {
  test('hub means: mean cosine to the 10 nearest cards, the card itself left out', () => {
    fixture.cards.forEach((card, index) => {
      expect(means[index] as number).toBeCloseTo(card.hubMean, 5);
    });
  });

  test('the hub-penalised first stage orders symbols the same way', () => {
    for (const query of fixture.queries) {
      const order = scoreSymbols(rows, Float32Array.from(query.vector), fixture.hub).map(
        (symbol) => symbol.symbol,
      );
      expect(order.slice(0, fixture.depth)).toEqual(query.hubOrder);
    }
  });

  test('every feature the ranker reads, for the top 30 of every query', () => {
    for (const query of fixture.queries) {
      const got = rankerFeatures(query.q, candidates(query), stats);
      expect(got).toHaveLength(query.features.length);
      query.features.forEach((want, row) => {
        for (const [name, value] of Object.entries(want)) {
          const actual = got[row]?.[name];
          expect([name, actual]).toEqual([name, expect.closeTo(value, 6)]);
        }
      });
    }
  });

  test('the trees score exactly as XGBoost does', () => {
    for (const query of fixture.queries) {
      const scores = ranker.score(query.features);
      query.scores.forEach((want, index) => {
        expect(scores[index] as number).toBe(Math.fround(want));
      });
    }
  });

  test('features run through the trees give the same scores and the same final order', () => {
    // The fixture's cosines are exact in float32 and float64 (see ranker_fixture.py), so even a
    // feature that sits exactly on a split value takes the branch it takes in XGBoost. With real
    // vectors numpy's dot product can differ in its last bit, which flips such a split rarely.
    for (const query of fixture.queries) {
      const top = candidates(query);
      const scores = ranker.score(rankerFeatures(query.q, top, stats));
      query.scores.forEach((want, index) => {
        expect(scores[index] as number).toBe(Math.fround(want));
      });
      expect(rerank(top, scores).map((candidate) => candidate.symbol)).toEqual(query.order);
    }
  });
});

describe('the pieces', () => {
  test('words split identifiers at their humps and drop stop words', () => {
    expect(words('How do I parseHTTPRequest in the userId2Name?')).toEqual([
      'parse',
      'httprequest',
      'user',
      'id2',
      'name',
    ]);
  });

  test('BM25 counts a repeated query word each time and favours the rarer word', () => {
    const docs = [['retry', 'request'], ['request'], ['cache']];
    const s = bm25Stats(docs);
    expect(bm25(s, ['retry'], docs[0] as string[])).toBeGreaterThan(
      bm25(s, ['request'], docs[0] as string[]),
    );
    expect(bm25(s, ['retry', 'retry'], docs[0] as string[])).toBeCloseTo(
      2 * bm25(s, ['retry'], docs[0] as string[]),
      10,
    );
    expect(bm25(s, ['missing'], docs[0] as string[])).toBe(0);
  });

  test('hub means of fewer than eleven cards use what there is', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    const means = hubMeans([a, b]);
    expect([...means]).toEqual([0, 0]);
    expect([...hubMeans([a])]).toEqual([0]);
  });

  test('an overload is its symbol; a split card is read from its first part', () => {
    expect(symbolOf('a.ts#Foo#2')).toBe('a.ts#Foo');
    expect(symbolOf('a.ts#Foo')).toBe('a.ts#Foo');
    const v = Float32Array.from([1, 0]);
    const [only] = scoreSymbols(
      [
        { id: 'a.ts#Foo#2', group: 'a.ts#Foo#2', vector: v, hubMean: 0 },
        { id: 'a.ts#Foo~2', group: 'a.ts#Foo', vector: v, hubMean: 0.5 },
        { id: 'a.ts#Foo~1', group: 'a.ts#Foo', vector: v, hubMean: 0.2 },
      ],
      v,
      0.3,
    );
    expect(only).toMatchObject({ symbol: 'a.ts#Foo', bestId: 'a.ts#Foo#2', firstId: 'a.ts#Foo~1' });
    expect(only?.firstPenalty).toBe(Math.fround(Math.fround(0.3) * Math.fround(0.2)));
  });

  test('a ranker file that is not one anvesa can run is refused, naming why', () => {
    const model = JSON.parse(readFileSync(resolve(FIXTURE, 'ranker.json'), 'utf8'));
    expect(() => TreeRanker.parse('{', 'x.json')).toThrow(ProjectConfigError);
    const unknown = structuredClone(model);
    unknown.learner.feature_names[0] = 'intent_max';
    expect(() => TreeRanker.parse(JSON.stringify(unknown), 'x.json')).toThrow(/intent_max/);
    const nameless = structuredClone(model);
    delete nameless.learner.feature_names;
    expect(() => TreeRanker.parse(JSON.stringify(nameless), 'x.json')).toThrow(/names no features/);
  });
});
