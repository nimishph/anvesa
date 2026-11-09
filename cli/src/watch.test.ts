import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InvariantViolationError } from '@cntxt-labs/anvesa-core';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';

const roots: string[] = [];

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 100));
  for (const root of roots.splice(0)) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

function makeProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'anvesa-watch-test-'));
  roots.push(root);

  const initial = {
    'package.json': '{"name":"watch-demo"}',
    '.anvesa/workspace.json': '{"version":1}',
    '.anvesa/config.json': '{"channels":{}}',
    'src/index.ts': 'export const answer = 42;\n',
    'src/util.ts': 'export function helper(): string { return "ok"; }\n',
    ...files,
  };

  for (const [path, content] of Object.entries(initial)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }

  return root;
}

async function run(root: string, ...args: string[]) {
  let stdout = '';
  let stderr = '';

  const env: Environment = {
    cwd: root,
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    env: { ANVESA_NO_NETWORK: '1' },
    isTTY: false,
    columns: 80,
  };

  const code = await runCli(args, env);
  return { code, stdout, stderr };
}

/**
 * Run the command without waiting for it: `until(text)` resolves once its output contains `text`,
 * and `done` when it exits.
 */
function start(root: string, ...args: string[]) {
  let stdout = '';
  let stderr = '';
  const env: Environment = {
    cwd: root,
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    env: { ANVESA_NO_NETWORK: '1' },
    isTTY: false,
    columns: 80,
  };
  let exited = false;
  const done = runCli(args, env).then((code) => {
    exited = true;
    return { code, stdout, stderr };
  });
  const until = async (text: string): Promise<void> => {
    while (!stdout.includes(text)) {
      if (exited) {
        throw new InvariantViolationError(`watch exited before printing "${text}"`, {
          context: { stdout, stderr },
        });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { done, until };
}

describe('anvesa watch CLI command', () => {
  it('displays detailed help with anvesa watch --help', async () => {
    const root = makeProject();
    const result = await run(root, 'watch', '--help');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('watch [path]');
    expect(result.stdout).toContain('--debounce');
    expect(result.stdout).toContain('--once');
    expect(result.stdout).toContain('--no-initial');
    expect(result.stdout).toContain('--json');
  });

  it('runs initial index and exits cleanly with --once --no-embed', async () => {
    const root = makeProject();
    const result = await run(root, 'watch', '--once', '--no-embed');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('anvesa watch: watching');
    expect(result.stdout).toContain('initial index pass starting');
    expect(result.stdout).toContain('index up to date');
  });

  it('streams JSON lines with --once --json --no-embed', async () => {
    const root = makeProject();
    const result = await run(root, 'watch', '--once', '--json', '--no-embed');

    expect(result.code).toBe(0);
    const lines = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines.some((l: { kind: string }) => l.kind === 'ready')).toBe(true);
    expect(lines.some((l: { kind: string }) => l.kind === 'index-complete')).toBe(true);
    expect(lines.some((l: { kind: string }) => l.kind === 'closed')).toBe(true);
  });

  it('detects file modifications and triggers incremental index', async () => {
    const root = makeProject();

    // --once exits after the first batch of changes. The debounce is wide enough that a late event
    // for the files makeProject wrote (macOS delivers some) lands in the same batch as ours.
    const watching = start(
      root,
      'watch',
      '--debounce',
      '500',
      '--no-initial',
      '--once',
      '--no-embed',
    );

    // `ready` is printed once the watcher listens: a change made after it is caught.
    await watching.until('anvesa watch: watching');
    writeFileSync(
      join(root, 'src/new-feature.ts'),
      'export function greet(): string { return "hello from watch"; }\n',
      'utf8',
    );

    const result = await watching.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('change detected: src/new-feature.ts');
    expect(result.stdout).toContain('index up to date');
  }, 30_000);
});
