import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { type GoldenResult, loadSuites, renderGolden, runSuite } from './golden.ts';

/**
 *   bun run golden [--language php,python] [--require-all] [--json <path>]
 *
 * Runs the golden-query suites in `eval/golden/`. A suite whose grammar is not installed is
 * skipped and named; `--require-all` (or ANVESA_GOLDEN_REQUIRE=all) turns that into a failure, which
 * is what a release uses so that no language goes untested by accident. Exits 1 on any wrong answer.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      language: { type: 'string' },
      'require-all': { type: 'boolean' },
      json: { type: 'string' },
    },
  });
  const requireAll = values['require-all'] === true || process.env.ANVESA_GOLDEN_REQUIRE === 'all';
  const wanted = values.language?.split(',');
  const suites = loadSuites().filter(
    (suite) => wanted === undefined || wanted.includes(suite.language),
  );
  if (suites.length === 0) {
    throw new InvalidArgumentError('--language', 'a language that has a suite', values.language);
  }
  const results: GoldenResult[] = [];
  for (const suite of suites) results.push(await runSuite(suite, { requireAll }));
  process.stdout.write(renderGolden(results));
  if (values.json) await Bun.write(values.json, `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.some(
    (result) => result.state === 'ran' && result.outcomes.some((outcome) => !outcome.passed),
  );
  if (failed) process.exitCode = 1;
}

await main();
