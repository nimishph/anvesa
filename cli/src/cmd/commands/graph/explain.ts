import { integerOption } from '../../../options.ts';
import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'graph:explain',
  words: ['explain'],
  help: {
    section: 'Code graph',
    rank: 14,
    name: 'explain',
    summary: 'what the project is made of',
    details: '  explain                   what the project is made of',
  },
  run: (ctx, services) =>
    services.withProject(ctx, { embed: false }, async ({ retriever }) => {
      const limit = integerOption('limit', ctx.parsed.values.limit);
      const explained = await retriever.explain(limit === undefined ? {} : { limit });
      emit(ctx, explained, () => show.renderExplain(explained));
    }),
});
