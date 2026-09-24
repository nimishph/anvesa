import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { InvalidArgumentError, type PageRequest } from '@cntxt-labs/anvesa-core';
import {
  checkMapping,
  doctorModels,
  type Embedder,
  type IndexEvent,
  inputFile,
  installGrammarFor,
  installModel,
  listGrammars,
  listMappings,
  listModels,
  loadProjectConfig,
  ModelCache,
  mappingStoreFor,
  modelsDirectory,
  openProjectEmbedder,
  PROJECT_CONFIG_PATH,
  Retriever,
  trainLanguage,
  verifyMappings,
  verifyModel,
} from '@cntxt-labs/anvesa-retriever';
import type { Environment } from './environment.ts';
import { CommandFailedError } from './errors.ts';
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
  options: { readonly embed: boolean; readonly monolith?: boolean },
): Promise<Session> {
  const projectRoot = root(ctx);
  const loaded = await loadProjectConfig(projectRoot);
  const named = ctx.parsed.values.model ? { ...loaded, model: ctx.parsed.values.model } : loaded;
  // Working out what the fragments should be needs the index as it is, in one piece.
  const config = options.monolith ? { ...named, fragments: false } : named;
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
    throw new InvalidArgumentError(what, 'a value (see: anvesa --help)', undefined);
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
  options: { readonly embed: boolean; readonly monolith?: boolean },
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await openSession(ctx, options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

/** `--weight docs=0.25` (repeatable) as a lane-to-weight map. */
function parseWeights(entries: readonly string[] | undefined): Record<string, number> | undefined {
  if (!entries || entries.length === 0) return undefined;
  const weights: Record<string, number> = {};
  for (const entry of entries) {
    const at = entry.lastIndexOf('=');
    const weight = at === -1 ? Number.NaN : Number(entry.slice(at + 1));
    if (at < 1 || !Number.isFinite(weight) || weight < 0) {
      throw new InvalidArgumentError('--weight', 'lane=number, for example docs=0.25', entry);
    }
    weights[entry.slice(0, at)] = weight;
  }
  return weights;
}

interface ScaffoldFile {
  readonly path: string;
  readonly content: string;
}

/** `init`'s starter files: valid, minimal, and safe to run `anvesa index` against as-is. */
function scaffoldFiles(): readonly ScaffoldFile[] {
  return [
    {
      path: '.anvesaignore',
      content:
        '# anvesa reads this like .gitignore, at every directory level, alongside .gitignore\n' +
        '# itself. node_modules, .anvesa, .sutra and __pycache__ are already skipped by\n' +
        "# default; add patterns below for anything else this project doesn't want indexed.\n",
    },
    {
      // Hardcoded rather than imported: cli may depend on retriever but not indexer directly
      // (see .dependency-cruiser.cjs), and this is the one file whose schema lives there.
      path: '.anvesa/workspace.json',
      content: `${JSON.stringify(
        {
          version: 1,
          packages: [],
          discover: true,
          exclude: [],
          nestedRepos: 'include',
          followSymlinks: false,
        },
        null,
        2,
      )}\n`,
    },
    {
      path: PROJECT_CONFIG_PATH,
      content: `${JSON.stringify({ channels: {} }, null, 2)}\n`,
    },
  ];
}

/**
 * Live progress for `index`, on stderr so it never mixes with --json (or the text summary, both
 * on stdout). On a terminal, one line is rewritten in place; otherwise (piped, logged, tests) a
 * plain line is appended periodically, since overwriting one line only makes sense on a screen.
 */
function indexProgress(ctx: Context): (event: IndexEvent) => void {
  const interactive = ctx.environment.isTTY === true;
  const counts = { seen: 0, added: 0, modified: 0, quarantined: 0 };
  let lastWrite = 0;
  let lineLength = 0;
  const summary = () =>
    `indexing: ${counts.seen} seen (${counts.added} added, ${counts.modified} modified, ${counts.quarantined} quarantined)`;
  return (event) => {
    if (event.kind === 'started') {
      if (event.interrupted) {
        ctx.environment.stderr(
          'note: the previous run did not finish; rebuilding edges and cards\n',
        );
      }
      return;
    }
    if (event.kind === 'warning') {
      ctx.environment.stderr(`warning: ${event.message}\n`);
      return;
    }
    if (event.kind === 'file') {
      counts.seen += 1;
      if (event.outcome === 'added') counts.added += 1;
      else if (event.outcome === 'modified') counts.modified += 1;
      else if (event.outcome === 'quarantined') counts.quarantined += 1;
      if (interactive) {
        const now = Date.now();
        if (now - lastWrite < 80) return;
        lastWrite = now;
        const line = summary();
        ctx.environment.stderr(`\r${line}${' '.repeat(Math.max(0, lineLength - line.length))}`);
        lineLength = line.length;
      } else if (counts.seen % 500 === 0) {
        ctx.environment.stderr(`${summary()}\n`);
      }
      return;
    }
    if (event.kind === 'linking') {
      ctx.environment.stderr(interactive ? `\r${summary()} — linking\n` : 'linking\n');
      lineLength = 0;
      return;
    }
    if (interactive && lineLength > 0) ctx.environment.stderr(`\r${' '.repeat(lineLength)}\r`);
  };
}

export type Handler = (ctx: Context) => Promise<void>;

export const COMMANDS: Readonly<Record<string, Handler>> = {
  init: async (ctx) => {
    const projectRoot = root(ctx);
    const created: string[] = [];
    const kept: string[] = [];
    for (const file of scaffoldFiles()) {
      const absolute = join(projectRoot, file.path);
      if (existsSync(absolute) && !ctx.parsed.values.force) {
        kept.push(file.path);
        continue;
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, 'utf8');
      created.push(file.path);
    }
    emit(
      ctx,
      { created, kept },
      () =>
        `${created.map((f) => `created ${f}`).join('\n')}${created.length ? '\n' : ''}${kept.map((f) => `kept ${f} (already exists; use --force to overwrite)`).join('\n')}${kept.length ? '\n' : ''}`,
    );
  },

  index: (ctx) =>
    withProject(ctx, { embed: true }, async ({ retriever, embedderReason }) => {
      if (!retriever.embedder)
        ctx.environment.stderr(
          `note: no embedder (${embedderReason}); indexing facts and graph only\n`,
        );
      const scope = ctx.parsed.values.scope;
      const result = await retriever.index({
        onEvent: indexProgress(ctx),
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

  // The embedder is opened so `status` names the model in use; without it every project read as "none".
  status: async (ctx) => {
    const projectRoot = root(ctx);
    const anvesaDir = join(projectRoot, '.anvesa');
    if (!existsSync(anvesaDir)) {
      const unindexedStatus = {
        root: projectRoot,
        indexed: false,
        index: {
          files: 0,
          quarantinedFiles: 0,
          symbols: 0,
          calls: 0,
          imports: 0,
          edges: 0,
          byLanguage: [],
        },
        interrupted: false,
        embedder: undefined,
        structural: { files: 0, missing: [] },
        channels: [],
      };
      emit(ctx, unindexedStatus, () => `project ${projectRoot}\nnot indexed (run: anvesa index)`);
      return;
    }

    await withProject(ctx, { embed: true }, async ({ retriever }) => {
      const status = await retriever.status();
      emit(ctx, status, () => show.renderStatus(status));
    });
  },

  search: (ctx) =>
    withProject(ctx, { embed: true }, async ({ retriever }) => {
      const channels = ctx.parsed.values.channel;
      const exclude = ctx.parsed.values.exclude;
      const weights = parseWeights(ctx.parsed.values.weight);
      const page = await retriever.search(rest(ctx, 0) || need(ctx, 0, 'query'), {
        ...pageRequest(ctx),
        ...(channels ? { channels } : {}),
        ...(exclude ? { exclude } : {}),
        ...(weights ? { weights } : {}),
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
      const limit = integerOption('limit', ctx.parsed.values.limit);
      const result = await retriever.dependents(need(ctx, 0, 'path'), {
        ...(depth === undefined ? {} : { depth }),
        ...(limit === undefined ? {} : { limit }),
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
            `${report.channel}: ${report.reports.length} records (${report.reports.filter((r) => r.outcome === 'indexed').length} indexed), ${report.removed.length} removed\n${
              report.reports.length === 0
                ? "note: this indexes records from the channel's source. Cards from files the channel claims are built by: anvesa index\n"
                : ''
            }`,
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

// --- redteam ---------------------------------------------------------------------------------

export async function redteamCommand(ctx: Context): Promise<void> {
  const [sub] = ctx.parsed.positionals;
  switch (sub) {
    case 'list':
    case 'verify':
      // Opening the project is what checks the policy: its rules, its sources and every fixture.
      return withProject(ctx, { embed: false }, async ({ retriever }) => {
        const rules = await retriever.redTeamRules();
        if (sub === 'verify') {
          const custom = rules.filter((rule) => rule.source !== 'built in');
          emit(
            ctx,
            { ok: true, rules: rules.length, custom: custom.length },
            () =>
              `${rules.length} rules in force, ${custom.length} added by policy, every fixture holds\n`,
          );
          return;
        }
        emit(ctx, rules, () => show.renderRedTeamRules(rules));
      });
    case 'scan':
      return withProject(ctx, { embed: true }, async ({ retriever }) => {
        const scan = await retriever.redTeamScan();
        emit(ctx, scan, () => show.renderRedTeamScan(scan));
        if (scan.quarantined.length > 0) {
          throw new CommandFailedError(
            'redteam scan',
            `${scan.quarantined.length} cards of this project would be quarantined`,
            {
              hint: 'If they are not attacks, loosen the rule that fired in .anvesa/redteam.json.',
            },
          );
        }
      });
    default:
      throw new InvalidArgumentError('redteam', 'list, verify or scan', sub);
  }
}

// --- fragments -------------------------------------------------------------------------------

export async function fragmentsCommand(ctx: Context): Promise<void> {
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
      return withProject(ctx, { embed: false }, async ({ retriever }) => {
        const status = await retriever.fragmentStatus();
        emit(ctx, status, () => show.renderFragmentStatus(status));
      });
    case 'propose':
      return withProject(ctx, { embed: false, monolith: needsMonolith }, async ({ retriever }) => {
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
      });
    case 'enable':
      return withProject(ctx, { embed: false, monolith: needsMonolith }, async ({ retriever }) => {
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
      });
    case 'disable':
      return withProject(ctx, { embed: false, monolith: true }, async ({ retriever }) => {
        await retriever.setFragments(false);
        emit(ctx, { enabled: false }, () => 'sharded indexing is off. Run: anvesa index --force\n');
      });
    case 'settle':
      return withProject(ctx, { embed: false }, async ({ retriever }) => {
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

// --- mapping ---------------------------------------------------------------------------------

export async function mappingCommand(ctx: Context): Promise<void> {
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
      const samples = ctx.parsed.values.samples;
      if (!samples || samples.length === 0) {
        throw new InvalidArgumentError(
          '--samples',
          'a file or folder of code to learn from',
          undefined,
        );
      }
      const minShare = ctx.parsed.values['min-share'];
      const result = await trainLanguage(
        root(ctx),
        {
          language,
          samples: samples.map((sample) => resolve(ctx.environment.cwd, sample)),
          ...(ctx.parsed.values.name ? { name: ctx.parsed.values.name } : {}),
          ...(ctx.parsed.values.user ? { user: true } : {}),
          ...(ctx.parsed.values['dry-run'] ? { dryRun: true } : {}),
          ...(ctx.parsed.values.force ? { force: true } : {}),
          ...(minShare === undefined ? {} : { minShare: Number(minShare) }),
        },
        host,
      );
      emit(ctx, result, () => show.renderTraining(result));
      if (result.refused !== undefined && !ctx.parsed.values['dry-run']) {
        throw new CommandFailedError('mapping train', result.refused);
      }
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
        'list, show, train, fork, lock, remove, verify or check',
        sub,
      );
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
      const pooling = ctx.parsed.values.pooling;
      if (pooling !== undefined && pooling !== 'mean' && pooling !== 'cls') {
        throw new InvalidArgumentError('--pooling', 'mean or cls', pooling);
      }
      const maxTokens = integerOption('max-tokens', ctx.parsed.values['max-tokens']);
      const installed = await installModel(cache, id, {
        ...(from ? { from } : {}),
        ...(ctx.parsed.values.download ? { download: true } : {}),
        ...(pooling ? { pooling } : {}),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(ctx.parsed.values.force ? { replace: true } : {}),
      });
      emit(
        ctx,
        installed,
        () =>
          `installed ${installed.id} in ${isAbsolute(installed.directory) ? installed.directory : resolve(installed.directory)}\n`,
      );
      return;
    }
    case 'verify': {
      const id = need(inner, 0, 'model');
      const verified = await verifyModel(cache, id);
      emit(ctx, verified, () => `${id}: every file matches its recorded checksum\n`);
      return;
    }
    default:
      throw new InvalidArgumentError('model', 'list, install, verify or doctor', sub);
  }
}

// --- pattern ---------------------------------------------------------------------------------

export async function patternCommand(ctx: Context): Promise<void> {
  const [sub, name, ...rawArgs] = ctx.parsed.positionals;
  if (!sub || (sub !== 'list' && sub !== 'run')) {
    throw new InvalidArgumentError('pattern', 'list or run', sub);
  }
  return withProject(ctx, { embed: false }, async ({ retriever }) => {
    if (sub === 'list') {
      const patterns = await retriever.patterns.list();
      emit(ctx, patterns, () => show.renderPatterns(patterns));
      return;
    }
    if (!name) {
      throw new InvalidArgumentError(
        'name',
        'a pattern name to run (see: anvesa pattern list)',
        undefined,
      );
    }
    const args: Record<string, string> = {};
    for (const arg of rawArgs) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        args[arg.slice(0, eq)] = arg.slice(eq + 1);
      }
    }
    const limit = integerOption('limit', ctx.parsed.values.limit);
    const result = await retriever.patterns.run(name, args, {
      ...(limit === undefined ? {} : { limit }),
      ...(ctx.parsed.values.cursor === undefined ? {} : { cursor: ctx.parsed.values.cursor }),
    });
    emit(ctx, result, () => show.renderPatternResult(result));
  });
}
