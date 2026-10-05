#!/usr/bin/env node
'use strict';
// Starts anvesa's MCP server for the Claude Code plugin. An anvesa already installed (npm global
// or a release archive on the PATH) is used as it is; otherwise this plugin's own version is
// fetched with npx, so the plugin works before anything is installed. Nothing goes through a
// shell: on Windows npm's .cmd shims cannot be spawned without one, and project paths have
// spaces, so each program is found and run directly (JavaScript entry points with this node).

const { spawn } = require('node:child_process');
const { existsSync, readFileSync, realpathSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const PACKAGE = '@cntxt-labs/anvesa';

/** The plugin's anvesa version: the CLI package beside it, in the same checkout. */
function pluginVersion(root) {
  const manifest = path.join(root, 'cli', 'package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * How to run an installed anvesa found on PATH, as [program, ...leading args], or undefined.
 * npm installs a shim next to node_modules on Windows and a symlink to bin/anvesa.cjs elsewhere;
 * a release archive puts the compiled program itself on the PATH.
 */
function installed(env, platform, node) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    if (platform === 'win32') {
      const launcher = path.join(dir, 'node_modules', PACKAGE, 'bin', 'anvesa.cjs');
      if (existsSync(path.join(dir, 'anvesa.cmd')) && isFile(launcher)) return [node, launcher];
      if (isFile(path.join(dir, 'anvesa.exe'))) return [path.join(dir, 'anvesa.exe')];
      continue;
    }
    const candidate = path.join(dir, 'anvesa');
    if (!isFile(candidate)) continue;
    const real = realpathSync(candidate);
    return /\.c?js$/.test(real) ? [node, real] : [real];
  }
  return undefined;
}

/** npx, run by this node from the npm next to it, as [program, ...leading args], or undefined. */
function npx(node) {
  const prefix = path.dirname(node);
  for (const cli of [
    path.join(prefix, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(prefix, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ]) {
    if (isFile(cli)) return [node, cli];
  }
  return undefined;
}

/**
 * The command that runs anvesa with `subcommand` (MCP serving by default), or a problem to report.
 * `offline` keeps npx to its cache, for runs that must not reach the network.
 */
function command({
  env,
  platform,
  node,
  root,
  args,
  subcommand = ['mcp', 'serve'],
  offline = false,
}) {
  if (env.ANVESA_BIN) return { argv: [env.ANVESA_BIN, ...subcommand, ...args] };
  const found = installed(env, platform, node);
  if (found) return { argv: [...found, ...subcommand, ...args] };
  const fetch = npx(node);
  if (fetch) {
    const spec = `${PACKAGE}@${pluginVersion(root)}`;
    const mode = offline ? ['--offline'] : [];
    // npx prefers a package of that name in the working directory's project (anvesa's own
    // workspace, or a project that depends on it), so it runs from a neutral folder; the project
    // is always named with --root.
    return { argv: [...fetch, ...mode, '--yes', spec, ...subcommand, ...args], cwd: tmpdir() };
  }
  return {
    problem:
      'anvesa is not installed and npx was not found next to node. Install it with ' +
      `npm install -g ${PACKAGE}, or set ANVESA_BIN to the anvesa program.`,
  };
}

module.exports = { command, installed, npx, pluginVersion };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const chosen = command({
    env: process.env,
    platform: process.platform,
    node: process.execPath,
    root,
    args: process.argv.slice(2),
  });
  if (chosen.problem) {
    process.stderr.write(`anvesa plugin: ${chosen.problem}\n`);
    process.exit(1);
  }
  const [program, ...rest] = chosen.argv;
  const child = spawn(program, rest, { stdio: 'inherit', cwd: chosen.cwd });
  child.on('error', (error) => {
    process.stderr.write(`anvesa plugin: could not start ${program}: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
