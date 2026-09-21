import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import type { SymbolFact } from '@sutras/code-lens-indexer';
import {
  ModelCache,
  modelsDirectory,
  openProjectEmbedder,
  Retriever,
} from '@sutras/code-lens-retriever';
import {
  type EvalQuery,
  generateQueries,
  type Population,
  percentile,
  rankOf,
  score,
} from './retrieval.ts';

const CUTOFFS = [1, 5, 10, 20, 50] as const;
/** Deepest cutoff reported: a search is asked for this many results so every cutoff can be read. */
const DEPTH = Math.max(...CUTOFFS);

/** A way of answering a query, and the files it returned in order. */
interface Lane {
  readonly name: string;
  readonly populations: readonly Population[];
  answer(query: EvalQuery): Promise<readonly string[]>;
}

interface Result {
  readonly lane: string;
  readonly population: Population;
  readonly score: ReturnType<typeof score>;
  readonly p50: number | undefined;
  readonly p95: number | undefined;
  readonly missed: readonly string[];
}

const pad = (text: string, width: number): string => text.padStart(width);

function render(header: readonly string[], results: readonly Result[]): string {
  const lines = [
    ...header,
    '',
    [
      'lane'.padEnd(18),
      'population'.padEnd(11),
      pad('n', 5),
      ...CUTOFFS.map((k) => pad(`R@${k}`, 6)),
      pad('MRR', 6),
      pad('p50 ms', 7),
      pad('p95 ms', 7),
    ].join('  '),
  ];
  for (const r of results) {
    lines.push(
      [
        r.lane.padEnd(18),
        r.population.padEnd(11),
        pad(String(r.score.queries), 5),
        ...CUTOFFS.map((k) => pad(((r.score.recall.get(k) ?? 0) * 100).toFixed(1), 6)),
        pad(r.score.mrr.toFixed(3), 6),
        pad((r.p50 ?? 0).toFixed(0), 7),
        pad((r.p95 ?? 0).toFixed(0), 7),
      ].join('  '),
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      scope: { type: 'string' },
      model: { type: 'string' },
      models: { type: 'string' },
      queries: { type: 'string' },
      json: { type: 'string' },
      db: { type: 'string' },
    },
  });
  if (values.repo === undefined) {
    throw new InvalidArgumentError('--repo', 'the path of a repository to evaluate', undefined);
  }
  const root = resolve(values.repo);
  const scope = values.scope?.replace(/\/$/, '');
  const perPopulation = values.queries === undefined ? undefined : Number(values.queries);

  const cache = new ModelCache(
    values.models ? resolve(values.models) : modelsDirectory(process.env),
  );
  const opened = await openProjectEmbedder(
    { model: values.model, channels: {}, fusionK: undefined },
    cache,
  );
  const embedder = opened.embedder;
  if (!embedder) {
    throw new InvalidArgumentError('--models', 'a directory holding a model', opened.reason);
  }

  const databasePath = values.db
    ? resolve(values.db)
    : join(mkdtempSync(join(tmpdir(), 'code-lens-retrieval-eval-')), 'index.db');
  const retriever = await Retriever.open({ root, embedder, databasePath });
  try {
    const started = performance.now();
    const indexed = await retriever.index({
      ...(scope ? { scope: (path: string) => path === scope || path.startsWith(`${scope}/`) } : {}),
    });
    const indexMs = performance.now() - started;

    const symbols: SymbolFact[] = [];
    let cursor: string | undefined;
    do {
      const page = await retriever.store.files({
        status: 'indexed',
        ...(cursor ? { cursor } : {}),
      });
      for (const file of page.items) {
        symbols.push(...((await retriever.store.facts(file.path))?.symbols ?? []));
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const queries = generateQueries(symbols, {
      minWords: 3,
      ...(perPopulation === undefined ? {} : { perPopulation }),
    });

    const lanes: Lane[] = [
      {
        name: 'dense (symbols)',
        populations: ['identifier', 'intent'],
        answer: async (q) =>
          (await retriever.retrieve('symbols', q.text, { limit: DEPTH })).items.map(
            (hit) => hit.card.source.path,
          ),
      },
      {
        name: 'fused',
        populations: ['identifier', 'intent', 'exact-name'],
        answer: async (q) =>
          (await retriever.search(q.text, { limit: DEPTH })).items.map((hit) => hit.path),
      },
      {
        name: 'fused (no docs)',
        populations: ['identifier', 'intent', 'exact-name'],
        answer: async (q) =>
          (await retriever.search(q.text, { limit: DEPTH, channels: ['symbols'] })).items.map(
            (hit) => hit.path,
          ),
      },
      {
        name: 'structural (WQL)',
        populations: ['exact-name'],
        answer: async (q) =>
          (await retriever.query(q.text, { limit: DEPTH })).items.flatMap((hit) =>
            hit.path === undefined ? [] : [hit.path],
          ),
      },
    ];

    const results: Result[] = [];
    for (const lane of lanes) {
      for (const population of lane.populations) {
        const ranks: (number | undefined)[] = [];
        const timings: number[] = [];
        const missed: string[] = [];
        for (const q of queries.filter((candidate) => candidate.population === population)) {
          const t0 = performance.now();
          const returned = await lane.answer(q);
          timings.push(performance.now() - t0);
          const rank = rankOf(returned, q.relevant);
          ranks.push(rank);
          if (rank === undefined) missed.push(q.text);
        }
        results.push({
          lane: lane.name,
          population,
          score: score(ranks, CUTOFFS),
          p50: percentile(timings, 0.5),
          p95: percentile(timings, 0.95),
          missed,
        });
      }
    }

    const counts = (['identifier', 'intent', 'exact-name'] as const).map(
      (p) => `${p} ${queries.filter((q) => q.population === p).length}`,
    );
    process.stdout.write(
      render(
        [
          `code-lens retrieval evaluation: ${values.repo}${scope ? ` (${scope}/)` : ''}`,
          `model ${embedder.info.id} (${opened.reason})`,
          `indexed ${indexed.report.files.added} files, ${indexed.report.dense?.cards ?? 0} cards in ${(indexMs / 1000).toFixed(1)} s`,
          `queries: ${counts.join(', ')}`,
        ],
        results,
      ),
    );

    if (values.json) {
      mkdirSync(dirname(resolve(values.json)), { recursive: true });
      const body = {
        repository: values.repo,
        model: embedder.info.id,
        results: results.map((r) => ({
          lane: r.lane,
          population: r.population,
          queries: r.score.queries,
          recall: Object.fromEntries(r.score.recall),
          mrr: r.score.mrr,
          p50Ms: r.p50,
          p95Ms: r.p95,
          missed: r.missed,
        })),
      };
      writeFileSync(resolve(values.json), `${JSON.stringify(body, null, 2)}\n`);
    }
  } finally {
    await retriever.close();
    await embedder.dispose();
  }
}

await main();
