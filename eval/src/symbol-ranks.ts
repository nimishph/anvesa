/**
 * The symbols a project's search returns for many queries, one model load for all of them: what
 * anvesa-gen-lab's `bench.py score --anvesa` reads to score anvesa's own ranking (with the
 * project's `experimental.learnedRanker`, when it has one) against its hand-written queries.
 *
 *   bun run eval/src/symbol-ranks.ts <project root> [--limit 100] < queries.jsonl > ranks.jsonl
 *
 * Each input line is `{"id": "...", "q": "..."}`; each output line is
 * `{"id": "...", "symbols": ["path#Name", ...]}`, best first, from the symbols channel alone.
 * The project must be indexed already, with the model its config names installed.
 */
import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  loadProjectConfig,
  ModelCache,
  modelsDirectory,
  openProjectEmbedder,
  Retriever,
} from '@cntxt-labs/anvesa-retriever';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { limit: { type: 'string', default: '100' } },
  allowPositionals: true,
});
const root = positionals[0];
if (!root) throw new InvalidArgumentError('root', 'the project to search', undefined);
const limit = Number(values.limit);

const config = await loadProjectConfig(root);
const opened = await openProjectEmbedder(config, new ModelCache(modelsDirectory()));
if (!opened.embedder) throw new InvalidArgumentError('model', 'an installed model', opened.reason);
const retriever = await Retriever.open({ root, embedder: opened.embedder });
try {
  const input = await new Response(Bun.stdin.stream()).text();
  for (const line of input.split('\n')) {
    if (line.trim() === '') continue;
    const { id, q } = JSON.parse(line) as { id: string; q: string };
    const page = await retriever.search(q, { channels: ['symbols'], limit });
    const symbols = page.items.map((item) => item.key);
    process.stdout.write(`${JSON.stringify({ id, symbols })}\n`);
  }
} finally {
  await retriever.close();
}
