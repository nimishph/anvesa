import { integerOption } from '../../../options.ts';
import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'graph:map',
  words: ['map'],
  help: {
    section: 'Code graph',
    rank: 15,
    name: 'map [dir]',
    summary: 'graph-weighted architectural repomap',
    details:
      '  map [dir]                 graph-weighted architectural repomap (--depth N, --budget N)',
  },
  run: (ctx, services) =>
    services.withProject(ctx, { embed: false }, async ({ retriever }) => {
      const depth = integerOption('depth', ctx.parsed.values.depth);
      const budget = integerOption('budget', ctx.parsed.values.budget);
      const scope = ctx.parsed.positionals[0];
      const result = await retriever.repoMap({
        ...(depth === undefined ? {} : { depth }),
        ...(budget === undefined ? {} : { budget }),
        ...(scope ? { scope } : {}),
      });
      emit(ctx, result, () => show.renderRepoMap(result));
    }),
});
