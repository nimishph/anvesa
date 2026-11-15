import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli } from './cli.ts';
import {
  compareVersions,
  refreshInstalledSkills,
  SKILL_TEXT,
  SKILL_VERSION,
  skillFile,
  skillVersion,
} from './skill.ts';
import { VERSION } from './version.ts';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(): { root: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'anvesa-skill-'));
  scratch.push(dir);
  const root = join(dir, 'project');
  mkdirSync(join(root, '.anvesa'), { recursive: true });
  const home = join(dir, 'home');
  return {
    root,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: '', ANVESA_NO_TELEMETRY: '1' },
  };
}

async function cli(root: string, env: Record<string, string>, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    cwd: root,
    env,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

const older = SKILL_TEXT.replace(/^version: .*$/m, 'version: "0.0.1"');

describe('the anvesa skill', () => {
  test('is the version of the anvesa that ships it', () => {
    expect(SKILL_VERSION).toBe(VERSION);
    expect(skillVersion(older)).toBe('0.0.1');
  });

  test('compares versions, a pre-release before its release', () => {
    expect(compareVersions('0.8.0-alpha.3', '0.8.0-alpha.10')).toBe(-1);
    expect(compareVersions('0.8.0-alpha.3', '0.8.0')).toBe(-1);
    expect(compareVersions('0.9.0', '0.8.5')).toBe(1);
    expect(compareVersions('0.8.0-beta.1', '0.8.0-alpha.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  test('installs into each agent folder, for the project or the user', async () => {
    const { root, env } = fresh();
    const claude = await cli(root, env, 'skill', 'install');
    expect(claude.code).toBe(0);
    const projectFile = join(root, '.claude', 'skills', 'anvesa', 'SKILL.md');
    expect(readFileSync(projectFile, 'utf8')).toBe(SKILL_TEXT);
    expect(claude.out).toContain('installed the skill at');
    expect((await cli(root, env, 'skill', 'install')).out).toContain('already current');

    expect((await cli(root, env, 'skill', 'install', '--agent', 'codex')).code).toBe(0);
    expect(existsSync(join(root, '.agents', 'skills', 'anvesa', 'SKILL.md'))).toBe(true);

    expect((await cli(root, env, 'skill', 'install', '--agent', 'opencode', '--user')).code).toBe(
      0,
    );
    expect(
      existsSync(join(env.HOME as string, '.config', 'opencode', 'skills', 'anvesa', 'SKILL.md')),
    ).toBe(true);

    const status = JSON.parse((await cli(root, env, 'skill', 'status', '--json')).out) as {
      version: string;
      copies: { agent: string; scope: string; installed: boolean; current: boolean }[];
    };
    expect(status.version).toBe(VERSION);
    expect(
      status.copies.filter((c) => c.installed).map((c) => `${c.agent}/${c.scope}/${c.current}`),
    ).toEqual(['claude/project/true', 'opencode/user/true', 'codex/project/true']);

    expect((await cli(root, env, 'skill', 'install', '--agent', 'cursor')).code).toBe(2);
    expect((await cli(root, env, 'skill', 'install', '--user', '--project')).code).toBe(2);
  });

  test('a refresh brings older copies up to date, and installs none that is not there', () => {
    const { root, env } = fresh();
    const claude = skillFile('claude', 'project', root, env) as string;
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, older);
    const handMade = skillFile('codex', 'user', root, env) as string;
    mkdirSync(dirname(handMade), { recursive: true });
    writeFileSync(handMade, '# my own notes, no version\n');

    const refreshed = refreshInstalledSkills(root, env);
    expect(refreshed.map((r) => r.path)).toEqual([claude]);
    expect(readFileSync(claude, 'utf8')).toBe(SKILL_TEXT);
    expect(readFileSync(handMade, 'utf8')).toBe('# my own notes, no version\n');
    expect(existsSync(skillFile('opencode', 'project', root, env) as string)).toBe(false);
  });

  test('init offers it with --yes, and --no-skill skips it', async () => {
    const yes = fresh();
    const ran = await cli(yes.root, yes.env, 'init', '--yes', '--no-download', '--no-agents-file');
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('skill: installed at');
    expect(existsSync(join(yes.root, '.claude', 'skills', 'anvesa', 'SKILL.md'))).toBe(true);

    const no = fresh();
    const skipped = await cli(no.root, no.env, 'init', '--yes', '--no-download', '--no-skill');
    expect(skipped.out).toContain('skill: skipped (--no-skill)');
    expect(existsSync(join(no.root, '.claude', 'skills'))).toBe(false);
  });
});
