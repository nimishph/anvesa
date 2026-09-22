#!/usr/bin/env bun
/**
 * Run the packaged program the way a user would, on a small project: version, grammars, index,
 * a structural query and an MCP handshake. With `CODE_LENS_SMOKE_MODELS` (a models directory) and
 * `CODE_LENS_SMOKE_MODEL` (a model id) it also indexes densely and searches, which proves the ONNX
 * runtime loads from the `runtime/` folder.
 *
 *   bun run tooling/smoke-package.ts [--dist dist]
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@cntxt-labs/code-lens-core';

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({ options: { dist: { type: 'string' } } });
const dist = resolve(root, values.dist ?? 'dist');
const unpacked = readdirSync(dist, { withFileTypes: true }).find(
  (entry) => entry.isDirectory() && entry.name.startsWith('code-lens-'),
);
if (!unpacked)
  throw new InvalidArgumentError('--dist', 'a folder holding a packaged program', dist);
const program = join(
  dist,
  unpacked.name,
  process.platform === 'win32' ? 'code-lens.exe' : 'code-lens',
);

const project = mkdtempSync(join(tmpdir(), 'code-lens-smoke-'));
mkdirSync(join(project, 'src'));
writeFileSync(join(project, 'package.json'), '{"name":"smoke"}');
writeFileSync(
  join(project, 'src', 'config.ts'),
  '/** Parse the configuration text into settings. */\nexport function parseConfig(text: string) { return text; }\n',
);

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(args: readonly string[]): Promise<Ran> {
  const child = Bun.spawn({
    cmd: [program, ...args],
    cwd: project,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

const failures: string[] = [];
function expect(step: string, ok: boolean, ran?: Ran): void {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${step}\n`);
  if (!ok) failures.push(`${step}${ran ? `\n${ran.out}\n${ran.err}` : ''}`);
}

try {
  const version = await run(['--version']);
  expect(
    'prints a version',
    version.code === 0 && /^code-lens \d+\.\d+\.\d+/.test(version.out),
    version,
  );

  const grammars = await run(['grammar', 'list', '--json']);
  expect(
    'carries the TypeScript grammar',
    grammars.out.includes('"embedded"') || /typescript[\s\S]*ready/.test(grammars.out),
    grammars,
  );

  const indexed = await run(['index', '--no-embed']);
  expect(
    'indexes a TypeScript file',
    indexed.code === 0 && indexed.out.includes('1 added'),
    indexed,
  );

  const queried = await run(['query', '//function[@name="parseConfig"]']);
  expect(
    'answers a structural query',
    queried.code === 0 && queried.out.includes('src/config.ts:2'),
    queried,
  );

  const models = process.env.CODE_LENS_SMOKE_MODELS;
  const model = process.env.CODE_LENS_SMOKE_MODEL;
  if (models && model) {
    const dense = await run(['index', '--force', '--models', models, '--model', model]);
    expect('embeds with the packaged ONNX runtime', dense.code === 0, dense);
    const found = await run([
      'search',
      'parse the configuration text',
      '--models',
      models,
      '--model',
      model,
    ]);
    expect('finds it by meaning', found.code === 0 && found.out.includes('parseConfig'), found);
  }

  const server = Bun.spawn({
    cmd: [program, 'mcp', 'serve', '--no-embed'],
    cwd: project,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const send = (message: unknown) => server.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await server.stdin.flush();
  const reader = server.stdout.getReader();
  let seen = '';
  const decoder = new TextDecoder();
  while (!seen.includes('"id":2')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    seen += decoder.decode(chunk.value);
  }
  expect('serves MCP tools', seen.includes('retrieve_symbols') && seen.includes('"name":"query"'), {
    code: 0,
    out: seen,
    err: '',
  });
  await server.stdin.end();
  // Closing its input is how a client leaves; the server must exit on its own, or release fails.
  const exited = await Promise.race([server.exited, Bun.sleep(10_000).then(() => undefined)]);
  expect('exits when its client goes away', exited === 0);
  if (exited === undefined) {
    server.kill();
    await server.exited;
  }
} finally {
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
