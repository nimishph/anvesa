import { resolve } from 'node:path';
import { InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
import {
  type Embedder,
  loadProjectConfig,
  ModelCache,
  modelsDirectory,
  openProjectEmbedder,
  Retriever,
} from '@cntxt-labs/anvesa-retriever';
import type { Environment } from '../../environment.ts';
import type { Parsed } from '../../options.ts';
import { findProjectRoot } from '../../project-root.ts';
import { refreshInstalledSkills } from '../../skill.ts';
import {
  clearGlobalTelemetry,
  createTelemetryCollector,
  recordRanking,
  setGlobalTelemetry,
} from '../../telemetry.ts';

/** How a command opens the project. */
export interface SessionOptions {
  readonly embed: boolean;
  readonly monolith?: boolean;
  /** False where nobody reads stderr (the MCP server): the telemetry notice waits for a terminal. */
  readonly telemetryNotice?: boolean;
  /** Print the one-line telemetry notice when telemetry is on (index, search, query). */
  readonly telemetryReminder?: boolean;
}

export interface Context {
  readonly environment: Environment;
  readonly parsed: Parsed;
  /** Told when a long-running command (a server) is serving: it is counted then. */
  readonly onServing?: (() => void) | undefined;
  /** Told how many results a command returned, for the local usage record (see usage.ts). */
  readonly onResults?: ((count: number) => void) | undefined;
}

export interface Session {
  readonly retriever: Retriever;
  readonly embedderReason: string;
  close(): Promise<void>;
}

/** Where `init` scaffolds: `--root`, else the current directory. It never walks up. */
export const startDirectory = (ctx: Context): string =>
  resolve(ctx.environment.cwd, ctx.parsed.values.root ?? '.');

/** The project: `--root` exactly as given, else the nearest enclosing one (see findProjectRoot). */
export const root = (ctx: Context): string =>
  ctx.parsed.values.root === undefined
    ? findProjectRoot(ctx.environment.cwd, ctx.environment.env)
    : startDirectory(ctx);

export function modelCache(ctx: Context): ModelCache {
  return new ModelCache(
    ctx.parsed.values.models
      ? resolve(ctx.environment.cwd, ctx.parsed.values.models)
      : modelsDirectory(ctx.environment.env),
  );
}

/** Open the project, with an embedder if a model is installed and one is wanted. */
export async function openSession(ctx: Context, options: SessionOptions): Promise<Session> {
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
      onRanking: recordRanking,
    });
    // An upgrade is worth a line of its own: it says the index changed under the user's feet, and
    // it names the copy of the old one, which is the way back if this version turns out to be wrong.
    for (const backup of retriever.indexBackups) {
      ctx.environment.stderr(
        `note: ${backup.path} upgraded from schema ${backup.from} to ${backup.to}; the index as it was is at ${backup.backupPath}\n`,
      );
    }
    const telemetry = createTelemetryCollector({
      config,
      noNetwork: ctx.parsed.values['no-network'] === true,
      env: ctx.environment.env,
      ...(options.telemetryNotice === false
        ? {}
        : { notice: (text: string) => ctx.environment.stderr(text) }),
      // Not with --json: a script reading the output has nobody to tell.
      ...(options.telemetryReminder && options.telemetryNotice !== false && !ctx.parsed.values.json
        ? { reminder: (text: string) => ctx.environment.stderr(text) }
        : {}),
    });
    setGlobalTelemetry(telemetry);

    return {
      retriever,
      embedderReason,
      close: async () => {
        await telemetry.close();
        // Later records must not go to a collector nobody will flush.
        clearGlobalTelemetry(telemetry);
        await retriever.close();
        await embedder?.dispose();
      },
    };
  } catch (failure) {
    await embedder?.dispose();
    throw failure;
  }
}

/**
 * An installed skill older than this anvesa is brought up to date, without a word: the person
 * installed it to keep it. One that is not installed stays that way.
 */
export function refreshSkills(ctx: Context): void {
  try {
    refreshInstalledSkills(root(ctx), ctx.environment.env);
  } catch (failure) {
    ctx.environment.stderr(
      `note: the installed anvesa skill could not be refreshed: ${toCodeLensError(failure, 'refresh the skill').message}\n`,
    );
  }
}

/** Run a command against an open project, and close it whatever happens. */
export async function withProject<T>(
  ctx: Context,
  options: SessionOptions,
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await openSession(ctx, options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

/**
 * `--federated` and `--repo` reach other repositories only from search and dependents. Elsewhere
 * they were ignored, or failed on a channel only another repository had (#51): say so instead.
 */
export function onlyLocal(ctx: Context, command: string): void {
  if (ctx.parsed.values.federated === true || (ctx.parsed.values.repo?.length ?? 0) > 0) {
    throw new InvalidArgumentError(
      '--federated',
      `search or dependents: ${command} reads this repository only`,
      ctx.parsed.values.repo?.join(', ') ?? 'true',
    );
  }
}
