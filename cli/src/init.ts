import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  adviseModels,
  installGrammarFor,
  installModel,
  listModels,
  loadProjectConfig,
  type ModelAdvice,
  type ModelCache,
  modelsDirectory,
  type ProjectLanguage,
  probeHardware,
  projectLanguages,
  writeProjectConfig,
} from '@cntxt-labs/anvesa-retriever';
import type { Environment } from './environment.ts';
import type { Parsed } from './options.ts';
import { DownloadProgress, formatBytes } from './progress.ts';

/** What one step of setup did. `skipped` is a choice or a missing permission; `failed` is neither. */
export type StepState = 'installed' | 'already' | 'skipped' | 'failed';

export interface SetupResult {
  readonly hardware: {
    readonly cores: number;
    readonly availableMemoryMb: number;
    readonly totalMemoryMb: number;
  };
  readonly recommended: string;
  readonly reason: string;
  readonly model: {
    readonly id: string | undefined;
    readonly state: StepState;
    readonly note: string;
  };
  readonly grammars: readonly {
    readonly language: string;
    readonly state: StepState;
    readonly note: string;
  }[];
}

/** What setup needs of a command's context: where it runs and how it was invoked. */
export interface SetupContext {
  readonly environment: Environment;
  readonly parsed: Parsed;
}

const MB = 1024 * 1024;

function networkBlocked(ctx: SetupContext): boolean {
  return ctx.parsed.values['no-network'] === true || ctx.environment.env.ANVESA_NO_NETWORK === '1';
}

/** Ask, or `undefined` when nobody is there to answer. Lines go to stderr with the rest of the dialogue. */
async function ask(ctx: SetupContext, question: string): Promise<string | undefined> {
  const answer = await ctx.environment.prompt?.(question);
  return answer?.trim();
}

const say = (ctx: SetupContext, text: string): void => ctx.environment.stderr(`${text}\n`);

const yes = (answer: string | undefined): boolean =>
  answer === '' || /^y(es)?$/i.test(answer ?? '');

/**
 * The part of `init` that looks at this machine and this project and offers what is missing: an
 * encoder that suits the hardware, and a parser for every language in the project that lacks one.
 * It asks on a terminal, does everything with `--yes`, and otherwise only says what it would do, so
 * a script or CI run never downloads by surprise. Every download shows its progress.
 */
export async function setupProject(
  ctx: SetupContext,
  projectRoot: string,
  cache: ModelCache,
): Promise<SetupResult> {
  const values = ctx.parsed.values;
  const probe = probeHardware();
  const advice = adviseModels(probe);
  const assume = values.yes === true;
  const interactive = ctx.environment.prompt !== undefined && !assume && values.json !== true;
  const permitted = !networkBlocked(ctx) && values['no-download'] !== true;

  if (interactive) {
    say(
      ctx,
      `\nThis machine: ${probe.cores} cores, ${(probe.availableMemoryMb / 1024).toFixed(1)} GB of ${(probe.totalMemoryMb / 1024).toFixed(1)} GB memory available.`,
    );
  }

  const model = await chooseModel(ctx, projectRoot, cache, advice, permitted, interactive, assume);
  const grammars = await chooseGrammars(ctx, projectRoot, permitted, interactive, assume);
  return {
    hardware: {
      cores: probe.cores,
      availableMemoryMb: Math.round(probe.availableMemoryMb),
      totalMemoryMb: Math.round(probe.totalMemoryMb),
    },
    recommended: advice.recommended.spec.id,
    reason: advice.reason,
    model,
    grammars,
  };
}

function describeChoice(advice: ModelAdvice, installed: ReadonlySet<string>): string {
  const flags = [
    advice.recommended ? 'recommended' : undefined,
    installed.has(advice.spec.id) ? 'installed' : undefined,
    advice.fits ? undefined : 'too large for the memory available',
  ]
    .filter(Boolean)
    .join(', ');
  return `${advice.spec.id.padEnd(30)} ${formatBytes(advice.downloadMb * MB).padStart(9)} download  ~${String(Math.round(advice.estimatedPeakMb)).padStart(4)} MB memory  ${String(advice.spec.dimensions).padStart(4)}d${flags ? `  (${flags})` : ''}`;
}

async function chooseModel(
  ctx: SetupContext,
  projectRoot: string,
  cache: ModelCache,
  advice: ReturnType<typeof adviseModels>,
  permitted: boolean,
  interactive: boolean,
  assume: boolean,
): Promise<SetupResult['model']> {
  const rows = await listModels(cache);
  const installed = new Set(rows.filter((row) => row.installed).map((row) => row.id));
  const explicit = ctx.parsed.values.model;
  const known = new Map(advice.models.map((entry) => [entry.spec.id, entry]));

  if (explicit !== undefined && !known.has(explicit)) {
    throw new InvalidArgumentError('--model', `one of ${[...known.keys()].join(', ')}`, explicit);
  }
  if (explicit === undefined && installed.size > 0) {
    const [first] = [...installed];
    return {
      id: first,
      state: 'already',
      note: `encoder ${[...installed].join(', ')} is installed`,
    };
  }

  let chosen: ModelAdvice | undefined = explicit === undefined ? undefined : known.get(explicit);
  if (chosen === undefined && interactive) {
    say(ctx, `\nEncoder for meaning-based search. ${advice.reason}.\n`);
    advice.models.forEach((entry, index) => {
      say(ctx, `  ${String(index + 1).padStart(2)}) ${describeChoice(entry, installed)}`);
    });
    const answer = await ask(
      ctx,
      `\nInstall which? [Enter = ${advice.recommended.spec.id}, a number or name, s = skip] `,
    );
    if (answer === undefined || /^(s|skip|n|no)$/i.test(answer)) {
      return skipped(advice, 'skipped at your request');
    }
    chosen = advice.recommended;
    if (answer !== '') {
      const byNumber = advice.models[Number(answer) - 1];
      chosen = byNumber ?? known.get(answer);
      if (chosen === undefined) {
        say(ctx, `"${answer}" is not one of the encoders listed.`);
        return skipped(advice, `"${answer}" is not a built-in encoder`);
      }
    }
  } else if (chosen === undefined && assume) {
    chosen = advice.recommended;
  }

  if (chosen === undefined) {
    return {
      id: undefined,
      state: 'skipped',
      note: `not installed; ${advice.recommended.spec.id} is recommended: anvesa model install ${advice.recommended.spec.id} --download`,
    };
  }
  const id = chosen.spec.id;
  if (installed.has(id)) return { id, state: 'already', note: `encoder ${id} is installed` };
  if (!permitted) {
    return {
      id,
      state: 'skipped',
      note: `not downloaded (network use is off); later: anvesa model install ${id} --download`,
    };
  }

  const free = await freeBytes(modelsDirectory(ctx.environment.env));
  const needed = chosen.spec.model.bytes + chosen.spec.tokenizer.bytes;
  if (free !== undefined && free < needed * 1.5) {
    return {
      id,
      state: 'failed',
      note: `not enough disk space for ${id}: ${formatBytes(needed)} needed, ${formatBytes(free)} free`,
    };
  }

  const progress = new DownloadProgress(ctx.environment);
  try {
    say(ctx, `\nDownloading encoder ${id} (${formatBytes(needed)})`);
    let current = '';
    await installModel(cache, id, {
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
    progress.done();
  } catch (failure) {
    progress.done();
    return { id, state: 'failed', note: `download of ${id} failed: ${(failure as Error).message}` };
  }

  // Record the choice so every teammate and every run uses the same model.
  const config = await loadProjectConfig(projectRoot);
  await writeProjectConfig(projectRoot, { ...config, model: id });
  return { id, state: 'installed', note: `encoder ${id} installed and set in .anvesa/config.json` };
}

function skipped(advice: ReturnType<typeof adviseModels>, why: string): SetupResult['model'] {
  return {
    id: undefined,
    state: 'skipped',
    note: `${why}; later: anvesa model install ${advice.recommended.spec.id} --download`,
  };
}

async function chooseGrammars(
  ctx: SetupContext,
  projectRoot: string,
  permitted: boolean,
  interactive: boolean,
  assume: boolean,
): Promise<SetupResult['grammars']> {
  const host = ctx.environment.grammars ?? {};
  let missing: ProjectLanguage[];
  try {
    missing = (await projectLanguages(projectRoot, host)).filter((row) => row.state === 'missing');
  } catch (failure) {
    return [
      {
        language: '(any)',
        state: 'failed',
        note: `could not look at the project: ${(failure as Error).message}`,
      },
    ];
  }
  if (missing.length === 0) return [];

  let wanted = missing;
  if (interactive) {
    say(
      ctx,
      '\nThese languages in the project have no parser installed, so their files are skipped:\n',
    );
    for (const row of missing) say(ctx, `  ${row.language.padEnd(14)} ${row.files} files`);
    const answer = await ask(
      ctx,
      `\nDownload parsers (a few hundred KB each) to your user folder? [Y/n, or a list like ${missing[0]?.language}] `,
    );
    if (yes(answer)) wanted = missing;
    else if (answer === undefined || /^(n|no|s|skip)$/i.test(answer)) wanted = [];
    else {
      const names = new Set(answer.split(/[\s,]+/).filter(Boolean));
      wanted = missing.filter((row) => names.has(row.language));
    }
  } else if (!assume) {
    wanted = [];
  }

  const results: SetupResult['grammars'][number][] = [];
  const progress = new DownloadProgress(ctx.environment);
  for (const row of missing) {
    if (!wanted.includes(row)) {
      results.push({
        language: row.language,
        state: 'skipped',
        note: `${row.files} files not indexed; later: anvesa grammar install ${row.language} --user --download`,
      });
      continue;
    }
    if (!permitted) {
      results.push({
        language: row.language,
        state: 'skipped',
        note: `not downloaded (network use is off); later: anvesa grammar install ${row.language} --user --download`,
      });
      continue;
    }
    try {
      progress.start(`${row.language} parser`);
      await installGrammarFor(
        projectRoot,
        {
          language: row.language,
          user: true,
          download: true,
          ...(ctx.environment.fetch ? { fetch: ctx.environment.fetch } : {}),
          onProgress: (received, expected) => progress.update(received, expected),
        },
        host,
      );
      progress.done();
      results.push({ language: row.language, state: 'installed', note: 'installed for your user' });
    } catch (failure) {
      progress.done();
      results.push({
        language: row.language,
        state: 'failed',
        note: `download failed: ${(failure as Error).message}`,
      });
    }
  }
  return results;
}

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

/** The summary lines of a setup, for the text output of `init`. */
export function renderSetup(setup: SetupResult): string {
  const lines = [`encoder: ${setup.model.note}`];
  for (const grammar of setup.grammars) {
    lines.push(`parser ${grammar.language}: ${grammar.note}`);
  }
  return `${lines.join('\n')}\n`;
}
