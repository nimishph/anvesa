import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import type { SymbolFact } from '@sutras/code-lens-indexer';
import { type OursImport, scoreCalls, scoreImports, scoreSymbols } from './compare.ts';
import { indexRepository } from './indexing.ts';
import { renderReport, reportJson } from './report.ts';
import { buildTruth } from './truth.ts';

const DEFAULT_LANGUAGES = ['typescript', 'tsx', 'javascript'];
/** How many examples of each kind of miss the report prints. A display choice, not a limit on scoring. */
const DEFAULT_SAMPLES = 12;

async function git(root: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: ['git', '-C', root, ...args], stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(process.stdout).text();
  await process.exited;
  return text.trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      exclude: { type: 'string', multiple: true },
      languages: { type: 'string' },
      samples: { type: 'string' },
      json: { type: 'string' },
      db: { type: 'string' },
    },
  });
  if (values.repo === undefined) {
    throw new InvalidArgumentError('--repo', 'the path of a repository to evaluate', undefined);
  }
  const root = resolve(values.repo);
  const languages = values.languages?.split(',') ?? DEFAULT_LANGUAGES;
  const samples =
    values.samples === undefined ? DEFAULT_SAMPLES : Number.parseInt(values.samples, 10);
  const databasePath =
    values.db ?? join(mkdtempSync(join(tmpdir(), 'code-lens-eval-')), 'index.db');

  const run = await indexRepository({
    root,
    databasePath,
    languages,
    ...(values.exclude ? { exclude: values.exclude } : {}),
  });
  try {
    // What code-lens holds, read back from its store the way a query would.
    const symbols = new Map<string, readonly SymbolFact[]>();
    const imports = new Map<string, readonly OursImport[]>();
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await run.store.files({ status: 'indexed', ...(cursor ? { cursor } : {}) });
      for (const file of page.items) {
        paths.push(file.path);
        const facts = await run.store.facts(file.path);
        if (!facts) continue;
        symbols.set(file.path, facts.symbols);
        const resolved: OursImport[] = [];
        for (const fact of facts.imports) {
          const { resolution } = await run.resolver.resolve(file.path, fact, facts.language);
          resolved.push({ fact, resolution });
        }
        imports.set(file.path, resolved);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const truth = buildTruth(root, paths);
    const input = {
      repository: values.repo,
      revision: (await git(root, 'rev-parse', '--short', 'HEAD')) || 'unknown',
      run,
      truthMs: truth.programMs,
      truthFiles: truth.filesInProgram,
      symbols: scoreSymbols(truth.symbols, symbols),
      imports: scoreImports(truth.imports, imports),
      calls: scoreCalls(truth.calls, run.calls, symbols, { samplesPerCategory: samples }),
      samples,
    };

    process.stdout.write(renderReport(input));
    if (values.json) {
      mkdirSync(dirname(resolve(values.json)), { recursive: true });
      writeFileSync(resolve(values.json), `${JSON.stringify(reportJson(input), null, 2)}\n`);
    }
  } finally {
    await run.dispose();
  }
}

await main();
