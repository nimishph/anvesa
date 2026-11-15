import { countBucket, durationBucket } from '@cntxt-labs/anvesa-core';
import { FederatedRetriever, splitConjunction } from '@cntxt-labs/anvesa-retriever';
import * as show from '../../../render.ts';
import { getGlobalTelemetry } from '../../../telemetry.ts';
import { defineCommand } from '../../shared/command.ts';
import { refreshSkills } from '../../shared/context.ts';
import {
  emitResults,
  modelField,
  need,
  pageRequest,
  parseWeights,
  rest,
  scopeOption,
  searchFacts,
} from '../../shared/output.ts';

export default defineCommand({
  id: 'search:search',
  words: ['search'],
  help: {
    section: 'Search',
    rank: 7,
    name: 'search <question>',
    summary: 'fused search over every channel and, for WQL, the structure',
    details:
      "  search <question>         fused search over every channel and, for WQL, the structure; one row per\n                            result (--expand or --full: each result's card under its row)\n                            (--wql <wql>, --channel, --exclude <lane>, --weight <lane>=<n>,\n                            --federated, --repo <name>,\n                            --scope <path>: only results from that path or under it, relative to\n                            the project root; every lane, documentation included; also on retrieve, query)\n                            (supports conjunction: 'save user && //function', 'save user where //class')",
  },
  run: (ctx, services) =>
    services.withProject(ctx, { embed: true, telemetryReminder: true }, async ({ retriever }) => {
      refreshSkills(ctx);
      const channels = ctx.parsed.values.channel;
      const exclude = ctx.parsed.values.exclude;
      const weights = parseWeights(ctx.parsed.values.weight);
      const query = rest(ctx, 0) || need(ctx, 0, 'query');
      const startedAt = performance.now();
      const isFederated =
        ctx.parsed.values.federated === true || Boolean(ctx.parsed.values.repo?.length);
      // Structural when the question is WQL alone, semantic when the structure lane is excluded.
      const searchMode: 'fused' | 'semantic' | 'structural' = exclude?.includes('structural')
        ? 'semantic'
        : splitConjunction(query, ctx.parsed.values.wql).semantic === undefined
          ? 'structural'
          : 'fused';
      const recordSearch = (name: string, results: number): void =>
        getGlobalTelemetry().record({
          type: 'search',
          name,
          searchMode,
          durationMsBucket: durationBucket(performance.now() - startedAt),
          resultCountBucket: countBucket(results),
          ...modelField(retriever),
          hasWqlFilter: Boolean(ctx.parsed.values.wql),
          hasScope: Boolean(ctx.parsed.values.scope),
          channelCount: Object.keys(retriever.config.channels).length,
        });
      if (isFederated) {
        const fed = new FederatedRetriever(retriever);
        try {
          const page = await fed.search(query, {
            ...pageRequest(ctx),
            ...(channels ? { channels } : {}),
            ...(exclude ? { exclude } : {}),
            ...(weights ? { weights } : {}),
            ...(ctx.parsed.values.wql ? { wql: ctx.parsed.values.wql } : {}),
            ...(ctx.parsed.values.repo ? { repos: ctx.parsed.values.repo } : {}),
            ...scopeOption(ctx),
          });
          recordSearch('search_federated', page.items.length);
          const facts = await searchFacts(ctx, retriever, query, startedAt);
          emitResults(ctx, page, facts, (options) => show.renderSearch(page, options));
        } finally {
          await fed.close();
        }
        return;
      }

      const page = await retriever.search(query, {
        ...pageRequest(ctx),
        ...(channels ? { channels } : {}),
        ...(exclude ? { exclude } : {}),
        ...(weights ? { weights } : {}),
        ...(ctx.parsed.values.wql ? { wql: ctx.parsed.values.wql } : {}),
        ...scopeOption(ctx),
      });
      recordSearch('search', page.items.length);
      const facts = await searchFacts(ctx, retriever, query, startedAt);
      emitResults(ctx, page, facts, (options) => show.renderSearch(page, options));
    }),
});
