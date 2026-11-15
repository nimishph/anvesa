import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { emit, need, pageRequest } from '../../shared/output.ts';
import { CALL_GRAPH_HELP } from './callers.ts';

export default defineCommand({
  id: 'graph:callees',
  words: ['callees'],
  help: CALL_GRAPH_HELP,
  run: (ctx, services) =>
    services.withProject(ctx, { embed: false }, async ({ retriever }) => {
      const result = await retriever.callees(need(ctx, 0, 'symbol'), pageRequest(ctx));
      ctx.onResults?.(result.callees.items.length);
      emit(ctx, result, () => show.renderCallees(result.symbol, result.callees));
    }),
});
