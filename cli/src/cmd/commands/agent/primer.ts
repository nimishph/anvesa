import { getPrimer, renderPrimer } from '../../../primer.ts';
import { defineCommand } from '../../shared/command.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'agent:primer',
  words: ['primer'],
  help: {
    section: 'Agents and help',
    rank: 22,
    name: 'primer [topic]',
    summary: 'token-frugal guidance on Anvesa architecture and concepts',
    details:
      '  primer [topic]            token-frugal guidance on Anvesa architecture and concepts (--compact)',
  },
  run: async (ctx) => {
    const topic = ctx.parsed.positionals[0];
    const compact = ctx.parsed.values.compact === true || ctx.parsed.values.format === 'compact';
    const result = getPrimer(topic);
    emit(ctx, result, () => renderPrimer(result, compact));
  },
});
