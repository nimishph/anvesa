import { describe, expect, test } from 'bun:test';
import { type GoldenResult, loadSuites, renderGolden, runSuite } from './golden.ts';

/**
 * Runs every golden-query suite. TypeScript, JavaScript and Python parse from the grammars this
 * checkout installs, so they must run everywhere; a suite for a language whose grammar is only
 * installed on some machines (PHP, Go, ...) is skipped where it is missing, and `bun run golden`
 * with `--require-all` (what a release uses) refuses to skip.
 */
const ALWAYS_RUN = ['typescript', 'javascript', 'python'];

const suites = loadSuites();

describe('golden queries', () => {
  test('there is a suite for each language that must always run', () => {
    expect(suites.map((suite) => suite.language)).toEqual(expect.arrayContaining(ALWAYS_RUN));
  });

  for (const suite of suites) {
    test(`${suite.language}: ${suite.queries.length} queries answer exactly as written`, async () => {
      const result: GoldenResult = await runSuite(suite);
      if (result.state === 'skipped') {
        expect(ALWAYS_RUN).not.toContain(suite.language);
        return;
      }
      const failed = result.outcomes.filter((outcome) => !outcome.passed);
      expect(failed.length === 0 ? '' : renderGolden([result])).toBe('');
    }, 120_000);
  }
});
