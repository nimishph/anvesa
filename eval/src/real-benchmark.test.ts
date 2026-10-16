import { describe, expect, test } from 'bun:test';
import { builtinModel, ModelCache, openLocalEmbedder } from '@cntxt-labs/anvesa-embedder';
import { fixtureReady, loadFixtures } from './fixtures.ts';
import { benchmarkFixture, rankFiles, scoreVariant } from './real-benchmark.ts';
import type { EvalQuery } from './retrieval.ts';

const unit = (...values: number[]) => {
  const norm = Math.hypot(...values);
  return new Float32Array(values.map((value) => value / norm));
};

describe('ranking files for the real-world benchmark', () => {
  const cards = [
    { path: 'a.ts', text: 'a1' },
    { path: 'b.ts', text: 'b1' },
    { path: 'a.ts', text: 'a2' },
  ];
  const vectors = [unit(1, 0), unit(0.6, 0.8), unit(0.8, 0.6)];

  test('ranks each file once, by its best card', () => {
    expect(rankFiles(unit(0, 1), cards, vectors)).toEqual(['b.ts', 'a.ts']);
    expect(rankFiles(unit(1, 0), cards, vectors)).toEqual(['a.ts', 'b.ts']);
  });

  test('scores recall and reciprocal rank of the defining file', () => {
    const query = (text: string, relevant: string): EvalQuery => ({
      population: 'identifier',
      text,
      relevant: new Set([relevant]),
      symbol: text,
    });
    const scored = scoreVariant(
      'plain',
      'identifier',
      [
        { query: query('q1', 'b.ts'), vector: unit(0, 1) }, // rank 1
        { query: query('q2', 'b.ts'), vector: unit(1, 0) }, // rank 2
      ],
      cards,
      vectors,
    );
    expect(scored.queries).toBe(2);
    expect(scored.recall[1]).toBe(0.5);
    expect(scored.recall[5]).toBe(1);
    expect(scored.mrr).toBe(0.75);
  });
});

// The real repositories and model, where they are at hand: `bun run eval:fixtures` fetches the
// repositories, and `anvesa model install all-MiniLM-L6-v2 --download` the model. Skipped, and
// said to be skipped, otherwise; CI has neither.
const nanoGpt = loadFixtures().find((fixture) => fixture.name === 'nanoGPT');
const model = builtinModel('all-MiniLM-L6-v2');
const ready =
  nanoGpt !== undefined &&
  model !== undefined &&
  (await fixtureReady(nanoGpt)) &&
  (await new ModelCache().find(model)) !== undefined;

describe('real-world benchmark on nanoGPT', () => {
  test.skipIf(!ready)(
    'scores every variant on queries made from the code',
    async () => {
      const embedder = await openLocalEmbedder(model as NonNullable<typeof model>);
      try {
        const result = await benchmarkFixture(nanoGpt as NonNullable<typeof nanoGpt>, embedder);
        expect(result.cards).toBeGreaterThan(20);
        const variants = new Set(result.scores.map((s) => s.variant));
        expect([...variants].sort()).toEqual([
          'plain',
          'plain + calibrated',
          'preamble',
          'preamble + calibrated',
        ]);
        for (const s of result.scores) {
          expect(s.queries).toBeGreaterThan(0);
          expect(s.mrr).toBeGreaterThanOrEqual(0);
          expect(s.mrr).toBeLessThanOrEqual(1);
        }
        // Calibration centres the cards: the mean cosine between them falls towards 0.
        expect(Math.abs(result.anisotropy.after.meanCosine)).toBeLessThan(
          Math.abs(result.anisotropy.before.meanCosine),
        );
      } finally {
        await embedder.dispose();
      }
    },
    120_000,
  );
});
