import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The Claude Code plugin: its manifest stays in step with the package, and its MCP launcher. */

const root = resolve(import.meta.dir, '..');
const json = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));

type Argv = { argv?: string[]; problem?: string };
const launcher = createRequire(import.meta.url)('../plugin/mcp-server.cjs') as {
  command(options: {
    env: Record<string, string>;
    platform: string;
    node: string;
    root: string;
    args: string[];
  }): Argv;
};

const scratch = mkdtempSync(join(tmpdir(), 'anvesa-plugin-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function folder(...parts: string[]): string {
  const dir = join(scratch, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('plugin manifest', () => {
  test('carries the package version and starts the MCP server for the project', () => {
    const plugin = json('.claude-plugin/plugin.json');
    expect(plugin.version).toBe(json('cli/package.json').version);
    expect(plugin.mcpServers.anvesa).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/plugin/mcp-server.cjs', '--root', '${CLAUDE_PROJECT_DIR}'],
    });
  });
});

describe('MCP launcher', () => {
  const args = ['--root', '/work/project with spaces'];

  test('ANVESA_BIN wins', () => {
    const chosen = launcher.command({
      env: { ANVESA_BIN: '/opt/anvesa', PATH: '' },
      platform: 'linux',
      node: '/usr/bin/node',
      root,
      args,
    });
    expect(chosen.argv).toEqual(['/opt/anvesa', 'mcp', 'serve', ...args]);
  });

  test('a Windows npm global install runs its launcher with this node, no shell', () => {
    const bin = folder('win-global');
    writeFileSync(join(bin, 'anvesa.cmd'), '@echo off');
    const cjs = join(
      folder('win-global', 'node_modules', '@cntxt-labs', 'anvesa', 'bin'),
      'anvesa.cjs',
    );
    writeFileSync(cjs, '');
    const chosen = launcher.command({
      env: { PATH: bin },
      platform: 'win32',
      node: 'node.exe',
      root,
      args,
    });
    expect(chosen.argv).toEqual(['node.exe', cjs, 'mcp', 'serve', ...args]);
  });

  test('a release program on the PATH runs directly', () => {
    const bin = folder('release');
    writeFileSync(join(bin, 'anvesa'), '');
    const chosen = launcher.command({
      env: { PATH: bin },
      platform: 'linux',
      node: 'node',
      root,
      args,
    });
    expect(chosen.argv?.[0]).toBe(join(bin, 'anvesa'));
  });

  test.skipIf(process.platform === 'win32')(
    'an npm symlink runs its JavaScript with this node',
    () => {
      const target = join(folder('lib', 'anvesa', 'bin'), 'anvesa.cjs');
      writeFileSync(target, '');
      const bin = folder('unix-global');
      symlinkSync(target, join(bin, 'anvesa'));
      const chosen = launcher.command({
        env: { PATH: bin },
        platform: 'linux',
        node: 'node',
        root,
        args,
      });
      expect(chosen.argv?.slice(0, 2)).toEqual(['node', target]);
    },
  );

  test('otherwise npx fetches this plugin version', () => {
    const prefix = folder('node-prefix');
    const npx = join(folder('node-prefix', 'node_modules', 'npm', 'bin'), 'npx-cli.js');
    writeFileSync(npx, '');
    const node = join(prefix, 'node.exe');
    const chosen = launcher.command({ env: { PATH: '' }, platform: 'win32', node, root, args });
    expect(chosen.argv).toEqual([
      node,
      npx,
      '--yes',
      `@cntxt-labs/anvesa@${json('cli/package.json').version}`,
      'mcp',
      'serve',
      ...args,
    ]);
  });

  test('with nothing to run, it says what to install', () => {
    const chosen = launcher.command({
      env: { PATH: '' },
      platform: 'linux',
      node: join(folder('bare'), 'node'),
      root,
      args,
    });
    expect(chosen.problem).toContain('npm install -g @cntxt-labs/anvesa');
  });
});
