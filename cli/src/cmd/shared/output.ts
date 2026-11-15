import { InvalidArgumentError, type PageRequest } from '@cntxt-labs/anvesa-core';
import type { Retriever } from '@cntxt-labs/anvesa-retriever';
import { integerOption } from '../../options.ts';
import * as show from '../../render.ts';
import { telemetryModelId } from '../../telemetry.ts';
import type { Context } from './context.ts';

export function emit(ctx: Context, value: unknown, text: () => string): void {
  ctx.environment.stdout(ctx.parsed.values.json ? show.toJson(value) : text());
}

/** The model a telemetry event may name: built in by id, brought in by the person as `custom`. */
export function modelField(retriever: Retriever): { readonly modelId?: string } {
  const model = telemetryModelId(retriever.embedder?.info.id);
  return model ? { modelId: model } : {};
}

export function need(ctx: Context, index: number, what: string): string {
  const value = ctx.parsed.positionals[index];
  if (value === undefined || value === '') {
    throw new InvalidArgumentError(what, 'a value (see: anvesa --help)', undefined);
  }
  return value;
}

export const rest = (ctx: Context, from: number): string =>
  ctx.parsed.positionals.slice(from).join(' ');

export function pageRequest(ctx: Context): PageRequest {
  const limit = integerOption('limit', ctx.parsed.values.limit);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(ctx.parsed.values.cursor === undefined ? {} : { cursor: ctx.parsed.values.cursor }),
  };
}

/**
 * What a search, retrieve or query ran against: the query, the model, the index's size and how
 * long it took. A terminal shows it as the header line, JSON carries it as `_meta`; anything else
 * (piped text) does not read it at all.
 */
export async function searchFacts(
  ctx: Context,
  retriever: Retriever,
  query: string,
  startedAt: number,
): Promise<show.SearchHeader | undefined> {
  const json = ctx.parsed.values.json === true || resolveFormat(ctx) === 'json';
  if (!json && ctx.environment.isTTY !== true) return undefined;
  return resultFacts(retriever, query, startedAt);
}

/** The facts themselves; the MCP tools send them as `_meta` with every result page. */
export async function resultFacts(
  retriever: Retriever,
  query: string,
  startedAt: number,
  options: { readonly structural?: boolean } = {},
): Promise<show.SearchHeader> {
  const elapsedMs = performance.now() - startedAt;
  // A WQL query with no semantic part used no model, whether or not one is loaded.
  const info = options.structural ? undefined : retriever.embedder?.info;
  const [stats, models] = await Promise.all([retriever.store.stats(), retriever.indexedModels()]);
  const cards = info
    ? (models.find((row) => row.model === info.id)?.cards ?? 0)
    : models.reduce((sum, row) => sum + row.cards, 0);
  return {
    query,
    model: info ? { id: info.id, dimensions: info.dimensions } : undefined,
    files: stats.files,
    cards,
    elapsedMs,
  };
}

/**
 * Print a page of results: as JSON with the facts as `_meta`, or as text, with the facts as the
 * header line on a terminal.
 */
export function emitResults(
  ctx: Context,
  page: object,
  facts: show.SearchHeader | undefined,
  render: (options: show.RenderOptions) => string,
): void {
  const items = (page as { readonly items?: unknown }).items;
  if (Array.isArray(items)) ctx.onResults?.(items.length);
  const format = resolveFormat(ctx);
  if (format === 'json') {
    const value = facts ? { ...page, _meta: show.metaOf(facts) } : page;
    emit(ctx, value, () => show.toJson(value));
    return;
  }
  const isTTY = ctx.environment.isTTY === true;
  emit(ctx, page, () =>
    render({
      mode: format,
      full: ctx.parsed.values.full === true,
      isTTY,
      header: isTTY ? facts : undefined,
    }),
  );
}

/** `--scope` for a search, query or retrieve (checked once, in runCli). */
export function scopeOption(ctx: Context): { readonly scope?: string } {
  const scope = ctx.parsed.values.scope;
  return scope === undefined ? {} : { scope };
}

/** `--weight docs=0.25` (repeatable) as a lane-to-weight map. */
export function parseWeights(
  entries: readonly string[] | undefined,
): Record<string, number> | undefined {
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

export function resolveFormat(ctx: Context): show.FormatMode {
  if (ctx.parsed.values.json) return 'json';
  if (ctx.parsed.values.compact) return 'compact';
  const format = ctx.parsed.values.format;
  if (format !== undefined) {
    if (!['compact', 'pretty', 'locations', 'json'].includes(format)) {
      throw new InvalidArgumentError('--format', 'compact, pretty, locations, or json', format);
    }
    return format as show.FormatMode;
  }
  return 'pretty';
}
