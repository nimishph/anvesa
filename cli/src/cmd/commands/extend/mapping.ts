import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  type Assistant,
  auditMapping,
  chatAssistant,
  checkMapping,
  listMappings,
  mappingStoreFor,
  refineMapping,
  trainLanguage,
  verifyMappings,
} from '@cntxt-labs/anvesa-retriever';
import { CommandFailedError } from '../../../errors.ts';
import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { type Context, root } from '../../shared/context.ts';
import { emit, need } from '../../shared/output.ts';

/**
 * `--samples` takes one value per flag, so `--samples app core tests` leaves `core` and `tests` as
 * positionals after the language. They are samples too, not something to drop without a word.
 */
function samplesOf(inner: Context): string[] {
  return [...(inner.parsed.values.samples ?? []), ...inner.parsed.positionals.slice(1)];
}

/**
 * The language model `train --assist` asks, from the environment: the key is read here and passed
 * on, never stored. Any OpenAI-compatible endpoint works; OpenRouter is the default.
 */
function assistantFor(ctx: Context, language: string): Assistant {
  const env = ctx.environment.env;
  if (ctx.parsed.values['no-network'] === true || env.ANVESA_NO_NETWORK === '1') {
    throw new InvalidArgumentError('--assist', 'network access (it asks a language model)', 'off');
  }
  const apiKey = env.ANVESA_ASSIST_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new InvalidArgumentError(
      '--assist',
      'an API key in OPENROUTER_API_KEY (or ANVESA_ASSIST_API_KEY)',
      'none set',
    );
  }
  const model = ctx.parsed.values['assist-model'] ?? env.ANVESA_ASSIST_MODEL;
  return chatAssistant({
    apiKey,
    language,
    cacheFile: join(root(ctx), '.anvesa', 'assist', `${language}.json`),
    ...(model ? { model } : {}),
    ...(env.ANVESA_ASSIST_BASE_URL ? { baseUrl: env.ANVESA_ASSIST_BASE_URL } : {}),
    ...(ctx.parsed.values['assist-refresh'] ? { refresh: true } : {}),
    ...(ctx.environment.fetch ? { fetch: ctx.environment.fetch } : {}),
  });
}

function countOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new InvalidArgumentError(flag, 'a whole number of at least 1', value);
  }
  return count;
}

async function mappingCommand(ctx: Context): Promise<void> {
  const [sub, ...names] = ctx.parsed.positionals;
  const inner: Context = { ...ctx, parsed: { ...ctx.parsed, positionals: names } };
  const host = ctx.environment.grammars ?? {};
  const tier = ctx.parsed.values.user ? 'user' : 'project';
  const store = () => mappingStoreFor(root(ctx), host);
  switch (sub) {
    case 'list': {
      const listed = await listMappings(root(ctx), host);
      emit(ctx, listed, () => show.renderMappings(listed));
      return;
    }
    case 'show': {
      const language = need(inner, 0, 'language');
      const found = (await listMappings(root(ctx), host))
        .filter((entry) => entry.languages.includes(language))
        .at(-1);
      if (!found) {
        throw new InvalidArgumentError(
          'language',
          `one of ${[...new Set((await listMappings(root(ctx), host)).flatMap((entry) => entry.languages))].join(', ')}`,
          language,
        );
      }
      // The mapping itself, as it would be kept in a file.
      ctx.environment.stdout(`${JSON.stringify(found.mapping, null, 2)}\n`);
      return;
    }
    case 'train': {
      const language = need(inner, 0, 'language');
      const samples = samplesOf(inner);
      if (samples.length === 0) {
        throw new InvalidArgumentError(
          '--samples',
          'a file or folder of code to learn from',
          undefined,
        );
      }
      const minShare = ctx.parsed.values['min-share'];
      const minSamples = countOption(ctx.parsed.values['min-samples'], '--min-samples');
      const minFiles = countOption(ctx.parsed.values['min-files'], '--min-files');
      const assist = ctx.parsed.values.assist ? assistantFor(ctx, language) : undefined;
      const tagsPath = ctx.parsed.values.tags;
      const tags =
        tagsPath === undefined
          ? undefined
          : await readFile(resolve(ctx.environment.cwd, tagsPath), 'utf8').catch((failure) => {
              throw new InvalidArgumentError('--tags', 'a readable tags.scm file', tagsPath, {
                cause: failure,
              });
            });
      const result = await trainLanguage(
        root(ctx),
        {
          language,
          samples: samples.map((sample) => resolve(ctx.environment.cwd, sample)),
          ...(ctx.parsed.values.name ? { name: ctx.parsed.values.name } : {}),
          ...(ctx.parsed.values.user ? { user: true } : {}),
          ...(ctx.parsed.values['dry-run'] ? { dryRun: true } : {}),
          ...(ctx.parsed.values.force ? { force: true } : {}),
          ...(ctx.parsed.values.replace ? { replace: true } : {}),
          ...(minShare === undefined ? {} : { minShare: Number(minShare) }),
          ...(minSamples === undefined ? {} : { minSamples }),
          ...(minFiles === undefined ? {} : { minFiles }),
          ...(assist ? { assist } : {}),
          ...(tags === undefined ? {} : { tags }),
        },
        host,
      );
      emit(ctx, result, () => show.renderTraining(result));
      if (result.refused !== undefined && !ctx.parsed.values['dry-run'] && !result.unchanged) {
        throw new CommandFailedError('mapping train', result.refused);
      }
      return;
    }
    case 'audit': {
      const language = need(inner, 0, 'language');
      const samples = samplesOf(inner);
      const report = await auditMapping(
        root(ctx),
        {
          language,
          ...(samples.length > 0
            ? { samples: samples.map((sample) => resolve(ctx.environment.cwd, sample)) }
            : {}),
        },
        host,
      );
      emit(ctx, report, () => show.renderAudit(report));
      return;
    }
    case 'refine': {
      const language = need(inner, 0, 'language');
      const samples = samplesOf(inner);
      const result = await refineMapping(
        root(ctx),
        {
          language,
          // Paths typed on the command line are the shell's, so they resolve against cwd; with
          // none, the library looks over the project root, which is not cwd under --root.
          ...(samples.length > 0
            ? { samples: samples.map((sample) => resolve(ctx.environment.cwd, sample)) }
            : {}),
          ...(ctx.parsed.values.name ? { name: ctx.parsed.values.name } : {}),
          ...(ctx.parsed.values.user ? { user: true } : {}),
          ...(ctx.parsed.values['dry-run'] ? { dryRun: true } : {}),
        },
        host,
      );
      emit(ctx, result, () => show.renderRefine(result));
      return;
    }
    case 'fork': {
      const language = need(inner, 0, 'language');
      const forked = await store().fork(language, {
        tier,
        ...(ctx.parsed.values.name ? { name: ctx.parsed.values.name } : {}),
      });
      emit(
        ctx,
        forked,
        () =>
          `forked ${forked.mapping.name} for ${forked.languages.join(', ')} to ${forked.path}\nedit it, then: anvesa mapping lock ${forked.mapping.name}${ctx.parsed.values.user ? ' --user' : ''}\n`,
      );
      return;
    }
    case 'lock': {
      const locked = await store().lock(need(inner, 0, 'name'), tier);
      emit(ctx, locked, () => `recorded ${locked.mapping.name} (${locked.sha256})\n`);
      return;
    }
    case 'remove': {
      const removed = await store().remove(need(inner, 0, 'name'), tier);
      emit(ctx, { removed }, () => (removed ? 'removed\n' : 'nothing to remove\n'));
      return;
    }
    case 'verify': {
      const checks = await verifyMappings(root(ctx), host);
      emit(ctx, checks, () => show.renderMappingChecks(checks));
      const bad = checks.filter((check) => check.status !== 'ok');
      if (bad.length > 0) {
        throw new CommandFailedError(
          'mapping verify',
          bad.map((check) => `${check.name} is ${check.status}`).join(', '),
          { hint: 'Record a change that was meant with `anvesa mapping lock <name>`.' },
        );
      }
      return;
    }
    case 'check': {
      const checked = await checkMapping(root(ctx), need(inner, 0, 'name'), tier, host);
      emit(ctx, checked, () => show.renderGoldenCheck(checked));
      if (checked.differences.length > 0) {
        throw new CommandFailedError(
          'mapping check',
          `${checked.differences.length} samples no longer come out as recorded`,
        );
      }
      return;
    }
    default:
      throw new InvalidArgumentError(
        'mapping',
        'list, show, train, audit, refine, fork, lock, remove, verify or check',
        sub,
      );
  }
}

export default defineCommand({
  id: 'extend:mapping',
  words: ['mapping'],
  help: {
    section: 'Extend',
    rank: 19,
    name: 'mapping <subcommand>',
    summary: "how a language's syntax becomes an outline",
    details:
      "  mapping list|show|train|audit|refine|fork|lock|remove|verify|check   how a language's syntax becomes an outline;\n                            audit/refine <language> finds and adds unmapped syntax nodes from code;\n                            train <language> --samples <dir|file> [more...] learns from code and extends the\n                            mapping in effect (--replace learns from scratch; --min-samples N, default 10;\n                            --min-files N a new node type must occur in, default 3; --assist asks a\n                            language model about what is left, from OPENROUTER_API_KEY, checked before use;\n                            --tags <tags.scm> starts from the grammar's own definitions and calls)",
  },
  run: mappingCommand,
});
