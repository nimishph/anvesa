import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Deadline } from '@cntxt-labs/anvesa-core';
import {
  type CardDraft,
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

interface ExtractedCard {
  readonly path: string;
  readonly card: CardDraft;
}

interface BenchmarkRepoConfig {
  readonly name: string;
  readonly path: string;
  readonly filePattern: RegExp;
  readonly sampleQueries: readonly string[];
}

const DEFAULT_REPOS: readonly BenchmarkRepoConfig[] = [
  {
    name: 'vercel/commerce (E-Commerce Webapp)',
    path: 'eval/fixtures/commerce',
    filePattern: /\.(tsx?|jsx?)$/,
    sampleQueries: [
      'shopping cart items and checkout',
      'shopify product variant price and inventory',
      'cookies session authentication token',
    ],
  },
  {
    name: 'karpathy/nanoGPT (PyTorch Generative Pretraining)',
    path: 'eval/fixtures/nanoGPT',
    filePattern: /\.py$/,
    sampleQueries: [
      'multi-head causal self attention layer',
      'adamw weight decay learning rate schedule',
      'cross entropy loss and next token prediction',
    ],
  },
];

async function extractRepoCards(
  root: string,
  pattern: RegExp,
  services: ReturnType<typeof createTransformServices>,
  options: { readonly graphPreamble?: boolean } = {},
): Promise<readonly ExtractedCard[]> {
  const ws = await Workspace.open({ root });
  const symbols = symbolsTransformer({
    ...(options.graphPreamble ? { graphPreamble: true } : {}),
  });
  const budget = { maxTokens: 512, specialTokens: 2, count: (t: string) => t.split(/\s+/).length };
  const cards: ExtractedCard[] = [];

  for await (const file of walkSources(ws)) {
    if (!pattern.test(file.path)) continue;
    const content = await readSource(root, file.path);
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
        cards.push({ path: file.path, card: d });
      }
    } catch (failure) {
      process.stderr.write(`Skipped ${file.path}: ${String(failure)}\n`);
    }
  }

  return cards;
}

export async function benchmarkRepository(
  config: BenchmarkRepoConfig,
  services: ReturnType<typeof createTransformServices>,
): Promise<void> {
  const fullPath = resolve(config.path);
  if (!existsSync(fullPath)) {
    process.stdout.write(`\n[SKIPPED] Repository not found at ${config.path}\n`);
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(
    '================================================================================\n',
  );
  process.stdout.write(`  REAL-WORLD BENCHMARK: ${config.name}\n`);
  process.stdout.write(`  Location: ${config.path}\n`);
  process.stdout.write(
    '================================================================================\n',
  );

  // 1. AST Extraction
  const cards = await extractRepoCards(config.path, config.filePattern, services);
  const cardTexts = cards.map((c) => c.card.text);

  if (cardTexts.length === 0) {
    process.stdout.write('No symbol cards extracted from repository.\n');
    return;
  }

  // 2. Open Local Neural Embedder
  const modelSpec = builtinModel('all-MiniLM-L6-v2');
  if (!modelSpec) {
    process.stderr.write('Model all-MiniLM-L6-v2 not found\n');
    return;
  }
  const embedder = await openLocalEmbedder(modelSpec);

  try {
    const rawLengths = cardTexts.map((text) => Math.max(1, embedder.count(text)));
    const sortedLengths = [...rawLengths].sort((a, b) => a - b);
    const minLen = sortedLengths[0] ?? 0;
    const maxLen = sortedLengths[sortedLengths.length - 1] ?? 0;
    const medianLen = sortedLengths[Math.floor(sortedLengths.length / 2)] ?? 0;
    const actualTokens = rawLengths.reduce((acc, l) => acc + l, 0);

    process.stdout.write('\n1. REAL AST SYMBOL EXTRACTION & TOKEN DISTRIBUTION\n');
    process.stdout.write(
      '--------------------------------------------------------------------------------\n',
    );
    process.stdout.write(`• Extracted Real Code Cards:       ${cards.length} symbols\n`);
    process.stdout.write(
      `• Total Real Content Tokens:       ${actualTokens.toLocaleString()} tokens\n`,
    );
    process.stdout.write(
      `• Sequence Length Range:           [min: ${minLen}, median: ${medianLen}, max: ${maxLen}] tokens\n`,
    );

    // 3. Length-Sorted Dynamic Batching
    const batchSize = 16;
    let linearPaddedTokens = 0;
    for (let i = 0; i < rawLengths.length; i += batchSize) {
      const slice = rawLengths.slice(i, i + batchSize);
      const batchMax = Math.max(...slice);
      linearPaddedTokens += slice.length * batchMax;
    }

    const linearStart = performance.now();
    const linearVectors = await embedAll(embedder, cardTexts);
    const linearMs = performance.now() - linearStart;

    let bucketedStats:
      | {
          linearPaddedTokens: number;
          bucketedPaddedTokens: number;
          paddingComputeReduction: number;
        }
      | undefined;
    const bucketStart = performance.now();
    const bucketedVectors = await embedAllBucketed(embedder, cardTexts, {
      onStats: (stats) => {
        bucketedStats = stats;
      },
    });
    const bucketMs = performance.now() - bucketStart;

    const actualBucketPadded = bucketedStats?.bucketedPaddedTokens ?? 0;
    const linearWaste = linearPaddedTokens - actualTokens;
    const bucketWaste = actualBucketPadded - actualTokens;
    const wasteEliminatedPct =
      linearWaste > 0 ? Math.max(0, (linearWaste - bucketWaste) / linearWaste) * 100 : 0;
    const paddingReductionPct =
      linearPaddedTokens > 0
        ? ((linearPaddedTokens - actualBucketPadded) / linearPaddedTokens) * 100
        : 0;

    // Numerical parity check
    let maxDelta = 0;
    for (let i = 0; i < cardTexts.length; i++) {
      const lin = linearVectors[i];
      const bkt = bucketedVectors[i];
      if (!lin || !bkt) continue;
      for (let d = 0; d < lin.length; d++) {
        const delta = Math.abs((lin[d] ?? 0) - (bkt[d] ?? 0));
        if (delta > maxDelta) maxDelta = delta;
      }
    }

    process.stdout.write('\n2. REAL-WORLD DYNAMIC LENGTH-SORTED BUCKET BATCHING\n');
    process.stdout.write(
      '--------------------------------------------------------------------------------\n',
    );
    process.stdout.write(
      `• Actual Content Tokens:           ${actualTokens.toLocaleString()} tokens\n`,
    );
    process.stdout.write(
      `• Linear Batch Padded Tokens:      ${linearPaddedTokens.toLocaleString()} tokens (waste: ${linearWaste.toLocaleString()})\n`,
    );
    process.stdout.write(
      `• Length-Sorted Padded Tokens:     ${actualBucketPadded.toLocaleString()} tokens (waste: ${bucketWaste.toLocaleString()})\n`,
    );
    process.stdout.write(`• Zero-Padding Waste Eliminated:   ${wasteEliminatedPct.toFixed(2)}%\n`);
    process.stdout.write(`• Total Padded Compute Reduced:    ${paddingReductionPct.toFixed(2)}%\n`);
    process.stdout.write(`• Linear Batch Latency:            ${linearMs.toFixed(2)} ms\n`);
    process.stdout.write(`• Bucketed Batch Latency:          ${bucketMs.toFixed(2)} ms\n`);
    process.stdout.write(
      `• Vector Index Parity:             ${maxDelta < 1e-6 ? 'EXACT PARITY (max delta = 0.000000)' : `Delta: ${maxDelta}`}\n`,
    );

    // 4. Centroid Subtraction (Real Anisotropy Analysis)
    const beforeAnisotropy = measureAnisotropy(linearVectors);
    const codebaseCentroid = computeCentroid(linearVectors);
    const calibratedVectors = calibrateBatchCentroid(linearVectors, codebaseCentroid);
    const afterAnisotropy = measureAnisotropy(calibratedVectors);

    const varianceGain = afterAnisotropy.stdCosine / (beforeAnisotropy.stdCosine || 1e-6);

    process.stdout.write('\n3. REAL-WORLD VECTOR CENTROID SUBTRACTION (ANISOTROPY CONE)\n');
    process.stdout.write(
      '--------------------------------------------------------------------------------\n',
    );
    process.stdout.write(
      `• Model & Dimensions:              ${modelSpec.id} (${modelSpec.dimensions} dims)\n`,
    );
    process.stdout.write(
      `• Codebase Centroid L2 Norm:       ${beforeAnisotropy.centroidNorm.toFixed(4)}\n`,
    );
    process.stdout.write('• Raw Vector Distribution:\n');
    process.stdout.write(
      `    - Mean Cosine (μ):             ${beforeAnisotropy.meanCosine.toFixed(4)}\n`,
    );
    process.stdout.write(
      `    - Standard Deviation (σ):      ${beforeAnisotropy.stdCosine.toFixed(4)}\n`,
    );
    process.stdout.write(
      `    - Dynamic Range:               [${beforeAnisotropy.minCosine.toFixed(4)}, ${beforeAnisotropy.maxCosine.toFixed(4)}]\n`,
    );
    process.stdout.write('• Calibrated Vector Distribution:\n');
    process.stdout.write(
      `    - Mean Cosine (μ):             ${afterAnisotropy.meanCosine.toFixed(4)} (centered near origin)\n`,
    );
    process.stdout.write(
      `    - Standard Deviation (σ):      ${afterAnisotropy.stdCosine.toFixed(4)}\n`,
    );
    process.stdout.write(
      `    - Dynamic Range:               [${afterAnisotropy.minCosine.toFixed(4)}, ${afterAnisotropy.maxCosine.toFixed(4)}]\n`,
    );
    process.stdout.write(
      `• Angular Contrast Expansion:      ${varianceGain.toFixed(2)}x standard deviation expansion\n`,
    );

    // 5. Real Retrieval Query Evaluation
    process.stdout.write('\n4. REAL-WORLD RETRIEVAL & CONTRAST GAP EVALUATION\n');
    process.stdout.write(
      '--------------------------------------------------------------------------------\n',
    );

    for (const query of config.sampleQueries) {
      const [qRaw] = await embedder.embed([query]);
      if (!qRaw) continue;
      const qCal = calibrateCentroid(qRaw, codebaseCentroid);

      const rawRankings = linearVectors.map((v, i) => ({
        sim: dot(qRaw, v),
        name: cards[i]?.card.attrs?.symbol ?? cards[i]?.card.key ?? 'unknown',
        path: cards[i]?.path ?? '',
      }));
      rawRankings.sort((a, b) => b.sim - a.sim);

      const calRankings = calibratedVectors.map((v, i) => ({
        sim: dot(qCal, v),
        name: cards[i]?.card.attrs?.symbol ?? cards[i]?.card.key ?? 'unknown',
        path: cards[i]?.path ?? '',
      }));
      calRankings.sort((a, b) => b.sim - a.sim);

      const rawTop1 = rawRankings[0];
      const rawTop2 = rawRankings[1];
      const calTop1 = calRankings[0];
      const calTop2 = calRankings[1];

      const rawGap = (rawTop1?.sim ?? 0) - (rawTop2?.sim ?? 0);
      const calGap = (calTop1?.sim ?? 0) - (calTop2?.sim ?? 0);

      process.stdout.write(`Query: "${query}"\n`);
      process.stdout.write(
        `  • [Raw Embedding] Top-1:   ${rawTop1?.name} (${rawTop1?.path}) | score: ${rawTop1?.sim.toFixed(4)} | gap: ${rawGap.toFixed(4)}\n`,
      );
      process.stdout.write(
        `  • [Calibrated]    Top-1:   ${calTop1?.name} (${calTop1?.path}) | score: ${calTop1?.sim.toFixed(4)} | gap: ${calGap.toFixed(4)}\n`,
      );
    }
  } finally {
    await embedder.dispose();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      all: { type: 'boolean' },
    },
    strict: false,
  });

  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  const engine = new StructuralEngine({ runtime });
  const services = createTransformServices(engine);

  try {
    const repoArg = typeof values.repo === 'string' ? values.repo : undefined;
    if (repoArg) {
      const config: BenchmarkRepoConfig = {
        name: repoArg,
        path: repoArg,
        filePattern: /\.(tsx?|jsx?|py)$/,
        sampleQueries: [
          'main entrypoint or configuration',
          'core handler or service method',
          'data processing or model pipeline',
        ],
      };
      await benchmarkRepository(config, services);
    } else {
      for (const repo of DEFAULT_REPOS) {
        await benchmarkRepository(repo, services);
      }
    }
  } finally {
    await runtime.dispose();
  }
}

await main();
