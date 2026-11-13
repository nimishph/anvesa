import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  installModel,
  listModels,
  loadProjectConfig,
  type ModelCache,
  type ModelRow,
} from '@cntxt-labs/anvesa-retriever';
import type { SetupContext } from './init.ts';
import { rememberModel } from './init.ts';
import { DownloadProgress } from './progress.ts';
import { table } from './render.ts';

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
export function useTable(rows: readonly ModelRow[], current: string | undefined): string[] {
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
          [r.row.id === current ? 'in use' : undefined, r.row.installed ? 'installed' : undefined]
            .filter(Boolean)
            .join(', '),
      },
    ],
    numbered,
  );
}

const say = (ctx: SetupContext, text: string): void => ctx.environment.stderr(`${text}\n`);

/**
 * `anvesa model use [model]`: choose the encoder this project searches and indexes with, and
 * record it in `.anvesa/config.json`. Named, it needs no terminal; unnamed, it shows the models
 * and asks. A model that is not installed is downloaded first, after a yes (or with `--download`
 * or `--yes`), so the project never names a model it cannot load.
 */
export async function useModel(
  ctx: SetupContext,
  projectRoot: string,
  cache: ModelCache,
  named: string | undefined,
): Promise<ModelUseResult> {
  const rows = await listModels(cache);
  const previous = (await loadProjectConfig(projectRoot)).model;
  const interactive = ctx.environment.prompt !== undefined && ctx.parsed.values.json !== true;
  const byId = new Map(rows.map((row) => [row.id, row]));

  let chosen: ModelRow | undefined;
  if (named !== undefined) {
    chosen = byId.get(named);
    if (!chosen) {
      throw new InvalidArgumentError('model', `one of ${rows.map((r) => r.id).join(', ')}`, named);
    }
  } else {
    if (!interactive) {
      throw new InvalidArgumentError(
        'model',
        `a model to use: anvesa model use <model> (one of ${rows.map((r) => r.id).join(', ')})`,
        undefined,
      );
    }
    say(ctx, `\nThe encoder this project searches with${previous ? ` (now ${previous})` : ''}:\n`);
    for (const line of useTable(rows, previous)) say(ctx, `  ${line}`);
    const keep = previous ? `Enter = keep ${previous}` : 'Enter = cancel';
    const answer = (
      await ctx.environment.prompt?.(`\nUse which? [${keep}, a number or name] `)
    )?.trim();
    if (answer === undefined || answer === '') {
      return {
        model: undefined,
        previous,
        state: 'cancelled',
        downloaded: false,
        note: previous ? `kept ${previous}` : 'nothing chosen',
      };
    }
    chosen = rows[Number(answer) - 1] ?? byId.get(answer);
    if (!chosen) {
      throw new InvalidArgumentError('model', 'a number or a name from the list', answer);
    }
  }

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
    const agreed =
      ctx.parsed.values.download === true ||
      ctx.parsed.values.yes === true ||
      (interactive &&
        /^(y(es)?|)$/i.test(
          (
            await ctx.environment.prompt?.(
              `${chosen.id} is not installed. Download it (${chosen.sizeMb} MB)? [Y/n] `,
            )
          )?.trim() ?? 'n',
        ));
    if (!agreed) {
      throw new InvalidArgumentError(
        'model',
        `an installed model, or --download to fetch ${chosen.id} (${chosen.sizeMb} MB) first`,
        chosen.id,
      );
    }
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
