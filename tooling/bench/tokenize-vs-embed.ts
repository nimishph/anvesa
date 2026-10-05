#!/usr/bin/env bun
/**
 * How much of embedding is tokenizing: both timed over chunks of this repository's own source.
 *
 *   bun run tooling/bench/tokenize-vs-embed.ts [model=all-MiniLM-L6-v2] [chunks=512]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { MODEL_CATALOG, openLocalEmbedder } from '../../embedder/src/index.ts';

const say = (text: string) =>
  process.stdout.write(`${text}
`);

const modelId = process.argv[2] ?? 'all-MiniLM-L6-v2';
const wanted = Number(process.argv[3] ?? 512);
const root = resolve(import.meta.dir, '../..');
const texts: string[] = [];
const visit = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (texts.length >= wanted) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') visit(path);
    else if (entry.name.endsWith('.ts')) {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (let i = 0; i + 12 <= lines.length && texts.length < wanted; i += 12) {
        texts.push(lines.slice(i, i + 12).join('\n'));
      }
    }
  }
};
visit(join(root, 'retriever', 'src'));
visit(join(root, 'indexer', 'src'));

const spec = MODEL_CATALOG.find((m) => m.id === modelId);
if (!spec) throw new InvalidArgumentError('model', 'a model in the catalog', modelId);
const embedder = await openLocalEmbedder(spec);

let started = performance.now();
let tokens = 0;
for (let round = 0; round < 3; round++) for (const text of texts) tokens += embedder.count(text);
const tokenizeMs = (performance.now() - started) / 3;

started = performance.now();
await embedder.embed(texts.filter((text) => embedder.count(text) <= 250));
const embedMs = performance.now() - started;
say(
  `${texts.length} chunks, ${tokens / 3} tokens: tokenize ${tokenizeMs.toFixed(0)} ms, embed (incl. tokenize) ${embedMs.toFixed(0)} ms -> tokenizing is ${((100 * tokenizeMs) / embedMs).toFixed(1)}%`,
);
await (embedder as { dispose?: () => Promise<void> }).dispose?.();
