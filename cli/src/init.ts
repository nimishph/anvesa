import { InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
import {
  adviseModels,
  installGrammarFor,
  loadProjectConfig,
  type ModelCache,
  type ProjectLanguage,
  probeHardware,
  projectLanguages,
} from '@cntxt-labs/anvesa-retriever';
import type { Environment } from './environment.ts';
import { useModel } from './model-use.ts';
import type { Parsed } from './options.ts';
import { DownloadProgress } from './progress.ts';
import { installSkill, parseSkillAgent, refreshInstalledSkills, skillCopies } from './skill.ts';

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
  /** The agent skill: offered beside the AGENTS.md section, installed only on a yes. */
  readonly skill: { readonly state: StepState; readonly path?: string; readonly note: string };
}

/** What setup needs of a command's context: where it runs and how it was invoked. */
export interface SetupContext {
  readonly environment: Environment;
  readonly parsed: Parsed;
}

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
 * The part of `init` that looks at this machine and this project and offers what is missing: a
 * parser for every language in the project that lacks one, the agent skill, and last an encoder,
 * chosen with `anvesa model use` and this machine's advice as the default.
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

  const grammars = await chooseGrammars(ctx, projectRoot, permitted, interactive, assume);
  const skill = await offerSkill(ctx, projectRoot, interactive, assume);
  // Last, once everything else is in place: the encoder, through `anvesa model use`.
  if (interactive) {
    say(
      ctx,
      `\nThis machine: ${probe.cores} cores, ${(probe.availableMemoryMb / 1024).toFixed(1)} GB of ${(probe.totalMemoryMb / 1024).toFixed(1)} GB memory available. ${advice.reason}.`,
    );
  }
  const model = await chooseModel(ctx, projectRoot, cache, advice, permitted, interactive, assume);
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
    skill,
  };
}

/**
 * Offer the anvesa skill for the agent `--agent` names (Claude Code unless it says otherwise), in
 * this project. A copy already installed anywhere is kept current instead; `--no-skill` skips it.
 */
async function offerSkill(
  ctx: SetupContext,
  projectRoot: string,
  interactive: boolean,
  assume: boolean,
): Promise<SetupResult['skill']> {
  if (ctx.parsed.values['no-skill'] === true) {
    return { state: 'skipped', note: 'skipped (--no-skill)' };
  }
  const env = ctx.environment.env;
  const installed = skillCopies(projectRoot, env).filter((copy) => copy.installed);
  if (installed.length > 0) {
    refreshInstalledSkills(projectRoot, env);
    const where = installed.map((copy) => copy.path).join(', ');
    return { state: 'already', note: `installed at ${where}` };
  }
  const agent = parseSkillAgent(ctx.parsed.values.agent);
  const later = `later: anvesa skill install --agent ${agent}`;
  if (interactive) {
    const answer = await ask(
      ctx,
      `Install the anvesa skill for ${agent} in this project, so the agent knows how to use anvesa? [Y/n] `,
    );
    if (!yes(answer)) return { state: 'skipped', note: `not installed; ${later}` };
  } else if (!assume) {
    return { state: 'skipped', note: `not installed; ${later}` };
  }
  const result = installSkill(agent, 'project', projectRoot, env);
  return { state: 'installed', path: result.path, note: `installed at ${result.path}` };
}

/**
 * The encoder, through `anvesa model use`: the same list, the same Enter-keeps-current, the same
 * download on a yes. This machine's recommendation is what Enter (and `--yes`) picks when the
 * project names no model yet. Without a terminal or `--yes` it only says what it would do.
 */
async function chooseModel(
  ctx: SetupContext,
  projectRoot: string,
  cache: ModelCache,
  advice: ReturnType<typeof adviseModels>,
  permitted: boolean,
  interactive: boolean,
  assume: boolean,
): Promise<SetupResult['model']> {
  const explicit = ctx.parsed.values.model;
  const fallback = advice.recommended.spec.id;
  const later = `later: anvesa model use ${fallback} --download`;
  if (explicit === undefined && !interactive && !assume) {
    let current: string | undefined;
    try {
      current = (await loadProjectConfig(projectRoot)).model;
    } catch (failure) {
      // init leaves a config it cannot read as it is, and says so; the encoder waits for it.
      return {
        id: undefined,
        state: 'skipped',
        note: `not chosen: ${toCodeLensError(failure, 'read .anvesa/config.json').message}`,
      };
    }
    return current
      ? { id: current, state: 'already', note: `${current} is set in .anvesa/config.json` }
      : {
          id: undefined,
          state: 'skipped',
          note: `not installed; ${fallback} is recommended for this machine: anvesa model use ${fallback} --download`,
        };
  }
  const notes = new Map<string, string>();
  for (const entry of advice.models) {
    if (entry.recommended) notes.set(entry.spec.id, 'recommended');
    else if (!entry.fits) notes.set(entry.spec.id, 'too large for the memory available');
  }
  try {
    const result = await useModel(ctx, projectRoot, cache, explicit, {
      fallback,
      notes,
      assume,
      mayDownload: permitted,
      declineSkips: true,
    });
    if (result.state === 'cancelled') {
      return {
        id: undefined,
        state: 'skipped',
        note: result.note.includes('later:') ? result.note : `${result.note}; ${later}`,
      };
    }
    return {
      id: result.model,
      state: result.downloaded ? 'installed' : 'already',
      note: result.note,
    };
  } catch (failure) {
    // A model named outright that does not exist is the caller's mistake: init stops on it.
    if (explicit !== undefined && failure instanceof InvalidArgumentError) throw failure;
    return {
      id: undefined,
      state: 'failed',
      note: toCodeLensError(failure, 'choose a model').message,
    };
  }
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

/** The summary lines of a setup, for the text output of `init`. */
export function renderSetup(setup: SetupResult): string {
  const lines = [`encoder: ${setup.model.note}`];
  for (const grammar of setup.grammars) {
    lines.push(`parser ${grammar.language}: ${grammar.note}`);
  }
  lines.push(`skill: ${setup.skill.note}`);
  return `${lines.join('\n')}\n`;
}
