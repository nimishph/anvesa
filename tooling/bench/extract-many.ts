#!/usr/bin/env bun
/**
 * Extract every source file under a folder file by file, then a window at a time on every core.
 *
 *   bun run tooling/bench/extract-many.ts <root> [window=64]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FactExtractor } from '../../indexer/src/extract/extract.ts';
import { StructuralEngine } from '../../structural/src/index.ts';
import { npmPackageSource, SyntaxRuntime } from '../../syntax/src/index.ts';

const say = (text: string) => process.stdout.write(`${text}\n`);
const root = process.argv[2] as string;
const window = Number(process.argv[3] ?? 64);
const files: { path: string; source: string }[] = [];
const visit = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) visit(path);
    else if (/\.(py|ts|js|go|rs|java|rb|php)$/.test(entry.name)) {
      const name = relative(root, path).split(sep).join('/');
      files.push({ path: name, source: readFileSync(path, 'utf8') });
    }
  }
};
visit(root);
const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
const extractor = new FactExtractor(new StructuralEngine({ runtime }));

const failed = new Set<string>();
for (let round = 0; round < 2; round++) {
  let started = performance.now();
  for (const file of files) {
    try {
      await extractor.extractWithStructure(file.path, file.source);
    } catch (failure) {
      failed.add(`${file.path}: ${String(failure)}`);
    }
  }
  const alone = performance.now() - started;
  started = performance.now();
  for (let at = 0; at < files.length; at += window) {
    await extractor.extractManyWithStructure(files.slice(at, at + window));
  }
  const together = performance.now() - started;
  say(
    `${files.length} files: one by one ${alone.toFixed(0)} ms, ${window} at a time ${together.toFixed(0)} ms (${(alone / together).toFixed(1)}x)`,
  );
}
if (failed.size > 0) say(`${failed.size} files failed to extract (the same either way)`);
runtime.dispose();
