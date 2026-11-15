import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { integerOption } from '../../../options.ts';
import * as show from '../../../render.ts';
import { defineCommand, type Services } from '../../shared/command.ts';
import type { Context } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

async function patternCommand(ctx: Context, services: Services): Promise<void> {
  const [sub, name, ...rawArgs] = ctx.parsed.positionals;
  if (!sub || (sub !== 'list' && sub !== 'run')) {
    throw new InvalidArgumentError('pattern', 'list or run', sub);
  }
  return services.withProject(ctx, { embed: false }, async ({ retriever }) => {
    if (sub === 'list') {
      const inventory = await retriever.patterns.inspect();
      emit(ctx, inventory, () => show.renderPatterns(inventory));
      return;
    }
    if (!name) {
      throw new InvalidArgumentError(
        'name',
        'a pattern name to run (see: anvesa pattern list)',
        undefined,
      );
    }
    const args: Record<string, string> = {};
    for (const arg of rawArgs) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        args[arg.slice(0, eq)] = arg.slice(eq + 1);
      }
    }
    const limit = integerOption('limit', ctx.parsed.values.limit);
    const result = await retriever.patterns.run(name, args, {
      ...(limit === undefined ? {} : { limit }),
      ...(ctx.parsed.values.cursor === undefined ? {} : { cursor: ctx.parsed.values.cursor }),
    });
    emit(ctx, result, () => show.renderPatternResult(result));
  });
}

export default defineCommand({
  id: 'extend:pattern',
  words: ['pattern'],
  help: {
    section: 'Search',
    rank: 11,
    name: 'pattern list|run <name>',
    summary: 'declarative structural patterns',
    details: '  pattern list|run <name> [param=val...]  declarative structural patterns',
  },
  run: patternCommand,
});
