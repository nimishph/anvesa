#!/usr/bin/env bun
/**
 * Build the anvesa_napi addon for development and put it where the bridges look first:
 * `crates/anvesa-napi/anvesa_napi.node`. Cargo names the library after the platform
 * (anvesa_napi.dll, libanvesa_napi.so, libanvesa_napi.dylib); a require() needs `.node`.
 *
 *   bun run native:build
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';

const root = resolve(import.meta.dir, '..');
const build = Bun.spawnSync(['cargo', 'build', '-p', 'anvesa-napi', '--release'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const library =
  process.platform === 'win32'
    ? 'anvesa_napi.dll'
    : process.platform === 'darwin'
      ? 'libanvesa_napi.dylib'
      : 'libanvesa_napi.so';
const built = join(root, 'target', 'release', library);
if (!existsSync(built)) {
  throw new InvalidArgumentError(
    'native-addon',
    `target/release/${library} after cargo build`,
    built,
  );
}
const destination = join(root, 'crates', 'anvesa-napi', 'anvesa_napi.node');
copyFileSync(built, destination);
process.stdout.write(`${destination}\n`);
