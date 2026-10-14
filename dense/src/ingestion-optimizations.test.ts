import { afterAll, describe, expect, it } from 'bun:test';
import { Deadline } from '@cntxt-labs/anvesa-core';
import { budgetFor } from './budget.ts';
import { inputFile } from './card.ts';
import { budgetSourceOf, embedAll, embedAllBucketed } from './embedder.ts';
import { createTransformServices } from './services.ts';
import { disposeEngines, makeEngine, wordEmbedder } from './test-support.ts';
import { symbolsTransformer } from './transformers/symbols.ts';
import {
  calibrateBatchCentroid,
  calibrateCentroid,
  computeCentroid,
  measureAnisotropy,
  normalize,
} from './vectors.ts';

const engine = makeEngine();
const services = createTransformServices(engine);
afterAll(disposeEngines);

describe('Ingestion Optimizations (Pillar 5)', () => {
  describe('Length-Sorted Bucket Dynamic Batching', () => {
    it('produces identical mathematical vectors with exact index parity', async () => {
      const embedder = wordEmbedder({ dimensions: 64, preferredBatchSize: 8 });

      // Generate 32 texts with varied token lengths from 3 words to 200 words
      const texts: string[] = [];
      const vocabulary = [
        'alpha',
        'beta',
        'gamma',
        'delta',
        'omega',
        'router',
        'handler',
        'service',
      ];

      for (let i = 0; i < 32; i++) {
        // Alternating short (5 words), medium (40 words), and long (120 words)
        const wordCount = (i % 3 === 0 ? 6 : i % 3 === 1 ? 45 : 130) + (i % 5);
        const words: string[] = [];
        for (let w = 0; w < wordCount; w++) {
          const word = vocabulary[(w + i) % vocabulary.length] ?? 'token';
          words.push(word);
        }
        texts.push(words.join(' '));
      }

      const linearVectors = await embedAll(embedder, texts);
      let statsReported = false;

      const bucketedVectors = await embedAllBucketed(embedder, texts, {
        onStats: (stats) => {
          statsReported = true;
          expect(stats.totalTexts).toBe(32);
          expect(stats.linearPaddedTokens).toBeGreaterThan(stats.bucketedPaddedTokens);
          expect(stats.paddingComputeReduction).toBeGreaterThan(0.35); // > 35% padding eliminated
        },
      });

      expect(statsReported).toBe(true);
      expect(bucketedVectors.length).toBe(linearVectors.length);

      // Verify 100% exact numerical match for every single item in original index order
      for (let i = 0; i < texts.length; i++) {
        const linear = linearVectors[i];
        const bucketed = bucketedVectors[i];
        expect(linear).toBeDefined();
        expect(bucketed).toBeDefined();
        if (!linear || !bucketed) continue;

        for (let d = 0; d < 64; d++) {
          expect(bucketed[d]).toBe(linear[d]);
        }
      }
    });

    it('handles edge cases gracefully: empty array and single text', async () => {
      const embedder = wordEmbedder({ dimensions: 32 });

      const empty = await embedAllBucketed(embedder, []);
      expect(empty).toEqual([]);

      const single = await embedAllBucketed(embedder, ['single function call']);
      expect(single.length).toBe(1);
      expect(single[0]?.length).toBe(32);
    });
  });

  describe('Vector Centroid Subtraction (Anisotropy Cone Calibration)', () => {
    it('flattens dominant representation cone and restores angular contrast', () => {
      const dims = 64;
      const count = 50;

      // 1. Synthesize vectors locked inside a narrow angular cone (mean similarity > 0.85)
      // Base non-informative direction
      const baseDirection = new Float32Array(dims);
      baseDirection.fill(1);
      const normalizedBase = normalize(baseDirection);

      const coneVectors: Float32Array[] = [];
      for (let i = 0; i < count; i++) {
        const v = new Float32Array(dims);
        for (let d = 0; d < dims; d++) {
          // Dominant base plus small distinctive perturbation
          const perturbation = Math.sin(i * 13 + d * 7) * 0.01;
          v[d] = (normalizedBase[d] ?? 0) + perturbation;
        }
        coneVectors.push(normalize(v));
      }

      // Check uncalibrated anisotropy
      const before = measureAnisotropy(coneVectors);
      expect(before.meanCosine).toBeGreaterThan(0.85); // Severe cone collapse
      expect(before.centroidNorm).toBeGreaterThan(0.85);

      // 2. Compute centroid and calibrate
      const centroid = computeCentroid(coneVectors);
      expect(centroid.length).toBe(dims);

      const calibrated = calibrateBatchCentroid(coneVectors, centroid);
      expect(calibrated.length).toBe(coneVectors.length);

      // Verify all calibrated vectors are valid unit vectors
      for (const v of calibrated) {
        let normSq = 0;
        for (const val of v) normSq += val * val;
        expect(Math.abs(Math.sqrt(normSq) - 1.0)).toBeLessThan(1e-5);
      }

      // 3. Measure post-calibration anisotropy
      const after = measureAnisotropy(calibrated);

      // Mean cosine similarity shifts from > 0.85 down to ~ 0.0 (isotropic dispersion)
      expect(Math.abs(after.meanCosine)).toBeLessThan(0.05);

      // Angular contrast expands significantly (min cosine drops, standard deviation grows)
      expect(after.minCosine).toBeLessThan(0.0);
      expect(after.stdCosine).toBeGreaterThan(before.stdCosine * 2);
    });

    it('calibrates a single query vector against the codebase centroid', () => {
      const centroid = normalize(new Float32Array([1, 1, 1, 1]));
      const query = normalize(new Float32Array([1.1, 0.9, 1.05, 0.95]));

      const calibratedQuery = calibrateCentroid(query, centroid);
      expect(calibratedQuery.length).toBe(4);

      let normSq = 0;
      for (const x of calibratedQuery) normSq += x * x;
      expect(Math.abs(Math.sqrt(normSq) - 1.0)).toBeLessThan(1e-5);
    });
  });

  describe('Graph-Context Preamble Injection', () => {
    it('prepends synthesized topological context to cards when enabled', async () => {
      const transformer = symbolsTransformer({ graphPreamble: true });
      expect(transformer.name).toBe('symbols');

      const file = inputFile(
        'src/services/auth.ts',
        `/** Authenticates a session token */
export function verifySession(token: string): boolean {
  return true;
}
`,
      );

      const embedder = wordEmbedder();
      const budget = budgetFor(budgetSourceOf(embedder));
      const drafts = await transformer.transform(file, {
        services,
        deadline: Deadline.unbounded(),
        budget,
      });

      expect(drafts.length).toBeGreaterThan(0);
      const card = drafts[0];
      expect(card).toBeDefined();

      // Verify preamble content injected into card text
      expect(card?.text).toContain(
        '[scope: src/services/auth.ts | symbol: function verifySession]',
      );
      expect(card?.text).toContain('Authenticates a session token');
      expect(card?.attrs?.hasPreamble).toBe('true');
    });
  });
});
