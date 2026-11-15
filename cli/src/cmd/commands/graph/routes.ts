import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'graph:routes',
  words: ['routes'],
  help: {
    section: 'Code graph',
    rank: 16,
    name: 'routes [method] [path]',
    summary: 'HTTP routes across Laravel, Express, Next.js, FastAPI',
    details:
      '  routes [method] [path]    discover HTTP routes across Laravel, Express, Next.js, FastAPI',
  },
  run: (ctx, services) =>
    services.withProject(ctx, { embed: false }, async ({ retriever }) => {
      const pos0 = ctx.parsed.positionals[0];
      const isMethod = pos0?.toUpperCase().match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|ANY)$/);
      const method = ctx.parsed.values.method ?? (isMethod ? pos0 : undefined);
      const path = ctx.parsed.values.path ?? (isMethod ? ctx.parsed.positionals[1] : pos0);
      const framework = ctx.parsed.values.framework;
      const routes = await retriever.routes({
        ...(method ? { method } : {}),
        ...(path ? { path } : {}),
        ...(framework ? { framework } : {}),
      });
      emit(ctx, routes, () => show.renderRoutes(routes));
    }),
});
