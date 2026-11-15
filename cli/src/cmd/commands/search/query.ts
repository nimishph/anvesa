import { countBucket, durationBucket } from '@cntxt-labs/anvesa-core';
import { splitConjunction } from '@cntxt-labs/anvesa-retriever';
import * as show from '../../../render.ts';
import { getGlobalTelemetry } from '../../../telemetry.ts';
import { defineCommand } from '../../shared/command.ts';
import { onlyLocal } from '../../shared/context.ts';
import {
  emitResults,
  need,
  pageRequest,
  rest,
  scopeOption,
  searchFacts,
} from '../../shared/output.ts';

export default defineCommand({
  id: 'search:query',
  words: ['query'],
  help: {
    section: 'Search',
    rank: 9,
    name: "query '<wql>'",
    summary: 'structural query in WQL, e.g. \'//function[@name="parse"]\'',
    details:
      "  query '<wql>'             structural query, e.g. '//function[@name=\"parse\"]'\n                            (--semantic <q>, or conjunction: '//function && save user')",
  },
  run: (ctx, services) => {
    onlyLocal(ctx, 'query');
    const rawWql = rest(ctx, 0) || need(ctx, 0, 'wql');
    const semantic = ctx.parsed.values.semantic;
    const split = splitConjunction(rawWql, undefined, semantic);
    const needsEmbed = Boolean(split.semantic);
    return services.withProject(
      ctx,
      { embed: needsEmbed, telemetryReminder: true },
      async ({ retriever }) => {
        const startedAt = performance.now();
        const page = await retriever.query(rawWql, {
          ...pageRequest(ctx),
          ...(semantic ? { semantic } : {}),
          ...scopeOption(ctx),
        });
        const elapsed = performance.now() - startedAt;
        getGlobalTelemetry().record({
          type: 'search',
          name: 'query',
          searchMode: semantic ? 'fused' : 'structural',
          durationMsBucket: durationBucket(elapsed),
          resultCountBucket: countBucket(page.items.length),
          hasWqlFilter: true,
          hasScope: Boolean(ctx.parsed.values.scope),
        });
        const facts = await searchFacts(
          ctx,
          retriever,
          semantic ? `${rawWql} && ${semantic}` : rawWql,
          startedAt,
        );
        emitResults(ctx, page, facts, (options) => show.renderStructural(page, options));
      },
    );
  },
});
