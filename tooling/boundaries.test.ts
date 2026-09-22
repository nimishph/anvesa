import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InvariantViolationError } from '@cntxt-labs/code-lens-core';

/**
 * Proves the dependency rules in .dependency-cruiser.cjs reject what they claim to. A synthetic
 * package tree is cruised from its own directory, so the real packages are never touched.
 */

const workspace = join(import.meta.dir, '..');
const tree = join(import.meta.dir, 'probe', 'boundaries');
const config = join(workspace, '.dependency-cruiser.cjs');
const cruiser = join(
  workspace,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);

interface Violation {
  readonly rule: { readonly name: string };
  readonly from: string;
  readonly to: string;
}

function put(path: string, source: string): void {
  const full = join(tree, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source);
}

function cruise(): readonly Violation[] {
  const run = Bun.spawnSync({
    cmd: [
      process.execPath,
      cruiser,
      '--config',
      config,
      '--output-type',
      'json',
      'core/src',
      'syntax/src',
      'structural/src',
      'indexer/src',
      'retriever/src',
    ],
    cwd: tree,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = run.stdout.toString();
  try {
    const report = JSON.parse(stdout) as { summary: { violations: Violation[] } };
    return report.summary.violations;
  } catch (parseFailure) {
    throw new InvariantViolationError('dependency-cruiser did not return a JSON report', {
      cause: parseFailure,
      context: { stdout, stderr: run.stderr.toString() },
    });
  }
}

beforeAll(() => {
  mkdirSync(tree, { recursive: true });
  writeFileSync(
    join(tree, 'tsconfig.json'),
    '{"compilerOptions":{"allowImportingTsExtensions":true}}',
  );
});

afterAll(() => {
  rmSync(join(import.meta.dir, 'probe'), { recursive: true, force: true });
});

describe('package boundaries', () => {
  test('a legal graph has no violations', () => {
    put('core/src/index.ts', 'export const c = 1;\n');
    put('syntax/src/index.ts', "import '../../core/src/index.ts';\nexport const a = 1;\n");
    put('structural/src/index.ts', "import '../../syntax/src/index.ts';\nexport const w = 1;\n");
    put('indexer/src/index.ts', "import '../../structural/src/index.ts';\nexport const i = 1;\n");
    put('retriever/src/index.ts', "import '../../indexer/src/index.ts';\nexport const r = 1;\n");
    expect(cruise()).toEqual([]);
  });

  test('rejects a lower package importing a higher one', () => {
    put('core/src/index.ts', "import '../../retriever/src/index.ts';\nexport const c = 1;\n");
    const rules = cruise().map((v) => v.rule.name);
    expect(rules).toContain('core-allowed-deps');
  });

  test('rejects skipping the dependency direction', () => {
    put('core/src/index.ts', 'export const c = 1;\n');
    put('syntax/src/index.ts', "import '../../structural/src/index.ts';\nexport const a = 1;\n");
    const rules = cruise().map((v) => v.rule.name);
    expect(rules).toContain('syntax-allowed-deps');
  });

  test('rejects importing another package internals', () => {
    put('syntax/src/index.ts', "import '../../core/src/index.ts';\nexport const a = 1;\n");
    put('structural/src/internal.ts', 'export const secret = 1;\n');
    put(
      'indexer/src/index.ts',
      "import '../../structural/src/internal.ts';\nexport const i = 1;\n",
    );
    const rules = cruise().map((v) => v.rule.name);
    expect(rules).toContain('public-entry-only');
  });

  test('rejects circular imports', () => {
    put('indexer/src/index.ts', 'export const i = 1;\n');
    put('structural/src/a.ts', "import './b.ts';\nexport const a = 1;\n");
    put('structural/src/b.ts', "import './a.ts';\nexport const b = 1;\n");
    const rules = cruise().map((v) => v.rule.name);
    expect(rules).toContain('no-circular');
  });
});
