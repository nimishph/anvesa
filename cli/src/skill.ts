import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import PACKAGED_SKILL from '../../skills/anvesa/SKILL.md' with { type: 'text' };

/**
 * The anvesa skill (skills/anvesa/SKILL.md) put where an agent looks for skills. It is bundled into
 * the program, so the copy installed is always the one that matches the anvesa running.
 *
 * Installing is something the person asks for (`anvesa skill install`, or yes to `init`'s offer).
 * There is no npm postinstall: it would be skipped under --ignore-scripts, has no project to put it
 * in, and would write into a home directory nobody approved. `index` and `search` only refresh a
 * copy that is already there and older than this one.
 */

export const SKILL_AGENTS = ['claude', 'opencode', 'codex'] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];
export type SkillScope = 'project' | 'user';

type Env = Readonly<Record<string, string | undefined>>;

export const SKILL_TEXT: string = PACKAGED_SKILL;

/** The `version:` in a skill's frontmatter, if it has one. */
export function skillVersion(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const line = front?.split(/\r?\n/).find((l) => /^version\s*:/.test(l));
  return line
    ?.replace(/^version\s*:\s*/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

export const SKILL_VERSION: string | undefined = skillVersion(SKILL_TEXT);

/**
 * -1, 0 or 1 as `a` is older than, the same as, or newer than `b`: numbers part by part, and a
 * pre-release (`0.8.0-alpha.3`) before its release.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = '', pre] = v.split('-', 2);
    return { main: main.split('.').map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const xp = x.pre.split('.');
  const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i];
    const q = yp[i];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = Number(p);
    const qn = Number(q);
    if (Number.isInteger(pn) && Number.isInteger(qn)) return Math.sign(pn - qn);
    return p < q ? -1 : 1;
  }
  return 0;
}

function home(env: Env): string | undefined {
  return env.HOME || env.USERPROFILE || undefined;
}

/**
 * The skills folder of an agent, for this project or for the user. Claude Code reads
 * `.claude/skills`, opencode `.opencode/skills` (and `~/.config/opencode/skills`), and Codex the
 * shared `.agents/skills`.
 */
export function skillsFolder(
  agent: SkillAgent,
  scope: SkillScope,
  projectRoot: string,
  env: Env,
): string | undefined {
  if (scope === 'project') {
    return join(
      projectRoot,
      agent === 'claude' ? '.claude' : agent === 'opencode' ? '.opencode' : '.agents',
      'skills',
    );
  }
  const base = home(env);
  if (agent === 'opencode') {
    const config = env.XDG_CONFIG_HOME || (base ? join(base, '.config') : undefined);
    return config ? join(config, 'opencode', 'skills') : undefined;
  }
  if (!base) return undefined;
  return join(base, agent === 'claude' ? '.claude' : '.agents', 'skills');
}

export function skillFile(
  agent: SkillAgent,
  scope: SkillScope,
  projectRoot: string,
  env: Env,
): string | undefined {
  const folder = skillsFolder(agent, scope, projectRoot, env);
  return folder ? join(folder, 'anvesa', 'SKILL.md') : undefined;
}

export function parseSkillAgent(value: string | undefined): SkillAgent {
  if (value === undefined) return 'claude';
  if ((SKILL_AGENTS as readonly string[]).includes(value)) return value as SkillAgent;
  throw new InvalidArgumentError('--agent', SKILL_AGENTS.join(', '), value);
}

export interface SkillCopy {
  readonly agent: SkillAgent;
  readonly scope: SkillScope;
  readonly path: string;
  readonly installed: boolean;
  /** The installed copy's version; absent when it has none or none is installed. */
  readonly version?: string;
  /** Installed, and at this anvesa's version. */
  readonly current: boolean;
}

function copyAt(agent: SkillAgent, scope: SkillScope, path: string): SkillCopy {
  if (!existsSync(path)) return { agent, scope, path, installed: false, current: false };
  const version = skillVersion(readFileSync(path, 'utf8'));
  return {
    agent,
    scope,
    path,
    installed: true,
    ...(version ? { version } : {}),
    current: version !== undefined && SKILL_VERSION !== undefined && version === SKILL_VERSION,
  };
}

/** Every place the skill could be, and what is there. */
export function skillCopies(projectRoot: string, env: Env): readonly SkillCopy[] {
  const copies: SkillCopy[] = [];
  for (const agent of SKILL_AGENTS) {
    for (const scope of ['project', 'user'] as const) {
      const path = skillFile(agent, scope, projectRoot, env);
      if (path) copies.push(copyAt(agent, scope, path));
    }
  }
  return copies;
}

export interface SkillInstall {
  readonly path: string;
  readonly state: 'created' | 'updated' | 'current';
  readonly from?: string;
  readonly version?: string;
}

function write(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, SKILL_TEXT, 'utf8');
  renameSync(temporary, path);
}

/** Put this anvesa's skill in `agent`'s folder for the project or the user. */
export function installSkill(
  agent: SkillAgent,
  scope: SkillScope,
  projectRoot: string,
  env: Env,
): SkillInstall {
  const path = skillFile(agent, scope, projectRoot, env);
  if (!path) {
    throw new InvalidArgumentError('--user', 'a home directory (HOME or USERPROFILE)', 'unset');
  }
  const before = copyAt(agent, scope, path);
  const version = SKILL_VERSION ? { version: SKILL_VERSION } : {};
  if (before.installed && readFileSync(path, 'utf8') === SKILL_TEXT) {
    return { path, state: 'current', ...version };
  }
  write(path);
  return {
    path,
    state: before.installed ? 'updated' : 'created',
    ...(before.version ? { from: before.version } : {}),
    ...version,
  };
}

/**
 * Bring every installed copy older than this anvesa's up to date. Never installs one that is not
 * there, and never touches one at this version or newer (a newer anvesa put it there).
 */
export function refreshInstalledSkills(projectRoot: string, env: Env): readonly SkillInstall[] {
  if (!SKILL_VERSION) return [];
  const refreshed: SkillInstall[] = [];
  for (const copy of skillCopies(projectRoot, env)) {
    if (!copy.installed || !copy.version) continue;
    if (compareVersions(copy.version, SKILL_VERSION) >= 0) continue;
    write(copy.path);
    refreshed.push({
      path: copy.path,
      state: 'updated',
      from: copy.version,
      version: SKILL_VERSION,
    });
  }
  return refreshed;
}
