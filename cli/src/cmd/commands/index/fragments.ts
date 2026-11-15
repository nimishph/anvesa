import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { CommandFailedError } from '../../../errors.ts';
import * as show from '../../../render.ts';
import { defineCommand, type Services } from '../../shared/command.ts';
import { type Context, root } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

async function fragmentsCommand(ctx: Context, services: Services): Promise<void> {
  const [sub] = ctx.parsed.positionals;
  const manifestPath = join(root(ctx), '.anvesa', 'fragments.json');
  const tier = ctx.parsed.values.tier ?? 'path';
  if (tier !== 'path' && tier !== 'clusters') {
    throw new InvalidArgumentError('--tier', 'path or clusters', tier);
  }
  const resolutionText = ctx.parsed.values.resolution;
  const resolution = resolutionText === undefined ? undefined : Number(resolutionText);
  if (resolution !== undefined && !(Number.isFinite(resolution) && resolution > 0)) {
    throw new InvalidArgumentError('--resolution', 'a number above 0', resolutionText);
  }
  const labels = ctx.parsed.values.labels
    ? (JSON.parse(
        await readFile(resolve(ctx.environment.cwd, ctx.parsed.values.labels), 'utf8'),
      ) as Record<string, string>)
    : undefined;
  // Without a manifest a project that asks for shards cannot be opened as shards, but it can be
  // opened as one index to have one proposed.
  const shardsDirectory = join(root(ctx), '.anvesa', 'shards');
  const shardsBuilt =
    existsSync(shardsDirectory) &&
    readdirSync(shardsDirectory).some((name) => name.endsWith('.db') && name !== '_meta.db');
  // A proposal is made from the index, wherever it is: the shards once they hold it, else the
  // single database (which is also all there is when the manifest does not exist yet).
  const needsMonolith = !existsSync(manifestPath) || !shardsBuilt;

  switch (sub) {
    case 'status':
      return services.withProject(ctx, { embed: false }, async ({ retriever }) => {
        const status = await retriever.fragmentStatus();
        emit(ctx, status, () => show.renderFragmentStatus(status));
      });
    case 'propose':
      return services.withProject(
        ctx,
        { embed: false, monolith: needsMonolith },
        async ({ retriever }) => {
          const manifest = await retriever.proposeFragments({
            tier,
            ...(resolution === undefined ? {} : { resolution }),
            ...(labels ? { labels } : {}),
          });
          let written: string | undefined;
          if (ctx.parsed.values.write) {
            if (existsSync(manifestPath) && !ctx.parsed.values.force) {
              throw new CommandFailedError(
                'fragments propose',
                `${manifestPath} already exists, and it is what every machine follows`,
                { hint: 'Review the proposal, then pass --force to replace it.' },
              );
            }
            written = await retriever.saveFragments(manifest);
          }
          emit(ctx, { manifest, written }, () => show.renderProposal(manifest, written));
        },
      );
    case 'enable':
      return services.withProject(
        ctx,
        { embed: false, monolith: needsMonolith },
        async ({ retriever }) => {
          let written: string | undefined;
          if (!existsSync(manifestPath)) {
            const manifest = await retriever.proposeFragments({
              tier,
              ...(resolution === undefined ? {} : { resolution }),
              ...(labels ? { labels } : {}),
            });
            written = await retriever.saveFragments(manifest);
          }
          await retriever.setFragments(true);
          emit(
            ctx,
            { enabled: true, written },
            () =>
              `${written ? `wrote ${written}\n` : 'kept the existing manifest\n'}sharded indexing is on. Run: anvesa index (this builds the shards; the old index.db is no longer read)\n`,
          );
        },
      );
    case 'disable':
      return services.withProject(ctx, { embed: false, monolith: true }, async ({ retriever }) => {
        const off = await retriever.setFragments(false);
        emit(
          ctx,
          { enabled: false, ...off },
          () =>
            `sharded indexing is off${off.removedShards ? `; removed the shard databases in ${off.removedShards}` : ''}. .anvesa/fragments.json is kept for a later enable.\nThe single index was not kept up to date while sharded. Run: anvesa index --force\n`,
        );
      });
    case 'settle':
      return services.withProject(ctx, { embed: false }, async ({ retriever }) => {
        const settled = await retriever.settleFragments();
        emit(ctx, settled ?? { enabled: false }, () =>
          settled
            ? `${settled.movedFiles} files and ${settled.movedSources} embedded sources forgotten where they were, to be indexed where they belong; ${settled.removedShards.length} orphan shards removed\n`
            : 'sharded indexing is off\n',
        );
      });
    default:
      throw new InvalidArgumentError(
        'fragments',
        'status, propose, enable, disable or settle',
        sub,
      );
  }
}

export default defineCommand({
  id: 'index:fragments',
  words: ['fragments'],
  help: {
    section: 'Index',
    rank: 5,
    name: 'fragments <subcommand>',
    summary: 'keep the index in one database per fragment',
    details:
      '  fragments status|propose|enable|disable|settle   keep the index in one database per fragment\n                            propose [--tier path|clusters] [--write]; the manifest is committed',
  },
  run: fragmentsCommand,
});
