import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { integerOption } from '../../../options.ts';
import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { emit, need, rest } from '../../shared/output.ts';

export default defineCommand({
  id: 'search:diagnose',
  words: ['diagnose'],
  help: {
    section: 'Search',
    rank: 10,
    name: 'diagnose <q> --expect <path>',
    summary: 'why a file did not come up',
    details: '  diagnose <question> --expect <path>   why a file did not come up',
  },
  run: (ctx, services) =>
    services.withProject(ctx, { embed: true }, async ({ retriever }) => {
      const path = ctx.parsed.values.expect;
      if (path === undefined)
        throw new InvalidArgumentError(
          '--expect',
          'the path that should have been found',
          undefined,
        );
      const depth = integerOption('depth', ctx.parsed.values.depth);
      const diagnosis = await retriever.diagnose({
        query: rest(ctx, 0) || need(ctx, 0, 'query'),
        path,
        ...(depth === undefined ? {} : { depth }),
      });
      emit(ctx, diagnosis, () => show.renderDiagnosis(diagnosis));
    }),
});
