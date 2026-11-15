import { integerOption } from '../../../options.ts';
import { defineCommand } from '../../shared/command.ts';
import { root } from '../../shared/context.ts';
import { rest } from '../../shared/output.ts';

export default defineCommand({
  id: 'project:ui',
  words: ['ui'],
  help: {
    section: 'Get started',
    rank: 2,
    name: 'ui',
    summary: "launch the interactive visual web dashboard, and edit the project's settings",
    details:
      '  ui                        launch the visual web dashboard in browser\n                            (--port <number>, --no-open, --root <dir>, --search <q>,\n                            --mode <fused|semantic|structural>, --wql <expr>, --symbol <name>,\n                            --view <search|graph|wql|status|settings>, --repomap, --routes);\n                            its Settings view edits .anvesa/config.json',
  },
  run: async (ctx, services) => {
    const port = integerOption('port', ctx.parsed.values.port);
    const noOpen = ctx.parsed.values['no-open'] === true;
    const search = ctx.parsed.values.search || rest(ctx, 0);
    const mode = ctx.parsed.values.mode;
    const wql = ctx.parsed.values.wql;
    const scope = ctx.parsed.values.scope;
    const symbol = ctx.parsed.values.symbol;
    const view = ctx.parsed.values.view;
    const repomap = ctx.parsed.values.repomap;
    const routes = ctx.parsed.values.routes;

    const queryParams: Record<string, string> = {
      ...(search ? { q: search } : {}),
      ...(mode ? { mode } : {}),
      ...(wql ? { wql } : {}),
      ...(scope ? { scope } : {}),
      ...(symbol ? { symbol } : {}),
      ...(view ? { view } : {}),
      ...(repomap ? { repomap: 'true' } : {}),
      ...(routes ? { routes: 'true' } : {}),
    };

    const { startUiServer } = await import('@cntxt-labs/anvesa-ui');
    await startUiServer({
      ...(port !== undefined ? { port } : {}),
      root: root(ctx),
      models: services.modelCache(ctx).root,
      open: !noOpen,
      queryParams,
    });
  },
});
