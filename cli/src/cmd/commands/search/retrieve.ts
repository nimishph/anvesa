import { countBucket, durationBucket } from '@cntxt-labs/anvesa-core';
import * as show from '../../../render.ts';
import { getGlobalTelemetry } from '../../../telemetry.ts';
import { defineCommand } from '../../shared/command.ts';
import { onlyLocal } from '../../shared/context.ts';
import {
  emitResults,
  modelField,
  need,
  pageRequest,
  rest,
  scopeOption,
  searchFacts,
} from '../../shared/output.ts';

export default defineCommand({
  id: 'search:retrieve',
  words: ['retrieve'],
  help: {
    section: 'Search',
    rank: 8,
    name: 'retrieve <channel> <q>',
    summary: 'one channel on its own',
    details: '  retrieve <channel> <q>    one channel on its own',
  },
  run: (ctx, services) => {
    onlyLocal(ctx, 'retrieve');
    return services.withProject(ctx, { embed: true }, async ({ retriever }) => {
      const channel = need(ctx, 0, 'channel');
      const query = need(ctx, 1, 'query') && rest(ctx, 1);
      const startedAt = performance.now();
      const page = await retriever.retrieve(channel, query, {
        ...pageRequest(ctx),
        ...scopeOption(ctx),
      });
      const elapsed = performance.now() - startedAt;
      getGlobalTelemetry().record({
        type: 'search',
        name: 'retrieve',
        searchMode: 'semantic',
        durationMsBucket: durationBucket(elapsed),
        resultCountBucket: countBucket(page.items.length),
        ...modelField(retriever),
        hasScope: Boolean(ctx.parsed.values.scope),
      });
      const facts = await searchFacts(ctx, retriever, query, startedAt);
      emitResults(ctx, page, facts, (options) => show.renderRetrieved(page, options));
    });
  },
});
