import { countBucket, durationBucket } from '@cntxt-labs/anvesa-core';
import {
  CONFIG_SCHEMA_URL,
  type IndexEvent,
  loadProjectConfig,
  PROJECT_CONFIG_PATH,
  pathScope,
  writeProjectConfig,
} from '@cntxt-labs/anvesa-retriever';
import { renderIndexBar } from '../../../progress.ts';
import * as show from '../../../render.ts';
import { getGlobalTelemetry } from '../../../telemetry.ts';
import { defineCommand } from '../../shared/command.ts';
import { type Context, refreshSkills } from '../../shared/context.ts';
import { emit, modelField } from '../../shared/output.ts';

/**
 * Live progress for `index`, on stderr so it never mixes with --json (or the text summary, both
 * on stdout). On a terminal, a bar against the files the walk listed is redrawn in place, with the
 * rate, the time left and, once one takes a while, the file being embedded. Otherwise (piped,
 * logged, tests) a plain line is appended every 500 files and, so a slow model is never mistaken
 * for a stall, on a timer while a run is in progress, naming the file being embedded and for how
 * long.
 */
function indexProgress(ctx: Context): {
  readonly onEvent: (event: IndexEvent) => void;
  stop(): void;
} {
  const interactive = ctx.environment.isTTY === true;
  const showWalk = ctx.parsed.values['show-walk'] === true;
  const counts = { seen: 0, added: 0, modified: 0, quarantined: 0, embedded: 0, cards: 0 };
  let total: number | undefined;
  let plannedAt = Date.now();
  let embedding: { readonly path: string; readonly since: number } | undefined;
  let lastWrite = 0;
  let drawn = false;
  const summary = () => {
    const seen =
      total === undefined
        ? `${counts.seen} seen`
        : `${counts.seen}/${total} seen (${total === 0 ? 100 : Math.floor((counts.seen / total) * 100)}%)`;
    return `indexing: ${seen} (${counts.added} added, ${counts.modified} modified, ${counts.quarantined} quarantined)${counts.embedded > 0 ? `, ${counts.embedded} embedded (${counts.cards} cards)` : ''}`;
  };
  const bar = (width?: number) => {
    const now = Date.now();
    return renderIndexBar(
      {
        done: counts.seen,
        total,
        embedded: counts.embedded,
        cards: counts.cards,
        quarantined: counts.quarantined,
        elapsedMs: now - plannedAt,
        // A file that embeds quickly is not worth naming; one that takes a while is.
        embedding:
          embedding && now - embedding.since >= 2000
            ? { path: embedding.path, forMs: now - embedding.since }
            : undefined,
      },
      width,
    );
  };
  const draw = () => {
    lastWrite = Date.now();
    ctx.environment.stderr(`\r${bar(ctx.environment.columns)}\u001b[K`);
    drawn = true;
  };
  const clear = () => {
    if (interactive && drawn) ctx.environment.stderr('\r\u001b[K');
    drawn = false;
  };
  const started = Date.now();
  // On a terminal the bar is redrawn on a timer too, so the time left and a slow file keep moving
  // between events; elsewhere a line on a timer says the run is still working.
  const ticker = interactive
    ? setInterval(() => {
        if (drawn) draw();
      }, 250)
    : setInterval(() => {
        const now = Date.now();
        const where = embedding
          ? ` — embedding ${embedding.path} (${Math.round((now - embedding.since) / 1000)} s on it)`
          : '';
        ctx.environment.stderr(
          `${summary()}${where}, ${Math.round((now - started) / 1000)} s in\n`,
        );
      }, ctx.environment.progressIntervalMs ?? 10_000);
  ticker.unref?.();

  const onEvent = (event: IndexEvent): void => {
    if (event.kind === 'started') {
      if (event.interrupted) {
        ctx.environment.stderr(
          'note: the previous run did not finish; rebuilding edges and cards\n',
        );
      }
      if (interactive) draw();
      return;
    }
    if (event.kind === 'planned') {
      total = event.files;
      plannedAt = Date.now();
      if (interactive) draw();
      return;
    }
    if (event.kind === 'warning') {
      clear();
      ctx.environment.stderr(`warning: ${event.message}\n`);
      if (interactive) draw();
      return;
    }
    if (event.kind === 'embedding') {
      embedding = { path: event.path, since: Date.now() };
      return;
    }
    if (event.kind === 'embedded') {
      embedding = undefined;
      counts.embedded += 1;
      counts.cards += event.cards;
      if (interactive && Date.now() - lastWrite >= 80) draw();
      return;
    }
    if (event.kind === 'file') {
      counts.seen += 1;
      if (event.outcome === 'added') counts.added += 1;
      else if (event.outcome === 'modified') counts.modified += 1;
      else if (event.outcome === 'quarantined') counts.quarantined += 1;
      if (showWalk) {
        // Clear the bar first, so the path does not land on top of it; it is redrawn below.
        clear();
        lastWrite = 0;
        ctx.environment.stderr(
          `walk: ${event.path} (${event.outcome}${event.reason ? `: ${event.reason}` : ''})\n`,
        );
      }
      if (interactive) {
        if (Date.now() - lastWrite >= 80 || counts.seen === total) draw();
      } else if (counts.seen % 500 === 0) {
        ctx.environment.stderr(`${summary()}\n`);
      }
      return;
    }
    if (event.kind === 'linking') {
      embedding = undefined;
      if (interactive) {
        const width = ctx.environment.columns;
        const suffix = ' — linking';
        ctx.environment.stderr(
          `\r\u001b[K${bar(width === undefined ? undefined : width - suffix.length)}${suffix}\n`,
        );
        drawn = false;
      } else {
        ctx.environment.stderr(`${summary()} — linking\n`);
      }
      return;
    }
    clear();
  };
  return {
    onEvent,
    stop: () => {
      clearInterval(ticker);
      clear();
    },
  };
}

export default defineCommand({
  id: 'index:index',
  words: ['index'],
  help: {
    section: 'Index',
    rank: 4,
    name: 'index',
    summary: 'bring the index up to date',
    details:
      '  index                     bring the index up to date (--force, --retry-quarantined, --scope <path>,\n                            --no-embed or --no-dense: structure and graph only, no embedding pass,\n                            --show-walk: print each path the walk offers, with its outcome, on stderr)',
  },
  run: (ctx, services) =>
    services.withProject(
      ctx,
      { embed: true, telemetryReminder: true },
      async ({ retriever, embedderReason }) => {
        refreshSkills(ctx);
        if (!retriever.embedder)
          ctx.environment.stderr(
            `note: no embedder (${embedderReason}); indexing facts and graph only\n`,
          );
        const inScope = pathScope(ctx.parsed.values.scope, '--scope');
        const startedAt = performance.now();
        const progress = indexProgress(ctx);
        const result = await retriever
          .index({
            onEvent: progress.onEvent,
            ...(ctx.parsed.values.force ? { force: true } : {}),
            ...(ctx.parsed.values['retry-quarantined'] ? { retryQuarantined: true } : {}),
            ...(inScope ? { scope: inScope } : {}),
          })
          .finally(progress.stop);
        const elapsed = performance.now() - startedAt;
        const embeddedCount =
          result.report.dense?.ingested ?? result.report.files.added + result.report.files.modified;
        getGlobalTelemetry().record({
          type: 'index',
          name: 'index',
          durationMsBucket: durationBucket(elapsed),
          ...modelField(retriever),
          hasScope: Boolean(ctx.parsed.values.scope),
          changedCountBucket: countBucket(embeddedCount),
        });
        const info = retriever.embedder?.info;
        // The model the index was embedded with is recorded, so every later run, on any machine,
        // searches with it instead of whatever that machine would pick.
        if (info && result.report.dense) {
          const onDisk = await loadProjectConfig(retriever.root);
          if (onDisk.model !== info.id) {
            await writeProjectConfig(retriever.root, {
              ...onDisk,
              $schema: onDisk.$schema ?? CONFIG_SCHEMA_URL,
              model: info.id,
            });
            ctx.environment.stderr(
              `note: recorded "model": "${info.id}" in ${PROJECT_CONFIG_PATH}, so later runs search with the model this index was embedded with\n`,
            );
          }
        }
        const embedder = info
          ? {
              id: info.id,
              dimensions: info.dimensions,
              maxTokens: info.maxTokens,
              ...(info.device ? { device: info.device } : {}),
            }
          : null;
        // What the index holds now, per channel: the run's report only counts what it changed.
        const channels = (await retriever.channels())
          // With no model, an empty channel only repeats what the `model: none` line says.
          .filter((channel) => (channel.enabled && info !== undefined) || channel.cards > 0)
          .map(({ name, cards, sources, quarantined }) => ({ name, cards, sources, quarantined }));
        emit(ctx, { ...result, embedder, channels }, () =>
          show.renderIndex({ ...result, embedder, embedderReason, channels }),
        );
      },
    ),

  // Paths only: nothing is opened, so it answers even where the index or the config is broken.
});
