import { FederatedRetriever } from '@cntxt-labs/anvesa-retriever';
import { integerOption } from '../../../options.ts';
import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { emit, need } from '../../shared/output.ts';

export default defineCommand({
  id: 'graph:dependents',
  words: ['dependents'],
  help: {
    section: 'Code graph',
    rank: 13,
    name: 'dependents <path>',
    summary: 'files that import a file',
    details:
      '  dependents <path>         files that import it (--depth N, --limit N, --types, --federated)',
  },
  run: (ctx, services) =>
    services.withProject(ctx, { embed: false }, async ({ retriever }) => {
      const depth = integerOption('depth', ctx.parsed.values.depth);
      const limit = integerOption('limit', ctx.parsed.values.limit);
      const targetPath = need(ctx, 0, 'path');

      // --repo names repositories of the federation, so it implies --federated, as on search.
      if (ctx.parsed.values.federated || ctx.parsed.values.repo?.length) {
        const fed = new FederatedRetriever(retriever);
        try {
          const result = await fed.dependents(targetPath, {
            ...(depth === undefined ? {} : { depth }),
            ...(limit === undefined ? {} : { limit }),
            ...(ctx.parsed.values.types ? { includeTypeOnly: true } : {}),
            ...(ctx.parsed.values.repo ? { repos: ctx.parsed.values.repo } : {}),
          });
          emit(ctx, result, () => show.renderFederatedDependents(result));
        } finally {
          await fed.close();
        }
        return;
      }

      const result = await retriever.dependents(targetPath, {
        ...(depth === undefined ? {} : { depth }),
        ...(limit === undefined ? {} : { limit }),
        ...(ctx.parsed.values.types ? { includeTypeOnly: true } : {}),
      });
      emit(
        ctx,
        result,
        () =>
          `${result.dependents.map((d) => `${d.depth}  ${d.path}`).join('\n')}${result.dependents.length ? '\n' : ''}${result.dependents.length < result.total ? `${result.dependents.length} of ${result.total} shown (--limit)\n` : ''}${result.moreBeyondDepth ? 'more files depend on these beyond that depth (--depth)\n' : ''}`,
      );
    }),
});
