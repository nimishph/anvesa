import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Deadline } from '@cntxt-labs/anvesa-core';
import {
  calibrateBatchCentroid,
  calibrateCentroid,
  computeCentroid,
  createTransformServices,
  dot,
  embedAll,
  embedAllBucketed,
  inputFile,
  measureAnisotropy,
  symbolsTransformer,
} from '@cntxt-labs/anvesa-dense';
import { builtinModel, openLocalEmbedder } from '@cntxt-labs/anvesa-embedder';
import { readSource, Workspace, walkSources } from '@cntxt-labs/anvesa-indexer';
import { StructuralEngine } from '@cntxt-labs/anvesa-structural';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';

describe('Real-World Repository Ingestion Benchmark Suite', () => {
  const commerceRoot = resolve('eval/fixtures/commerce');
  const nanoGptRoot = resolve('eval/fixtures/nanoGPT');

  it('eliminates > 50% zero-padding waste and expands angular contrast on vercel/commerce', async () => {
    if (!existsSync(commerceRoot)) {
      return;
    }

    const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
    const engine = new StructuralEngine({ runtime });
    const services = createTransformServices(engine);
    const symbols = symbolsTransformer();
    const budget = {
      maxTokens: 512,
      specialTokens: 2,
      count: (t: string) => t.split(/\s+/).length,
    };

    const ws = await Workspace.open({ root: commerceRoot });
    const cards: string[] = [];
    const skipped: unknown[] = [];

    for await (const file of walkSources(ws)) {
      if (!/\.(tsx?|jsx?)$/.test(file.path)) continue;
      const content = await readSource(commerceRoot, file.path);
      if (content.kind !== 'text') continue;

      const input = inputFile(file.path, content.content);
      if (!symbols.claim(input)) continue;
      try {
        const drafts = await symbols.transform(input, {
          services,
          deadline: Deadline.unbounded(),
          budget,
        });
        for (const d of drafts) cards.push(d.text);
      } catch (failure) {
        skipped.push(failure);
      }
    }

    expect(cards.length).toBeGreaterThan(100);

    const modelSpec = builtinModel('all-MiniLM-L6-v2');
    expect(modelSpec).toBeDefined();
    if (!modelSpec) return;
    const embedder = await openLocalEmbedder(modelSpec);

    try {
      let bucketStats: { linearPaddedTokens: number; bucketedPaddedTokens: number } | undefined;
      const linearVectors = await embedAll(embedder, cards);
      const bucketedVectors = await embedAllBucketed(embedder, cards, {
        onStats: (stats) => {
          bucketStats = stats;
        },
      });

      expect(bucketStats).toBeDefined();
      expect(linearVectors.length).toBe(cards.length);
      expect(bucketedVectors.length).toBe(cards.length);

      const actualTokens = cards.reduce((acc, t) => acc + Math.max(1, embedder.count(t)), 0);
      const linearWaste = (bucketStats?.linearPaddedTokens ?? 0) - actualTokens;
      const bucketWaste = (bucketStats?.bucketedPaddedTokens ?? 0) - actualTokens;
      const wasteEliminated = (linearWaste - bucketWaste) / linearWaste;

      // Real code on vercel/commerce eliminates > 70% of zero padding waste
      expect(wasteEliminated).toBeGreaterThan(0.7);

      // Measure real anisotropy before and after
      const before = measureAnisotropy(linearVectors);
      expect(before.centroidNorm).toBeGreaterThan(0.4); // Strong baseline centroid
      expect(before.meanCosine).toBeGreaterThan(0.2); // Anisotropic representation cone

      const centroid = computeCentroid(linearVectors);
      const calibrated = calibrateBatchCentroid(linearVectors, centroid);
      const after = measureAnisotropy(calibrated);

      // Shifted to origin
      expect(Math.abs(after.meanCosine)).toBeLessThan(0.05);
      // Contrast standard deviation expanded
      expect(after.stdCosine).toBeGreaterThan(before.stdCosine * 1.2);
    } finally {
      await embedder.dispose();
      await runtime.dispose();
    }
  }, 25000);

  it('sharpens retrieval contrast gap on karpathy/nanoGPT', async () => {
    if (!existsSync(nanoGptRoot)) {
      return;
    }

    const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
    const engine = new StructuralEngine({ runtime });
    const services = createTransformServices(engine);
    const symbols = symbolsTransformer();
    const budget = {
      maxTokens: 512,
      specialTokens: 2,
      count: (t: string) => t.split(/\s+/).length,
    };

    const ws = await Workspace.open({ root: nanoGptRoot });
    const cards: Array<{ text: string; name: string; path: string }> = [];
    const skipped: unknown[] = [];

    for await (const file of walkSources(ws)) {
      if (!/\.py$/.test(file.path)) continue;
      const content = await readSource(nanoGptRoot, file.path);
      if (content.kind !== 'text') continue;

      const input = inputFile(file.path, content.content);
      if (!symbols.claim(input)) continue;
      try {
        const drafts = await symbols.transform(input, {
          services,
          deadline: Deadline.unbounded(),
          budget,
        });
        for (const d of drafts) {
          cards.push({ text: d.text, name: d.attrs?.symbol ?? d.key, path: file.path });
        }
      } catch (failure) {
        skipped.push(failure);
      }
    }

    expect(cards.length).toBeGreaterThan(20);

    const modelSpec = builtinModel('all-MiniLM-L6-v2');
    expect(modelSpec).toBeDefined();
    if (!modelSpec) return;
    const embedder = await openLocalEmbedder(modelSpec);

    try {
      const cardTexts = cards.map((c) => c.text);
      const rawVectors = await embedAll(embedder, cardTexts);
      const centroid = computeCentroid(rawVectors);
      const calVectors = calibrateBatchCentroid(rawVectors, centroid);

      // Test real retrieval query: "adamw weight decay learning rate schedule"
      const query = 'adamw weight decay learning rate schedule';
      const [qRaw] = await embedder.embed([query]);
      expect(qRaw).toBeDefined();
      if (!qRaw) return;

      const qCal = calibrateCentroid(qRaw, centroid);

      const rawScores = rawVectors
        .map((v, i) => ({ sim: dot(qRaw, v), name: cards[i]?.name, path: cards[i]?.path }))
        .sort((a, b) => b.sim - a.sim);

      const calScores = calVectors
        .map((v, i) => ({ sim: dot(qCal, v), name: cards[i]?.name, path: cards[i]?.path }))
        .sort((a, b) => b.sim - a.sim);

      // Both identify get_lr as top hit
      expect(rawScores[0]?.name).toBe('get_lr');
      expect(calScores[0]?.name).toBe('get_lr');

      const rawGap = (rawScores[0]?.sim ?? 0) - (rawScores[1]?.sim ?? 0);
      const calGap = (calScores[0]?.sim ?? 0) - (calScores[1]?.sim ?? 0);

      // Calibrated representation dramatically expands the contrast margin over runner-up
      expect(calGap).toBeGreaterThan(rawGap * 1.3);
    } finally {
      await embedder.dispose();
      await runtime.dispose();
    }
  }, 25000);
});
