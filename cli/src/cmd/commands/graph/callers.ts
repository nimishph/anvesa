import * as show from '../../../render.ts';
import { defineCommand, type HelpEntry } from '../../shared/command.ts';
import { emit, need, pageRequest } from '../../shared/output.ts';

/** callers, callees and neighbors share one line in the help. */
export const CALL_GRAPH_HELP: HelpEntry = {
  section: 'Code graph',
  rank: 12,
  name: 'callers|callees|neighbors <symbol>',
  summary: 'who calls a symbol, what it calls, or both',
  details: '  callers|callees|neighbors <symbol>   symbol id, name, or path:line',
};

export default defineCommand({
  id: 'graph:callers',
  words: ['callers'],
  help: CALL_GRAPH_HELP,
  run: (ctx, services) =>
    services.withProject(ctx, { embed: false }, async ({ retriever }) => {
      const result = await retriever.callers(need(ctx, 0, 'symbol'), {
        ...pageRequest(ctx),
        ...(ctx.parsed.values['resolved-only'] ? { resolvedOnly: true } : {}),
      });
      ctx.onResults?.(result.callers.items.length);
      emit(ctx, result, () => show.renderCallers(result.symbol, result.callers));
    }),
});
