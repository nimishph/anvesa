import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Deadline, InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  budgetFor,
  budgetSourceOf,
  calibrateBatchCentroid,
  calibrateCentroid,
  computeCentroid,
  createTransformServices,
  dot,
  type Embedder,
  embedAll,
  inputFile,
  measureAnisotropy,
  symbolsTransformer,
  type Transformer,
} from '@cntxt-labs/anvesa-dense';
import { builtinModel, ModelCache, openLocalEmbedder } from '@cntxt-labs/anvesa-embedder';
import { readSource, type SymbolFact, Workspace, walkSources } from '@cntxt-labs/anvesa-indexer';
import { outlineSymbols, StructuralEngine } from '@cntxt-labs/anvesa-structural';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import { type Fixture, fixturePath, fixtureReady, loadFixtures } from './fixtures.ts';
import { type EvalQuery, generateQueries, type Population, rankOf, score } from './retrieval.ts';

/**
 *   bun run eval:fixtures                       # once: fetch the pinned repositories
 *   bun run eval:real [--model <id> ...] [--fixture <name> ...] [--json <path>]
 *
 * Whether centroid calibration and the graph preamble rank the right file higher, on real
 * repositories. Each repository's symbol cards are embedded with and without the preamble; each
 * set is searched as embedded and calibrated against its own centroid (the query with it). Queries
 * come from the code, as `eval:retrieval` makes them: a symbol's name split into words
 * (identifier), and the first sentence of its documentation without its name (intent). Scores are
 * recall at k and mean reciprocal rank of the file that defines the symbol.
 *
 * Intent queries are words from the symbol's own documentation, which its card holds, so they
 * measure how well a model matches a card's words more than how well it matches paraphrase.
 */

export const CUTOFFS = [1, 5, 10] as const;
const POPULATIONS: readonly Population[] = ['identifier', 'intent'];

export interface BenchCard {
  readonly path: string;
  readonly text: string;
}

/** Files in the order their best card scores against the query, each file once. */
export function rankFiles(
  query: Float32Array,
  cards: readonly BenchCard[],
  vectors: readonly Float32Array[],
): string[] {
  const best = new Map<string, number>();
  vectors.forEach((vector, i) => {
    const path = cards[i]?.path;
    if (path === undefined) return;
    const similarity = dot(query, vector);
    if (similarity > (best.get(path) ?? Number.NEGATIVE_INFINITY)) best.set(path, similarity);
  });
  return [...best].sort((a, b) => b[1] - a[1]).map(([path]) => path);
}

export interface VariantScore {
  readonly variant: string;
  readonly population: Population;
  readonly queries: number;
  readonly recall: Readonly<Record<number, number>>;
  readonly mrr: number;
}

/** Scores one way of searching on every query of one population. */
export function scoreVariant(
  variant: string,
  population: Population,
  queries: readonly { readonly query: EvalQuery; readonly vector: Float32Array }[],
  cards: readonly BenchCard[],
  vectors: readonly Float32Array[],
): VariantScore {
  const ranks = queries
    .filter((q) => q.query.population === population)
    .map((q) => rankOf(rankFiles(q.vector, cards, vectors), q.query.relevant));
  const scored = score(ranks, CUTOFFS);
  return {
    variant,
    population,
    queries: scored.queries,
    recall: Object.fromEntries(scored.recall),
    mrr: scored.mrr,
  };
}

interface Extracted {
  readonly plain: readonly BenchCard[];
  readonly preamble: readonly BenchCard[];
  readonly symbols: readonly SymbolFact[];
}

/** Symbol cards with and without the preamble, and the symbols queries are made from. */
async function extract(root: string, embedder: Embedder): Promise<Extracted> {
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  const services = createTransformServices(new StructuralEngine({ runtime }));
  const budget = budgetFor(budgetSourceOf(embedder));
  const plainTransformer = symbolsTransformer();
  const preambleTransformer = symbolsTransformer({ graphPreamble: true });
  const workspace = await Workspace.open({ root });
  const plain: BenchCard[] = [];
  const preamble: BenchCard[] = [];
  const symbols: SymbolFact[] = [];

  const cardsOf = async (transformer: Transformer, input: ReturnType<typeof inputFile>) =>
    (await transformer.transform(input, { services, deadline: Deadline.unbounded(), budget })).map(
      (draft) => ({ path: input.path, text: draft.text }),
    );

  for await (const file of walkSources(workspace)) {
    const content = await readSource(root, file.path);
    if (content.kind !== 'text') continue;
    const input = inputFile(file.path, content.content);
    if (!plainTransformer.claim(input)) continue;
    try {
      plain.push(...(await cardsOf(plainTransformer, input)));
      preamble.push(...(await cardsOf(preambleTransformer, input)));
      const encoded = await services.encode(input, { docs: true });
      for (const symbol of outlineSymbols(encoded.root)) {
        symbols.push({
          id: `${file.path}#${symbol.name}`,
          path: file.path,
          name: symbol.name,
          baseName: symbol.baseName,
          kind: symbol.kind,
          parentId: undefined,
          // A language with no export marker (Python) exports by convention: ask about its names too.
          exported: symbol.exported ?? true,
          startLine: 0,
          endLine: 0,
          signature: symbol.signature,
          doc: symbol.doc,
        });
      }
    } catch (failure) {
      // A file the parser cannot read is left out of both card sets alike.
      process.stderr.write(`skipped ${file.path}: ${String(failure)}\n`);
    }
  }
  return { plain, preamble, symbols };
}

export interface FixtureResult {
  readonly fixture: string;
  readonly commit: string;
  readonly model: string;
  readonly cards: number;
  readonly anisotropy: {
    readonly before: ReturnType<typeof measureAnisotropy>;
    readonly after: ReturnType<typeof measureAnisotropy>;
  };
  readonly scores: readonly VariantScore[];
}

export async function benchmarkFixture(
  fixture: Fixture,
  embedder: Embedder,
): Promise<FixtureResult> {
  const { plain, preamble, symbols } = await extract(fixturePath(fixture), embedder);
  if (plain.length === 0) {
    throw new InvalidArgumentError('fixture', 'a repository with symbol cards', fixture.name);
  }
  const queries = generateQueries(symbols, { minWords: 3 }).filter((q) =>
    POPULATIONS.includes(q.population),
  );
  // One at a time: the encoder is one session, and each call is already batched.
  const plainVectors = await embedAll(
    embedder,
    plain.map((card) => card.text),
  );
  const preambleVectors = await embedAll(
    embedder,
    preamble.map((card) => card.text),
  );
  const queryVectors = await embedAll(
    embedder,
    queries.map((q) => q.text),
  );

  const variants: { name: string; cards: readonly BenchCard[]; vectors: Float32Array[] }[] = [];
  const asked: { query: EvalQuery; vector: Float32Array }[][] = [];
  for (const [name, cards, vectors] of [
    ['plain', plain, plainVectors],
    ['preamble', preamble, preambleVectors],
  ] as const) {
    const centroid = computeCentroid(vectors);
    variants.push({ name, cards, vectors });
    asked.push(queries.map((query, i) => ({ query, vector: queryVectors[i] as Float32Array })));
    variants.push({
      name: `${name} + calibrated`,
      cards,
      vectors: calibrateBatchCentroid(vectors, centroid),
    });
    asked.push(
      queries.map((query, i) => ({
        query,
        vector: calibrateCentroid(queryVectors[i] as Float32Array, centroid),
      })),
    );
  }

  const scores: VariantScore[] = [];
  for (const population of POPULATIONS) {
    variants.forEach((variant, i) => {
      scores.push(
        scoreVariant(variant.name, population, asked[i] ?? [], variant.cards, variant.vectors),
      );
    });
  }
  return {
    fixture: fixture.name,
    commit: fixture.commit,
    model: embedder.info.id,
    cards: plain.length,
    anisotropy: {
      before: measureAnisotropy(plainVectors),
      after: measureAnisotropy(calibrateBatchCentroid(plainVectors, computeCentroid(plainVectors))),
    },
    scores,
  };
}

export function renderResult(result: FixtureResult): string {
  const lines = [
    `${result.fixture} @ ${result.commit} — ${result.model}, ${result.cards} cards`,
    `  mean cosine between cards ${result.anisotropy.before.meanCosine.toFixed(3)} → ${result.anisotropy.after.meanCosine.toFixed(3)} calibrated`,
    `  ${'variant'.padEnd(22)} ${'population'.padEnd(11)} ${'n'.padStart(4)} ${CUTOFFS.map((k) => `R@${k}`.padStart(6)).join(' ')} ${'MRR'.padStart(6)}`,
  ];
  for (const s of result.scores) {
    lines.push(
      `  ${s.variant.padEnd(22)} ${s.population.padEnd(11)} ${String(s.queries).padStart(4)} ${CUTOFFS.map((k) => ((s.recall[k] ?? 0) * 100).toFixed(1).padStart(6)).join(' ')} ${s.mrr.toFixed(3).padStart(6)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', multiple: true },
      fixture: { type: 'string', multiple: true },
      json: { type: 'string' },
    },
  });
  const models = values.model ?? ['all-MiniLM-L6-v2'];
  const fixtures = loadFixtures().filter(
    (fixture) => values.fixture === undefined || values.fixture.includes(fixture.name),
  );
  const cache = new ModelCache();
  const results: FixtureResult[] = [];
  for (const id of models) {
    const spec = builtinModel(id) ?? (await cache.findCustom(id));
    if (spec === undefined) throw new InvalidArgumentError('--model', 'a known model', id);
    const embedder = await openLocalEmbedder(spec, { cache });
    try {
      for (const fixture of fixtures) {
        if (!(await fixtureReady(fixture))) {
          process.stdout.write(
            `${fixture.name}: not fetched at ${fixture.commit}; run bun run eval:fixtures\n`,
          );
          continue;
        }
        const result = await benchmarkFixture(fixture, embedder);
        results.push(result);
        process.stdout.write(`\n${renderResult(result)}`);
      }
    } finally {
      await embedder.dispose();
    }
  }
  if (values.json) {
    mkdirSync(dirname(resolve(values.json)), { recursive: true });
    writeFileSync(resolve(values.json), `${JSON.stringify(results, null, 2)}\n`);
  }
}

if (import.meta.main) await main();
