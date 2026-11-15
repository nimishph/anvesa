import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { inputFile, pinChannelModule } from '@cntxt-labs/anvesa-retriever';
import { CommandFailedError } from '../../../errors.ts';
import * as show from '../../../render.ts';
import { defineCommand, type Services } from '../../shared/command.ts';
import { type Context, root } from '../../shared/context.ts';
import { emit, need } from '../../shared/output.ts';

/** `add`, `make` and `create` are one command: scaffold if the channel has no module, then register. */
const ADD_ALIASES = new Set(['add', 'make', 'create']);

async function channelCommand(ctx: Context, services: Services): Promise<void> {
  const [sub, ...names] = ctx.parsed.positionals;
  const inner: Context = { ...ctx, parsed: { ...ctx.parsed, positionals: names } };
  if (sub === undefined)
    throw new InvalidArgumentError(
      'channel',
      'add, list, show, test, index, pin or remove',
      undefined,
    );

  if (ADD_ALIASES.has(sub)) {
    return services.withProject(inner, { embed: false }, async ({ retriever }) => {
      const template = inner.parsed.values.template;
      if (template !== undefined && !['file', 'ast', 'external'].includes(template)) {
        throw new InvalidArgumentError('--template', 'file, ast or external', template);
      }
      const result = await retriever.addChannel(need(inner, 0, 'name'), {
        ...(template ? { template: template as 'file' | 'ast' | 'external' } : {}),
        ...(inner.parsed.positionals[1] ? { module: inner.parsed.positionals[1] } : {}),
      });
      emit(
        inner,
        result,
        () =>
          `${result.scaffolded.map((f) => `created ${f}`).join('\n')}${result.scaffolded.length ? '\n' : ''}registered ${need(inner, 0, 'name')} (${result.module})\n${result.nextSteps.map((s) => `  ${s}`).join('\n')}${result.nextSteps.length ? '\n' : ''}`,
      );
    });
  }

  switch (sub) {
    case 'list':
      return services.withProject(inner, { embed: false }, async ({ retriever }) => {
        const channels = await retriever.channels();
        emit(inner, channels, () => show.renderChannels(channels));
      });
    case 'show':
      return services.withProject(inner, { embed: false }, async ({ retriever }) => {
        const name = need(inner, 0, 'name');
        const channel = (await retriever.channels()).find((c) => c.name === name);
        if (!channel)
          throw new InvalidArgumentError(
            'name',
            `one of ${(await retriever.channels()).map((c) => c.name).join(', ')}`,
            name,
          );
        emit(inner, channel, () => show.renderChannel(channel));
      });
    case 'test':
      return services.withProject(inner, { embed: true }, async ({ retriever }) => {
        const channel = need(inner, 0, 'name');
        const file = resolve(inner.environment.cwd, need(inner, 1, 'file'));
        const relative = need(inner, 1, 'file');
        const content = await readFile(file, 'utf8');
        const previews = await retriever.testChannel(channel, inputFile(relative, content));
        emit(inner, previews, () =>
          previews.length === 0
            ? `${channel} does not claim ${relative}\n`
            : previews
                .map(
                  (p) =>
                    `${p.cards.length} cards, ${p.screened.accepted.length} accepted, ${p.screened.quarantined.length} quarantined, ${p.screened.sanitized} sanitized\n${p.screened.accepted.map((c) => `  ${c.id}  ${c.text.replace(/\s+/g, ' ')}`).join('\n')}\n${p.screened.quarantined.map((q) => `  quarantined ${q.card.id}: ${q.reasons.join('; ')}`).join('\n')}`,
                )
                .join('\n'),
        );
      });
    case 'index':
      return services.withProject(inner, { embed: true }, async ({ retriever }) => {
        const report = await retriever.indexChannel(
          need(inner, 0, 'name'),
          inner.parsed.values.force ? { force: true } : {},
        );
        emit(
          inner,
          report,
          () =>
            `${report.channel}: ${report.reports.length} records (${report.reports.filter((r) => r.outcome === 'indexed').length} indexed), ${report.removed.length} removed${
              report.reports.some((r) => r.outcome === 'failed')
                ? `, ${report.reports.filter((r) => r.outcome === 'failed').length} FAILED`
                : ''
            }\n${report.reports
              .filter((r) => r.outcome === 'failed')
              .map((r) => `failed ${r.path}: ${r.failure?.message ?? 'unknown error'}\n`)
              .join('')}${
              report.reports.length === 0
                ? "note: this indexes records from the channel's source. Cards from files the channel claims are built by: anvesa index\n"
                : ''
            }`,
        );
        const failed = report.reports.filter((r) => r.outcome === 'failed');
        if (failed.length > 0) {
          throw new CommandFailedError(
            `channel index ${report.channel}`,
            `${failed.length} of ${report.reports.length} records failed`,
            { context: { failed: failed.map((r) => r.path) } },
          );
        }
      });
    case 'pin': {
      const name = need(inner, 0, 'name');
      const pinned = await pinChannelModule(root(inner), name);
      emit(
        inner,
        pinned,
        () => `pinned ${name} (${pinned.module}) to sha256 ${pinned.sha256}
`,
      );
      return;
    }
    case 'remove':
      return services.withProject(inner, { embed: false }, async ({ retriever }) => {
        const result = await retriever.removeChannel(need(inner, 0, 'name'));
        emit(
          inner,
          result,
          () => `removed ${need(inner, 0, 'name')}: ${result.removedSources} sources dropped\n`,
        );
      });
    default:
      throw new InvalidArgumentError('channel', 'add, list, show, test, index or remove', sub);
  }
}

export default defineCommand({
  id: 'extend:channel',
  words: ['channel'],
  help: {
    section: 'Extend',
    rank: 17,
    name: 'channel <subcommand>',
    summary: 'custom dense channels',
    details:
      '  channel add|list|show|test|index|pin|remove   custom dense channels (make/create = add)\n                            pin <name> holds a channel\'s module to its checksum; "security": {"requireChecksums": true}\n                            in .anvesa/config.json refuses any module that is not pinned',
  },
  run: channelCommand,
});
