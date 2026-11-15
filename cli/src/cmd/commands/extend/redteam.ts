import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { CommandFailedError } from '../../../errors.ts';
import * as show from '../../../render.ts';
import { defineCommand, type Services } from '../../shared/command.ts';
import type { Context } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

async function redteamCommand(ctx: Context, services: Services): Promise<void> {
  const [sub] = ctx.parsed.positionals;
  switch (sub) {
    case 'list':
    case 'verify':
      // Opening the project is what checks the policy: its rules, its sources and every fixture.
      return services.withProject(ctx, { embed: false }, async ({ retriever }) => {
        const rules = await retriever.redTeamRules();
        if (sub === 'verify') {
          const custom = rules.filter((rule) => rule.source !== 'built in');
          emit(
            ctx,
            { ok: true, rules: rules.length, custom: custom.length },
            () =>
              `${rules.length} rules in force, ${custom.length} added by policy, every fixture holds\n`,
          );
          return;
        }
        emit(ctx, rules, () => show.renderRedTeamRules(rules));
      });
    case 'scan':
      return services.withProject(ctx, { embed: true }, async ({ retriever }) => {
        const scan = await retriever.redTeamScan();
        emit(ctx, scan, () => show.renderRedTeamScan(scan));
        if (scan.quarantined.length > 0) {
          throw new CommandFailedError(
            'redteam scan',
            `${scan.quarantined.length} cards of this project would be quarantined`,
            {
              hint: 'If they are not attacks, loosen the rule that fired in .anvesa/redteam.json.',
            },
          );
        }
      });
    default:
      throw new InvalidArgumentError('redteam', 'list, verify or scan', sub);
  }
}

export default defineCommand({
  id: 'extend:redteam',
  words: ['redteam'],
  help: {
    section: 'Safety',
    rank: 21,
    name: 'redteam <subcommand>',
    summary: 'the screen every card passes',
    details:
      "  redteam list|verify|scan  the screen every card passes; .anvesa/redteam.json adds rules and\n                            changes what each trust level does (scan: would this project's own text be quarantined?)",
  },
  run: redteamCommand,
});
