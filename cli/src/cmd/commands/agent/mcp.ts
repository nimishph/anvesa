import { UnknownCommandError } from '../../../errors.ts';
import { defineCommand } from '../../shared/command.ts';

export default defineCommand({
  id: 'agent:mcp',
  words: ['mcp'],
  help: {
    section: 'Agents and help',
    rank: 26,
    name: 'mcp serve',
    summary: 'run as an MCP server on stdio',
    details:
      '  mcp serve                 run as an MCP server on stdio, for the project (see --root below)',
  },
  // A server runs for as long as its client: counted once, when it is serving, and not timed.
  // One that fails to start is counted as a failed run.
  countsItself: true,
  run: async (ctx) => {
    const [sub, ...rest] = ctx.parsed.positionals;
    if (sub !== 'serve')
      throw new UnknownCommandError(`unknown mcp command "${sub ?? ''}"; use: mcp serve`);
    const { serveMcp } = await import('../../../mcp.ts');
    await serveMcp(
      { ...ctx, parsed: { ...ctx.parsed, positionals: rest } },
      undefined,
      ctx.onServing,
    );
  },
});
