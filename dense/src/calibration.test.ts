import { afterAll, describe, expect, it } from 'bun:test';
import { Deadline } from '@cntxt-labs/anvesa-core';
import { budgetFor } from './budget.ts';
import { inputFile } from './card.ts';
import { budgetSourceOf } from './embedder.ts';
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

describe('centroid calibration and the graph preamble', () => {
  describe('centroid calibration', () => {
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

  describe('graph preamble', () => {
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

    it('leaves cards as they were when not asked for', async () => {
      const file = inputFile('src/a.ts', 'export function verifySession(token: string) {}\n');
      const budget = budgetFor(budgetSourceOf(wordEmbedder()));
      const [card] = await symbolsTransformer().transform(file, {
        services,
        deadline: Deadline.unbounded(),
        budget,
      });
      expect(card?.text).not.toContain('[scope:');
      expect(card?.attrs?.hasPreamble).toBeUndefined();
    });
  });
});
