import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { integerOption } from '../../../options.ts';
import * as show from '../../../render.ts';
import { defineCommand, type Services } from '../../shared/command.ts';
import type { Context } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

async function patternCommand(ctx: Context, services: Services): Promise<void> {
  const [sub, name, ...rawArgs] = ctx.parsed.positionals;
  if (!sub || (sub !== 'list' && sub !== 'run' && sub !== 'check')) {
    throw new InvalidArgumentError('pattern', 'list, run or check', sub);
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
        `a pattern name to ${sub} (see: anvesa pattern list)`,
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
    const page = {
      ...(limit === undefined ? {} : { limit }),
      ...(ctx.parsed.values.cursor === undefined ? {} : { cursor: ctx.parsed.values.cursor }),
    };
    if (sub === 'check') {
      const checked = await retriever.patterns.check(name, args, page);
      emit(ctx, checked, () => show.renderPatternCheck(checked));
      return;
    }
    const result = await retriever.patterns.run(name, args, page);
    emit(ctx, result, () => show.renderPatternResult(result));
  });
}

export default defineCommand({
  id: 'extend:pattern',
  words: ['pattern'],
  help: {
    section: 'Search',
    rank: 11,
    name: 'pattern list|run|check <name>',
    summary: 'declarative structural patterns',
    details:
      '  pattern list|run|check <name> [param=val...]  declarative structural patterns; check also shows the WQL and every warning',
  },
  run: patternCommand,
});
