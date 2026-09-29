#!/usr/bin/env node
'use strict';
// The command a package manager links onto the PATH. The program itself is a compiled binary in
// a per-platform package (`@cntxt-labs/anvesa-<os>-<cpu>`), installed alongside this one because
// this package lists them all as optional dependencies and a package manager keeps only the one
// that matches the machine. This file finds it and runs it.

const { spawnSync } = require('node:child_process');
const { chmodSync } = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'];

/** The package that holds the program for a platform, or `undefined` when there is none. */
function platformPackage(platform, cpu) {
  const key = `${platform}-${cpu}`;
  return SUPPORTED.includes(key) ? `@cntxt-labs/anvesa-${key}` : undefined;
}

/** Where the installed program is, or why it cannot be found. */
function locate(platform, cpu, resolve) {
  const name = platformPackage(platform, cpu);
  if (name === undefined) {
    return {
      problem: `anvesa has no build for ${platform} on ${cpu}. It runs on: ${SUPPORTED.join(', ')}.`,
    };
  }
  const file = platform === 'win32' ? 'anvesa.exe' : 'anvesa';
  try {
    return { program: resolve(`${name}/bin/${file}`) };
  } catch (failure) {
    return {
      problem:
        `The ${name} package is not installed (${failure.code ?? failure.message}). ` +
        'It is an optional dependency of @cntxt-labs/anvesa: reinstall without --no-optional, or ' +
        `install ${name} directly.`,
    };
  }
}

/**
 * Restore the executable bit on the program, and say whether it worked.
 *
 * The published package is supposed to carry mode 0755, but it can still arrive without it: a build
 * artifact that dropped the mode before publishing, an install that strips permissions, or a copy
 * through a tool that does not keep them. The program is always a program, so the bit is safe to set
 * here: this is the difference between a `chmod` the user has to guess and a command that just runs.
 */
function makeExecutable(program) {
  try {
    chmodSync(program, 0o755);
    return true;
  } catch {
    return false;
  }
}

/** True when a spawn failed only because the file was not executable. */
function isPermissionFailure(error) {
  return error !== undefined && error !== null && error.code === 'EACCES';
}

function main() {
  const found = locate(process.platform, process.arch, require.resolve);
  if (found.problem !== undefined) {
    process.stderr.write(`anvesa: ${found.problem}\n`);
    process.exitCode = 1;
    return;
  }
  // The program looks for its runtime folder beside itself, not beside this file.
  const run = () =>
    spawnSync(found.program, process.argv.slice(2), { stdio: 'inherit', cwd: process.cwd() });

  let child = run();
  if (
    isPermissionFailure(child.error) &&
    process.platform !== 'win32' &&
    makeExecutable(found.program)
  ) {
    child = run();
  }
  if (child.error) {
    process.stderr.write(
      `anvesa: could not start ${path.basename(found.program)}: ${child.error.message}\n`,
    );
    if (isPermissionFailure(child.error)) {
      process.stderr.write(
        `hint: ${found.program} is not executable and anvesa could not make it so. ` +
          `Run: chmod +x "${found.program}"\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  if (child.signal) {
    process.kill(process.pid, child.signal);
    return;
  }
  process.exitCode = child.status ?? 1;
}

module.exports = { SUPPORTED, platformPackage, locate, makeExecutable, isPermissionFailure };

if (require.main === module) main();
