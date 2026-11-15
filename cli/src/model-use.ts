import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  CONFIG_SCHEMA_URL,
  installModel,
  listModels,
  loadProjectConfig,
  type ModelCache,
  type ModelRow,
  modelsDirectory,
  writeProjectConfig,
} from '@cntxt-labs/anvesa-retriever';
import type { Environment } from './environment.ts';
import type { Parsed } from './options.ts';
import { DownloadProgress, formatBytes } from './progress.ts';
import { table } from './render.ts';

/** What choosing a model needs of a command's context. */
export interface ModelUseContext {
  readonly environment: Environment;
  readonly parsed: Parsed;
}

/** Record the choice so every teammate and every run uses the same model. */
export async function rememberModel(projectRoot: string, id: string): Promise<void> {
  const config = await loadProjectConfig(projectRoot);
  await writeProjectConfig(projectRoot, {
    ...config,
    $schema: config.$schema ?? CONFIG_SCHEMA_URL,
    model: id,
  });
}

/** Free bytes where the models go: the nearest existing folder on the way up. */
async function freeBytes(directory: string): Promise<number | undefined> {
  for (let path = directory; ; path = dirname(path)) {
    try {
      const info = await statfs(path);
      return info.bavail * info.bsize;
    } catch (failure) {
      if ((failure as { code?: unknown } | null)?.code !== 'ENOENT') return undefined;
      if (dirname(path) === path) return undefined;
    }
  }
}

/** How `init` shapes the choice; `model use` on its own passes none of it. */
export interface UseModelOptions {
  /**
   * What Enter picks, and what `assume` picks, when the project names no model yet: `init` passes
   * the model this machine suits.
   */
  readonly fallback?: string;
  /** A word per model for the table's note column (`recommended`, `too large ...`). */
  readonly notes?: ReadonlyMap<string, string>;
  /** Choose without asking: the named model, else the current one, else `fallback`. */
  readonly assume?: boolean;
  /** False: never download. A model that is not installed is reported, not fetched. */
  readonly mayDownload?: boolean;
  /**
   * A no to the download is a step skipped, not an error: `init` goes on without an encoder, where
   * `model use` on its own fails, since it was asked for nothing else.
   */
  readonly declineSkips?: boolean;
}

/** What `anvesa model use` did, for `--json` and for the line it prints. */
export interface ModelUseResult {
  /** The model the project now uses, or `undefined` when nothing changed. */
  readonly model: string | undefined;
  /** The model the project named before, if any. */
  readonly previous: string | undefined;
  readonly state: 'chosen' | 'unchanged' | 'cancelled';
  /** Downloaded on the way. */
  readonly downloaded: boolean;
  readonly note: string;
}

const FAMILY_LABEL: Readonly<Record<ModelRow['family'], string>> = {
  'anvesa-code': 'anvesa-code',
  open: 'open',
  custom: 'yours',
};

/** The models on offer, numbered as the prompt takes them. */
export function useTable(
  rows: readonly ModelRow[],
  current: string | undefined,
  notes?: ReadonlyMap<string, string>,
): string[] {
  const numbered = rows.map((row, index) => ({ row, number: index + 1 }));
  return table<(typeof numbered)[number]>(
    [
      { header: '#', cell: (r) => String(r.number), align: 'right' },
      { header: 'Model', cell: (r) => r.row.id },
      { header: 'Kind', cell: (r) => FAMILY_LABEL[r.row.family] },
      { header: 'Good for', cell: (r) => r.row.summary },
      { header: 'Disk', cell: (r) => `${r.row.sizeMb} MB`, align: 'right' },
      { header: 'License', cell: (r) => r.row.license },
      {
        header: 'Note',
        cell: (r) =>
          [
            r.row.id === current ? 'in use' : undefined,
            r.row.installed ? 'installed' : undefined,
            notes?.get(r.row.id),
          ]
            .filter(Boolean)
            .join(', '),
      },
    ],
    numbered,
  );
}

const say = (ctx: ModelUseContext, text: string): void => ctx.environment.stderr(`${text}\n`);

/**
 * `anvesa model use [model]`: choose the encoder this project searches and indexes with, and
 * record it in `.anvesa/config.json`. Named, it needs no terminal; unnamed, it shows the models
 * and asks. A model that is not installed is downloaded first, after a yes (or with `--download`
 * or `--yes`), so the project never names a model it cannot load.
 */
export async function useModel(
  ctx: ModelUseContext,
  projectRoot: string,
  cache: ModelCache,
  named: string | undefined,
  options: UseModelOptions = {},
): Promise<ModelUseResult> {
  const rows = await listModels(cache);
  const previous = (await loadProjectConfig(projectRoot)).model;
  const assume = options.assume === true;
  const interactive =
    ctx.environment.prompt !== undefined && ctx.parsed.values.json !== true && !assume;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const preset = previous ?? options.fallback;
  const cancelled = (note: string): ModelUseResult => ({
    model: undefined,
    previous,
    state: 'cancelled',
    downloaded: false,
    note,
  });

  let chosen: ModelRow | undefined;
  if (named !== undefined) {
    chosen = byId.get(named);
    if (!chosen) {
      throw new InvalidArgumentError('model', `one of ${rows.map((r) => r.id).join(', ')}`, named);
    }
  } else if (assume && preset !== undefined) {
    chosen = byId.get(preset);
  } else {
    if (!interactive) {
      throw new InvalidArgumentError(
        'model',
        `a model to use: anvesa model use <model> (one of ${rows.map((r) => r.id).join(', ')})`,
        undefined,
      );
    }
    say(ctx, `\nThe encoder this project searches with${previous ? ` (now ${previous})` : ''}:\n`);
    for (const line of useTable(rows, previous, options.notes)) say(ctx, `  ${line}`);
    const enter = previous
      ? `Enter = keep ${previous}`
      : options.fallback
        ? `Enter = ${options.fallback}`
        : 'Enter = cancel';
    const answer = (
      await ctx.environment.prompt?.(`\nUse which? [${enter}, a number or name, s = skip] `)
    )?.trim();
    if (answer === undefined || /^(s|skip|n|no)$/i.test(answer)) {
      return cancelled(previous ? `kept ${previous}` : 'skipped at your request');
    }
    if (answer === '' && previous !== undefined) return cancelled(`kept ${previous}`);
    if (answer === '' && preset === undefined) return cancelled('nothing chosen');
    chosen =
      answer === '' && preset !== undefined
        ? byId.get(preset)
        : (rows[Number(answer) - 1] ?? byId.get(answer));
    if (!chosen) {
      throw new InvalidArgumentError('model', 'a number or a name from the list', answer);
    }
  }

  if (!chosen) return cancelled('nothing chosen');
  if (chosen.id === previous && chosen.installed) {
    return {
      model: chosen.id,
      previous,
      state: 'unchanged',
      downloaded: false,
      note: `${chosen.id} is already in use`,
    };
  }

  let downloaded = false;
  if (!chosen.installed) {
    if (chosen.family === 'custom') {
      // A model brought in that is not installed has nothing to download from.
      throw new InvalidArgumentError('model', 'an installed model', chosen.id);
    }
    if (options.mayDownload === false) {
      return cancelled(
        `${chosen.id} is not installed and downloading is off; later: anvesa model use ${chosen.id} --download`,
      );
    }
    const agreed =
      ctx.parsed.values.download === true ||
      assume ||
      ctx.parsed.values.yes === true ||
      (interactive &&
        /^(y(es)?|)$/i.test(
          (
            await ctx.environment.prompt?.(
              `${chosen.id} is not installed. Download it (${chosen.sizeMb} MB)? [Y/n] `,
            )
          )?.trim() ?? 'n',
        ));
    if (!agreed && options.declineSkips) {
      return cancelled(
        `${chosen.id} not downloaded; later: anvesa model use ${chosen.id} --download`,
      );
    }
    if (!agreed) {
      throw new InvalidArgumentError(
        'model',
        `an installed model, or --download to fetch ${chosen.id} (${chosen.sizeMb} MB) first`,
        chosen.id,
      );
    }
    const free = await freeBytes(modelsDirectory(ctx.environment.env));
    const needed = chosen.sizeMb * 1024 * 1024;
    if (free !== undefined && free < needed * 1.5) {
      throw new InvalidArgumentError(
        'model',
        `room for ${chosen.id}: ${formatBytes(needed)} needed, ${formatBytes(free)} free`,
        chosen.id,
      );
    }
    say(ctx, `\nDownloading encoder ${chosen.id} (${formatBytes(needed)})`);
    const progress = new DownloadProgress(ctx.environment);
    let current = '';
    try {
      await installModel(cache, chosen.id, {
        download: true,
        ...(ctx.environment.fetch ? { fetch: ctx.environment.fetch } : {}),
        onProgress: (file, received, expected) => {
          if (file !== current) {
            progress.done();
            current = file;
            progress.start(file);
          }
          progress.update(received, expected);
        },
      });
    } finally {
      progress.done();
    }
    downloaded = true;
  }

  await rememberModel(projectRoot, chosen.id);
  const reindex =
    previous && previous !== chosen.id
      ? `; the index was embedded with ${previous}, so run anvesa index to re-embed it (meaning-based search reports the mismatch until then)`
      : '; run anvesa index to embed with it';
  return {
    model: chosen.id,
    previous,
    state: 'chosen',
    downloaded,
    note: `this project now uses ${chosen.id}${reindex}`,
  };
}
