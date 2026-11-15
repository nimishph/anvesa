import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  installSkill,
  parseSkillAgent,
  SKILL_VERSION,
  type SkillInstall,
  skillCopies,
} from '../../../skill.ts';
import { defineCommand } from '../../shared/command.ts';
import { root } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

function describeSkillInstall(result: SkillInstall): string {
  if (result.state === 'current') return `skill already current at ${result.path}`;
  if (result.state === 'updated') {
    return `updated the skill at ${result.path} (${result.from ?? 'unversioned'} -> ${result.version ?? 'this version'})`;
  }
  return `installed the skill at ${result.path}`;
}

export default defineCommand({
  id: 'agent:skill',
  words: ['skill'],
  help: {
    section: 'Agents and help',
    rank: 24,
    name: 'skill [status|install]',
    summary: "install the anvesa skill into an agent's skill folder",
    details:
      "  skill install             copy the anvesa skill into an agent's skills folder: --agent claude (default),\n                            opencode or codex; --project (default) or --user. index and search keep an\n                            installed copy at this version, and never install one that is not there\n  skill status              where the skill is installed, and at which version",
  },
  run: async (ctx) => {
    const sub = ctx.parsed.positionals[0] ?? 'status';
    const projectRoot = root(ctx);
    const env = ctx.environment.env;
    if (sub === 'install') {
      if (ctx.parsed.values.user && ctx.parsed.values.project) {
        throw new InvalidArgumentError('--user', 'either --user or --project, not both', 'both');
      }
      const agent = parseSkillAgent(ctx.parsed.values.agent);
      const scope = ctx.parsed.values.user ? 'user' : 'project';
      const result = installSkill(agent, scope, projectRoot, env);
      emit(ctx, { agent, scope, ...result }, () => `${describeSkillInstall(result)}\n`);
      return;
    }
    if (sub !== 'status') throw new InvalidArgumentError('skill', 'status or install', sub);
    const copies = skillCopies(projectRoot, env);
    emit(ctx, { version: SKILL_VERSION, copies }, () => {
      const installed = copies.filter((copy) => copy.installed);
      return [
        `anvesa skill ${SKILL_VERSION ?? '(unversioned)'}`,
        ...(installed.length === 0
          ? [
              'not installed; install it with: anvesa skill install [--agent claude|opencode|codex] [--user]',
            ]
          : installed.map(
              (copy) =>
                `  ${copy.agent.padEnd(9)}${copy.scope.padEnd(8)}${(copy.version ?? 'no version').padEnd(16)}${copy.current ? '' : 'older (refreshed by the next index or search)  '}${copy.path}`,
            )),
        '',
      ].join('\n');
    });
  },
});
