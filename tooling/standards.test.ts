import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InvariantViolationError } from '@cntxt-labs/code-lens-core';

/**
 * Proves the standards enforcement (Biome rules plus the Grit plugins in tooling/plugins) does what
 * it claims. Every `fail-*` fixture must be rejected by the rule its name says; the `pass-*`
 * fixtures must lint clean. Fixtures are `.ts.txt` so nothing else lints or typechecks them.
 */

const workspace = join(import.meta.dir, '..');
const fixtures = join(import.meta.dir, 'fixtures');
const probe = join(import.meta.dir, 'probe');
const biomeEntry = import.meta.resolveSync('@biomejs/biome/bin/biome');

interface Diagnostic {
  readonly category: string;
  readonly severity: string;
  readonly description: string;
}

function lint(file: string): readonly Diagnostic[] {
  const run = Bun.spawnSync({
    cmd: [process.execPath, biomeEntry, 'lint', '--reporter=json', file],
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = run.stdout.toString();
  const start = stdout.indexOf('{"summary"');
  if (start < 0) {
    throw new InvariantViolationError(`biome produced no JSON report for ${file}`, {
      cause: run.stderr.toString(),
      context: { file, stdout },
    });
  }
  const report = JSON.parse(stdout.slice(start)) as { diagnostics: Diagnostic[] };
  return report.diagnostics.filter((d) => d.severity === 'error');
}

beforeAll(() => {
  mkdirSync(probe, { recursive: true });
  for (const name of readdirSync(fixtures)) {
    copyFileSync(join(fixtures, name), join(probe, name.replace(/\.txt$/, '')));
  }
});

afterAll(() => {
  rmSync(probe, { recursive: true, force: true });
});

const fixtureNames = readdirSync(fixtures)
  .map((name) => name.replace(/\.ts\.txt$/, ''))
  .sort();

/** fixture -> the diagnostic category that must be among the errors. */
const EXPECTED: Readonly<Record<string, string>> = {
  'fail-bare-error': 'plugin',
  'fail-bare-typeerror': 'plugin',
  'fail-slice-literal': 'plugin',
  'fail-substring-literal': 'plugin',
  'fail-slice-negative': 'plugin',
  'fail-math-min-cap': 'plugin',
  'fail-swallowed-rejection': 'plugin',
  'fail-swallowed-rejection-undefined': 'plugin',
  'fail-empty-catch': 'plugin',
  'fail-comment-only-catch': 'plugin',
  'fail-comment-only-catch-noparam': 'plugin',
  'fail-empty-catch-with-finally': 'plugin',
};

describe('standards enforcement', () => {
  test('every fixture is accounted for', () => {
    const failing = fixtureNames.filter((n) => n.startsWith('fail-'));
    expect(failing.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const name of fixtureNames.filter((n) => n.startsWith('fail-'))) {
    test(`rejects ${name}`, () => {
      const errors = lint(join('tooling', 'probe', `${name}.ts`));
      expect(errors.map((e) => e.category)).toContain(EXPECTED[name] as string);
    });
  }

  for (const name of fixtureNames.filter((n) => n.startsWith('pass-'))) {
    test(`accepts ${name}`, () => {
      const errors = lint(join('tooling', 'probe', `${name}.ts`));
      expect(errors.map((e) => `${e.category}: ${e.description}`)).toEqual([]);
    });
  }

  test('probe directory sits inside the workspace', () => {
    expect(dirname(probe)).toBe(join(workspace, 'tooling'));
  });
});
