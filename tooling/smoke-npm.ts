#!/usr/bin/env bun
/**
 * Install the packages as a user's package manager would lay them out, and run the command that
 * `npm install -g @sutras/code-lens` would link: the launcher, which finds the program in the
 * platform package.
 *
 *   bun run tooling/smoke-npm.ts [--dist dist]
 *
 * It needs `bun run package` first. It does not touch the network: the two packages are copied
 * into a `node_modules` folder, which is the layout an install produces.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import { MAIN_PACKAGE, PLATFORMS, platformPackage } from './platforms.ts';

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({ options: { dist: { type: 'string' } } });
const dist = resolve(root, values.dist ?? 'dist');

const here = PLATFORMS.find((p) => p.os === process.platform && p.cpu === process.arch);
if (!here) {
  throw new InvalidArgumentError(
    'platform',
    PLATFORMS.map(platformPackage).join(', '),
    `${process.platform}-${process.arch}`,
  );
}
const platformFolder = join(dist, 'npm', platformPackage(here).split('/')[1] as string);
if (!readdirSync(dist).includes('npm')) {
  throw new InvalidArgumentError('--dist', 'a folder that `bun run package` has filled', dist);
}

const sandbox = mkdtempSync(join(tmpdir(), 'code-lens-npm-'));
try {
  const modules = join(sandbox, 'node_modules');
  cpSync(join(root, 'cli', 'bin'), join(modules, MAIN_PACKAGE, 'bin'), { recursive: true });
  cpSync(join(root, 'cli', 'package.json'), join(modules, MAIN_PACKAGE, 'package.json'));
  cpSync(platformFolder, join(modules, platformPackage(here)), { recursive: true });
  const project = join(sandbox, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"smoke"}');
  writeFileSync(join(project, 'src', 'a.ts'), 'export function launched() { return 1; }\n');

  const launcher = join(modules, MAIN_PACKAGE, 'bin', 'code-lens.cjs');
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn({
      cmd: ['node', launcher, ...args],
      cwd: project,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };

  const failures: string[] = [];
  const check = (step: string, ok: boolean, detail: string) => {
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${step}\n`);
    if (!ok) failures.push(`${step}\n${detail}`);
  };
  const version = await run(['--version']);
  check(
    'the launcher runs the program',
    version.code === 0 && /^code-lens \d/.test(version.out),
    version.err,
  );
  const indexed = await run(['index', '--no-embed']);
  check(
    'it indexes through the launcher',
    indexed.code === 0 && indexed.out.includes('1 added'),
    indexed.out + indexed.err,
  );
  const queried = await run(['query', '//function[@name="launched"]']);
  check(
    'it answers a query',
    queried.code === 0 && queried.out.includes('src/a.ts'),
    queried.out + queried.err,
  );
  const usage = await run(['frobnicate']);
  check('its exit code comes through', usage.code === 2, `exit ${usage.code}`);

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.join('\n\n')}\n`);
    process.exitCode = 1;
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
