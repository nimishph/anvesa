#!/usr/bin/env bun
/**
 * Time a full walk of a workspace (traversal, ignore rules, language, stat) — what an index run
 * with nothing changed spends before it reads anything.
 *
 *   bun run tooling/bench/walk.ts <root>
 *   bun run tooling/bench/walk.ts --make <dir> [files=30000]   builds a synthetic tree first
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceWalk, Workspace } from '../../indexer/src/index.ts';

const say = (text: string) =>
  process.stdout.write(`${text}
`);

let root = process.argv[2] as string;
if (root === '--make') {
  root = process.argv[3] as string;
  const files = Number(process.argv[4] ?? 30_000);
  writeFileSync(join(mkdirSync(root, { recursive: true }) ?? root, '.gitignore'), 'dist/\n*.log\n');
  for (let i = 0; i < files; i++) {
    const dir = join(root, `pkg${i % 50}`, `mod${(i >> 6) % 40}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `file${i}.${['ts', 'py', 'go', 'md'][i % 4]}`),
      `export const x${i} = ${i};\n`,
    );
  }
}
for (let run = 0; run < 3; run++) {
  const started = performance.now();
  const workspace = await Workspace.open({ root });
  const walk = new SourceWalk(workspace);
  let files = 0;
  for await (const _ of walk) files++;
  say(`walk ${files} files in ${(performance.now() - started).toFixed(0)} ms`);
}
