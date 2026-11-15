import { resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { installGrammarFor, listGrammars, mappingStoreFor } from '@cntxt-labs/anvesa-retriever';
import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { type Context, root } from '../../shared/context.ts';
import { emit, need } from '../../shared/output.ts';

async function grammarCommand(ctx: Context): Promise<void> {
  const [sub, ...names] = ctx.parsed.positionals;
  const host = ctx.environment.grammars ?? {};
  switch (sub) {
    case 'list': {
      const mappings = await mappingStoreFor(root(ctx), host).registry();
      const rows = await listGrammars(root(ctx), host, mappings);
      emit(ctx, rows, () => show.renderGrammars(rows));
      return;
    }
    case 'install': {
      const inner: Context = { ...ctx, parsed: { ...ctx.parsed, positionals: names } };
      const from = ctx.parsed.values.from;
      const result = await installGrammarFor(
        root(ctx),
        {
          language: need(inner, 0, 'language'),
          ...(from ? { from: resolve(ctx.environment.cwd, from) } : {}),
          ...(ctx.parsed.values.user ? { user: true } : {}),
          ...(ctx.parsed.values.force ? { updateLock: true } : {}),
          ...(ctx.parsed.values.download ? { download: true } : {}),
        },
        host,
      );
      emit(
        ctx,
        result,
        () =>
          `installed ${result.grammarId} ${result.version} to ${result.path}
sha256 ${result.sha256}${result.matchedExistingLock ? ' (matches the lockfile)' : ' (recorded in the lockfile)'}
`,
      );
      return;
    }
    default:
      throw new InvalidArgumentError('grammar', 'list or install', sub);
  }
}

export default defineCommand({
  id: 'extend:grammar',
  words: ['grammar'],
  help: {
    section: 'Extend',
    rank: 18,
    name: 'grammar <subcommand>',
    summary: 'parsers',
    details:
      '  grammar list|install <language>        parsers (--from <file|dir|tarball>, --user, --force, --download)',
  },
  run: grammarCommand,
});
