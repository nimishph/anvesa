#!/usr/bin/env bun
/**
 * Time an exact vector search over a SQLite store of synthetic cards.
 *
 *   bun run tooling/bench/vector-search.ts [cards=100000] [dims=384] [file]
 *
 * Given a file that already holds the cards, it only searches; otherwise it fills it first.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '@cntxt-labs/anvesa-dense';
import { SqliteVectorStore, StoreDatabase } from '../../indexer/src/store/index.ts';

const say = (text: string) =>
  process.stdout.write(`${text}
`);

const cards = Number(process.argv[2] ?? 100_000);
const dims = Number(process.argv[3] ?? 384);
const file = process.argv[4] ?? join(tmpdir(), `anvesa-bench-${cards}-${dims}.sqlite`);
const perSource = 8;

let seed = 1;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};
const vector = () => Float32Array.from({ length: dims }, random);

const fresh = !existsSync(file);
const db = StoreDatabase.open(file);
const store = new SqliteVectorStore(db);
if (fresh) {
  const started = performance.now();
  for (let s = 0; s < cards / perSource; s++) {
    const path = `src/file${s}.ts`;
    await store.replaceSource({
      channel: 'code',
      path,
      model: 'bench',
      contentHash: String(s),
      transformerVersion: '1',
      quarantined: [],
      cards: Array.from({ length: perSource }, (_, i) => {
        const id = `${path}#${i}`;
        const card = {
          id,
          channel: 'code',
          categoryId: 'code.symbol',
          categoryLabel: 'symbol',
          text: `function f${i}() {}`,
          attrs: { group: String(i >> 1) },
          source: { path },
          provenance: {},
        } as unknown as Card;
        return { card, vector: vector() };
      }),
    });
  }
  say(`filled ${cards} cards x ${dims} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const query = vector();
for (const collapse of [false, true]) {
  const times: number[] = [];
  for (let run = 0; run < 7; run++) {
    const started = performance.now();
    await store.search(query, { channel: 'code', model: 'bench', limit: 20, collapse });
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const rss = process.memoryUsage().rss / 2 ** 20;
  say(
    `search collapse=${collapse}: median ${times[3]?.toFixed(1)} ms, best ${times[0]?.toFixed(1)} ms, rss ${rss.toFixed(0)} MB`,
  );
}
db.close();
