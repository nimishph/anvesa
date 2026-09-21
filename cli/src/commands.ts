import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { InvalidArgumentError, type PageRequest } from '@sutras/code-lens-core';
import {
  doctorModels,
  type Embedder,
  inputFile,
  installGrammarFor,
  installModel,
  listGrammars,
  listModels,
  loadProjectConfig,
  ModelCache,
  modelsDirectory,
  openProjectEmbedder,
  Retriever,
} from '@sutras/code-lens-retriever';
import type { Environment } from './environment.ts';
import { integerOption, type Parsed } from './options.ts';
import * as show from './render.ts';

export interface Context {
  readonly environment: Environment;
  readonly parsed: Parsed;
}

interface Session {
  readonly retriever: Retriever;
  readonly embedderReason: string;
  close(): Promise<void>;
}

const root = (ctx: Context): string => resolve(ctx.environment.cwd, ctx.parsed.values.root ?? '.');

export function modelCache(ctx: Context): ModelCache {
  return new ModelCache(
    ctx.parsed.values.models
      ? resolve(ctx.environment.cwd, ctx.parsed.values.models)
      : modelsDirectory(ctx.environment.env),
  );
}

/** Open the project, with an embedder if a model is installed and one is wanted. */
export async function openSession(
  ctx: Context,
  options: { readonly embed: boolean },
): Promise<Session> {
  const projectRoot = root(ctx);
  const loaded = await loadProjectConfig(projectRoot);
  const config = ctx.parsed.values.model ? { ...loaded, model: ctx.parsed.values.model } : loaded;
  let embedder: (Embedder & { dispose(): Promise<void> }) | undefined;
  let embedderReason = 'not needed';
  if (options.embed && ctx.environment.embedder) {
    embedder = { ...ctx.environment.embedder, dispose: async () => undefined };
    embedderReason = 'supplied by the caller';
  } else if (options.embed && !ctx.parsed.values['no-embed']) {
    const opened = await openProjectEmbedder(config, modelCache(ctx));
    embedder = opened.embedder;
    embedderReason = opened.reason;
  }
  try {
    const retriever = await Retriever.open({
      root: projectRoot,
      config,
      ...(embedder ? { embedder } : {}),
      ...(ctx.environment.runtime ? { runtime: ctx.environment.runtime } : {}),
      ...(ctx.environment.grammars ? { grammars: ctx.environment.grammars } : {}),
    });
    return {
      retriever,
      embedderReason,
      close: async () => {
        await retriever.close();
        await embedder?.dispose();
      },
    };
  } catch (failure) {
    await embedder?.dispose();
    throw failure;
  }
}

function emit(ctx: Context, value: unknown, text: () => string): void {
  ctx.environment.stdout(ctx.parsed.values.json ? show.toJson(value) : text());
}

function need(ctx: Context, index: number, what: string): string {
  const value = ctx.parsed.positionals[index];
  if (value === undefined || value === '') {
    throw new InvalidArgumentError(what, 'a value (see: code-lens --help)', undefined);
  }
  return value;
}

const rest = (ctx: Context, from: number): string => ctx.parsed.positionals.slice(from).join(' ');

function pageRequest(ctx: Context): PageRequest {
  const limit = integerOption('limit', ctx.parsed.values.limit);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(ctx.parsed.values.cursor === undefined ? {} : { cursor: ctx.parsed.values.cursor }),
  };
}

/** Run a command against an open project, and close it whatever happens. */
async function withProject<T>(
  ctx: Context,
  options: { readonly embed: boolean },
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await openSession(ctx, options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

export type Handler = (ctx: Context) => Promise<void>;

export const COMMANDS: Readonly<Record<string, Handler>> = {
  index: (ctx) =>
    withProject(ctx, { embed: true }, async ({ retriever, embedderReason }) => {
      if (!retriever.embedder)
        ctx.environment.stderr(
          `note: no embedder (${embedderReason}); indexing facts and graph only\n`,
        );
      const scope = ctx.parsed.values.scope;
      const result = await retriever.index({
        ...(ctx.parsed.values.force ? { force: true } : {}),
        ...(ctx.parsed.values['retry-quarantined'] ? { retryQuarantined: true } : {}),
        ...(scope === undefined
          ? {}
          : {
              scope: (path: string) =>
                path === scope || path.startsWith(`${scope.replace(/\/$/, '')}/`),
            }),
      });
      emit(ctx, result, () => show.renderIndex(result));
    }),

  status: (ctx) =>
    withProject(ctx, { embed: false }, async ({ retriever }) => {
      const status = await retriever.status();
      emit(ctx, status, () => show.renderStatus(status));
    }),

  search: (ctx) =>
    withProject(ctx, { embed: true }, async ({ retriever }) => {
      const channels = ctx.parsed.values.channel;
      const page = await retriever.search(rest(ctx, 0) || need(ctx, 0, 'query'), {
        ...pageRequest(ctx),
        ...(channels ? { channels } : {}),
      });
      emit(ctx, page, () => show.renderSearch(page));
    }),

  retrieve: (ctx) =>
    withProject(ctx, { embed: true }, async ({ retriever }) => {
      const channel = need(ctx, 0, 'channel');
      const page = await retriever.retrieve(
        channel,
        need(ctx, 1, 'query') && rest(ctx, 1),
        pageRequest(ctx),
      );
      emit(ctx, page, () => show.renderRetrieved(page));
    }),

  query: (ctx) =>
    withProject(ctx, { embed: false }, async ({ retriever }) => {
      const page = await retriever.query(need(ctx, 0, 'wql'), pageRequest(ctx));
      emit(ctx, page, () => show.renderStructural(page));
    }),

  callers: (ctx) =>
    withProject(ctx, { embed: false }, async ({ retriever }) => {
      const result = await retriever.callers(need(ctx, 0, 'symbol'), {
        ...pageRequest(ctx),
        ...(ctx.parsed.values['resolved-only'] ? { resolvedOnly: true } : {}),
      });
      emit(ctx, result, () => show.renderCallers(result.symbol, result.callers));
    }),

  callees: (ctx) =>
    withProject(ctx, { embed: false }, async ({ retriever }) => {
      const result = await retriever.callees(need(ctx, 0, 'symbol'), pageRequest(ctx));
      emit(ctx, result, () => show.renderCallees(result.symbol, result.callees));
    }),

  neighbors: (ctx) =>
    withProject(ctx, { embed: false }, async ({ retriever }) => {
      const result = await retriever.neighbors(need(ctx, 0, 'symbol'), pageRequest(ctx));
      emit(
        ctx,
        result,
        () =>
          `${show.renderCallers(result.symbol, result.callers)}${show.renderCallees(result.symbol, result.callees)}`,
      );
    }),

  dependents: (ctx) =>
    withProject(ctx, { embed: false }, async ({ retriever }) => {
      const depth = integerOption('depth', ctx.parsed.values.depth);
      const result = await retriever.dependents(need(ctx, 0, 'path'), {
        ...(depth === undefined ? {} : { depth }),
        ...(ctx.parsed.values.types ? { includeTypeOnly: true } : {}),
      });
      emit(
        ctx,
        result,
        () =>
          `${result.dependents.map((d) => `${d.depth}  ${d.path}`).join('\n')}${result.dependents.length ? '\n' : ''}${result.moreBeyondDepth ? 'more files depend on these beyond that depth (--depth)\n' : ''}`,
      );
    }),

  explain: (ctx) =>
    withProject(ctx, { embed: false }, async ({ retriever }) => {
      const limit = integerOption('limit', ctx.parsed.values.limit);
      const explained = await retriever.explain(limit === undefined ? {} : { limit });
      emit(ctx, explained, () => show.renderExplain(explained));
    }),

  diagnose: (ctx) =>
    withProject(ctx, { embed: true }, async ({ retriever }) => {
      const path = ctx.parsed.values.expect;
      if (path === undefined)
        throw new InvalidArgumentError(
          '--expect',
          'the path that should have been found',
          undefined,
        );
      const depth = integerOption('depth', ctx.parsed.values.depth);
      const diagnosis = await retriever.diagnose({
        query: rest(ctx, 0) || need(ctx, 0, 'query'),
        path,
        ...(depth === undefined ? {} : { depth }),
      });
      emit(ctx, diagnosis, () => show.renderDiagnosis(diagnosis));
    }),
};

// --- channel ---------------------------------------------------------------------------------

/** `add`, `make` and `create` are one command: scaffold if the channel has no module, then register. */
const ADD_ALIASES = new Set(['add', 'make', 'create']);

export async function channelCommand(ctx: Context): Promise<void> {
  const [sub, ...names] = ctx.parsed.positionals;
  const inner: Context = { ...ctx, parsed: { ...ctx.parsed, positionals: names } };
  if (sub === undefined)
    throw new InvalidArgumentError('channel', 'add, list, show, test, index or remove', undefined);

  if (ADD_ALIASES.has(sub)) {
    return withProject(inner, { embed: false }, async ({ retriever }) => {
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
      return withProject(inner, { embed: false }, async ({ retriever }) => {
        const channels = await retriever.channels();
        emit(inner, channels, () => show.renderChannels(channels));
      });
    case 'show':
      return withProject(inner, { embed: false }, async ({ retriever }) => {
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
      return withProject(inner, { embed: true }, async ({ retriever }) => {
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
                    `${p.cards.length} cards, ${p.screened.accepted.length} accepted, ${p.screened.quarantined.length} quarantined, ${p.screened.sanitized} sanitized\n${p.cards.map((c) => `  ${c.id}  ${c.text.replace(/\s+/g, ' ')}`).join('\n')}\n${p.screened.quarantined.map((q) => `  quarantined ${q.card.id}: ${q.reasons.join('; ')}`).join('\n')}`,
                )
                .join('\n'),
        );
      });
    case 'index':
      return withProject(inner, { embed: true }, async ({ retriever }) => {
        const report = await retriever.indexChannel(
          need(inner, 0, 'name'),
          inner.parsed.values.force ? { force: true } : {},
        );
        emit(
          inner,
          report,
          () =>
            `${report.channel}: ${report.reports.length} records (${report.reports.filter((r) => r.outcome === 'indexed').length} indexed), ${report.removed.length} removed\n`,
        );
      });
    case 'remove':
      return withProject(inner, { embed: false }, async ({ retriever }) => {
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

// --- grammar ---------------------------------------------------------------------------------

export async function grammarCommand(ctx: Context): Promise<void> {
  const [sub, ...names] = ctx.parsed.positionals;
  const host = ctx.environment.grammars ?? {};
  switch (sub) {
    case 'list': {
      const rows = await listGrammars(root(ctx), host);
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

// --- model -----------------------------------------------------------------------------------

export async function modelCommand(ctx: Context): Promise<void> {
  const [sub, ...names] = ctx.parsed.positionals;
  const inner: Context = { ...ctx, parsed: { ...ctx.parsed, positionals: names } };
  const cache = modelCache(ctx);
  switch (sub) {
    case 'list': {
      const models = await listModels(cache);
      emit(ctx, models, () => show.renderModels(models));
      return;
    }
    case 'doctor': {
      const config = await loadProjectConfig(root(ctx));
      const doctor = await doctorModels(cache, config);
      emit(ctx, doctor, () => show.renderDoctor(doctor));
      return;
    }
    case 'install': {
      const id = need(inner, 0, 'model');
      const from = ctx.parsed.values.from
        ? resolve(ctx.environment.cwd, ctx.parsed.values.from)
        : undefined;
      if (from === undefined && !ctx.parsed.values.download) {
        throw new InvalidArgumentError(
          'install',
          'a source: --from <dir> (offline) or --download',
          undefined,
        );
      }
      const installed = await installModel(cache, id, {
        ...(from ? { from } : {}),
        ...(ctx.parsed.values.download ? { download: true } : {}),
      });
      emit(
        ctx,
        installed,
        () =>
          `installed ${installed.id} in ${isAbsolute(installed.directory) ? installed.directory : resolve(installed.directory)}\n`,
      );
      return;
    }
    default:
      throw new InvalidArgumentError('model', 'list, install or doctor', sub);
  }
}
