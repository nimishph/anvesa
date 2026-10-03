#!/usr/bin/env node
'use strict';
// SessionStart hook for the Claude Code plugin: refresh the project's anvesa index in the
// background, so search sees the code as it is now. It never delays the session: the index runs
// detached, and this returns at once. It only refreshes a project that already has an index (it
// does not index a repository uninvited), it runs with --no-network, and npx is kept to its cache.
//
// What it prints becomes context for Claude, so it prints only what is worth knowing: that there
// is no index yet, or that the previous background refresh failed. A refresh that worked is silent.
//
// The detached run is this same script with --run: it runs anvesa, waits, and records the outcome
// for the next session to read. The record lives in the plugin's data folder, one folder per
// project, so the plugin adds nothing to the repository.

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { command } = require('./mcp-server.cjs');

const STATUS_FILE = 'refresh.json';
const LOG_FILE = 'refresh.log';
/** Hex characters of a project path's hash naming its state folder. */
const PROJECT_KEY_CHARS = 16;
/** A run older than this is taken to have died, so a new one may start. */
const STALE_RUN_MS = 30 * 60 * 1000;

/** Where the refresh record for a project is kept: the plugin's data folder, else the system temp. */
function stateDir(env, root) {
  const key = createHash('sha256')
    .update(path.resolve(root))
    .digest('hex')
    .slice(0, PROJECT_KEY_CHARS);
  const base = env.CLAUDE_PLUGIN_DATA || path.join(tmpdir(), 'anvesa-plugin');
  return path.join(base, 'refresh', key);
}

function readStatus(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, STATUS_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeStatus(dir, status) {
  writeFileSync(path.join(dir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The end of the log, as one line, to say why a run failed. */
function why(dir) {
  try {
    const lines = readFileSync(path.join(dir, LOG_FILE), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    // An error often wraps onto a second line (Windows' 'is not recognized as ... / operable
    // program or batch file.'), so the reason is the last two lines.
    const WRAPPED_ERROR_LINES = 2;
    // biome-ignore lint/plugin: a one-line reason for a note; the whole log stays in refresh.log
    return lines.length === 0 ? 'no output' : lines.slice(-WRAPPED_ERROR_LINES).join(' ');
  } catch {
    return 'no output';
  }
}

/**
 * What to tell Claude and whether to start a refresh, from the project's state. Pure, for tests.
 */
function plan({ hasIndex, status, now, isAlive }) {
  if (!hasIndex) {
    return {
      note: 'anvesa: this project has no index yet. Build one (the anvesa index tool, or `anvesa index`) before relying on anvesa search.',
      start: false,
    };
  }
  if (status?.state === 'running' && now - status.startedAt < STALE_RUN_MS && isAlive(status.pid)) {
    return { start: false };
  }
  if (status?.state === 'failed') {
    return {
      note: `anvesa: the last background index refresh failed (${status.reason}); search may be stale. Run \`anvesa index\` to see why.`,
      start: true,
    };
  }
  return { start: true };
}

function main() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = stateDir(process.env, root);
  const decided = plan({
    hasIndex: existsSync(path.join(root, '.anvesa')),
    status: readStatus(dir),
    now: Date.now(),
    isAlive: alive,
  });
  if (decided.note) process.stdout.write(`${decided.note}\n`);
  if (!decided.start) return;
  const child = spawn(process.execPath, [__filename, '--run', root, dir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/** The detached run: index, wait, record. */
function run(root, dir) {
  mkdirSync(dir, { recursive: true });
  const chosen = command({
    env: process.env,
    platform: process.platform,
    node: process.execPath,
    root: path.resolve(__dirname, '..'),
    args: ['--root', root, '--no-network'],
    subcommand: ['index'],
    offline: true,
  });
  if (chosen.problem) {
    writeStatus(dir, { state: 'failed', reason: chosen.problem, at: Date.now() });
    return;
  }
  const log = openSync(path.join(dir, LOG_FILE), 'w');
  const startedAt = Date.now();
  writeStatus(dir, { state: 'running', pid: process.pid, startedAt });
  const [program, ...rest] = chosen.argv;
  const child = spawn(program, rest, {
    stdio: ['ignore', log, log],
    windowsHide: true,
    cwd: chosen.cwd,
  });
  child.on('error', (error) => {
    writeStatus(dir, { state: 'failed', reason: error.message, at: Date.now() });
  });
  child.on('exit', (code, signal) => {
    writeStatus(
      dir,
      code === 0
        ? { state: 'done', startedAt, at: Date.now() }
        : {
            state: 'failed',
            reason: signal ? `stopped by ${signal}` : `exit ${code}: ${why(dir)}`,
            at: Date.now(),
          },
    );
  });
}

module.exports = { plan, stateDir, STALE_RUN_MS };

if (require.main === module) {
  try {
    if (process.argv[2] === '--run') {
      const root = process.argv[3] ?? process.cwd();
      run(root, process.argv[4] ?? stateDir(process.env, root));
    } else main();
  } catch (error) {
    // A hook that throws would show as an error at session start; a short note is enough.
    if (process.argv[2] !== '--run') {
      process.stdout.write(
        `anvesa: could not start the background index refresh (${error.message}).\n`,
      );
    }
  }
}
