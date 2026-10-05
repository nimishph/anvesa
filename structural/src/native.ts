import {
  type FileInput,
  loadRustSyntax,
  type NapiEncodeOptions,
  nativeLanguageKeys,
} from '@cntxt-labs/anvesa-syntax';
import type { EncodeStats } from './encode.ts';
import { NativeExtractionError } from './errors.ts';
import type { LanguageMapping } from './mapping.ts';
import type { WNode } from './node.ts';

/**
 * Outlines built by the native addon (`crates/anvesa-syntax/src/outline.rs`) from the same
 * `LanguageMapping` the TypeScript encoder reads. Only the grammars compiled into the addon are
 * served; for anything else these return `undefined` and the caller encodes on web-tree-sitter.
 */

/** A symbol as the native side reports it, with its lines rather than a node reference. */
export interface NativeSymbol {
  readonly kind: string;
  readonly name: string;
  readonly baseName: string;
  readonly parentName: string;
  readonly line: number;
  readonly endLine: number;
  readonly doc: string | null;
  readonly signature: string | null;
  readonly params: string | null;
  readonly exported: boolean | null;
  readonly aliasOf: string | null;
}

export interface NativeEncoded {
  readonly root: WNode;
  readonly stats: EncodeStats;
  readonly hasSyntaxErrors: boolean;
  readonly symbols: readonly NativeSymbol[];
}

interface RawNode {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: readonly RawNode[];
}

interface RawEncoded {
  readonly root: RawNode;
  readonly stats: { readonly nodes: number; readonly deepest: number; readonly omitted: number };
  readonly hasErrors: boolean;
  readonly symbols: readonly NativeSymbol[];
}

/** Rebuild outline nodes iteratively, so a deep outline does not grow the call stack. */
function toWNode(raw: RawNode): WNode {
  const make = (node: RawNode) => ({
    tag: node.tag,
    attrs: new Map(Object.entries(node.attrs)),
    children: [] as WNode[],
  });
  const root = make(raw);
  const pending: [RawNode, WNode[]][] = [[raw, root.children]];
  while (pending.length > 0) {
    const [node, into] = pending.pop() as [RawNode, WNode[]];
    for (const child of node.children) {
      const built = make(child);
      into.push(built);
      pending.push([child, built.children]);
    }
  }
  return root;
}

function fromJson(json: string, maxDepth: number | undefined): NativeEncoded {
  const raw = JSON.parse(json) as RawEncoded;
  const stats: EncodeStats = {
    nodes: raw.stats.nodes,
    deepest: raw.stats.deepest,
    omitted: raw.stats.omitted,
    ...(maxDepth === undefined
      ? {}
      : {
          depthLimit: {
            name: 'maxDepth',
            applied: maxDepth,
            source: 'caller' as const,
            reached: raw.stats.omitted > 0,
          },
        }),
  };
  return { root: toWNode(raw.root), stats, hasSyntaxErrors: raw.hasErrors, symbols: raw.symbols };
}

const mappingJson = new WeakMap<LanguageMapping, string>();

/** A mapping as the addon reads it, serialised once per mapping object. */
export function mappingJsonOf(mapping: LanguageMapping): string {
  let json = mappingJson.get(mapping);
  if (json === undefined) {
    json = JSON.stringify(mapping);
    mappingJson.set(mapping, json);
  }
  return json;
}

/** Whether `language` is parsed natively, with a grammar compiled into the addon. */
export function isNativeLanguage(language: string): boolean {
  return nativeLanguageKeys().has(language);
}

/** Whether the loaded addon can build outlines from mappings. */
export function isNativeOutlineAvailable(): boolean {
  return typeof loadRustSyntax()?.encodeOutlineNative === 'function';
}

/** One file's outline, built natively; `undefined` when the addon or the grammar is not there. */
export function encodeNative(
  source: string,
  language: string,
  mapping: LanguageMapping,
  options: NapiEncodeOptions = {},
): NativeEncoded | undefined {
  const encode = loadRustSyntax()?.encodeOutlineNative;
  if (!encode) return undefined;
  const json = encode(source, language, mappingJsonOf(mapping), options);
  return json === null ? undefined : fromJson(json, options.maxDepth);
}

/** One parse, natively: the outline (docs and positions on) and the indexing facts, as data. */
export interface NativeExtracted {
  readonly root: WNode;
  readonly stats: EncodeStats;
  /** The facts as the indexer defines them; this package does not know their shape. */
  readonly facts: unknown;
}

export function extractFactsNative(
  path: string,
  language: string,
  source: string,
  mapping: LanguageMapping,
): NativeExtracted | undefined {
  const extract = loadRustSyntax()?.extractFactsNative;
  if (!extract) return undefined;
  const json = extract(path, language, source, mappingJsonOf(mapping));
  if (json === null) return undefined;
  return fromExtractedJson(json);
}

/** One file to extract with {@link extractFactsNativeMany}. */
export interface NativeExtractInput {
  readonly path: string;
  readonly language: string;
  readonly source: string;
  readonly mapping: LanguageMapping;
}

/**
 * {@link extractFactsNative} for many files at once, on every core and away from the JavaScript
 * thread. One entry per file, in order: its facts, `undefined` where native extraction cannot serve
 * it (as `extractFactsNative` returns), or the error extracting it raised. `undefined` as a whole
 * when the addon has no such function (one built before it), so the caller goes file by file.
 */
export async function extractFactsNativeMany(
  files: readonly NativeExtractInput[],
): Promise<(NativeExtracted | undefined | Error)[] | undefined> {
  const extract = loadRustSyntax()?.extractFactsManyNative;
  if (!extract) return undefined;
  const outcomes = await extract(
    files.map(({ path, language, source }) => ({ path, language, source })),
    mappingsJsonOf(files),
  );
  return outcomes.map((outcome, index) => {
    if (outcome.error !== undefined) {
      return new NativeExtractionError(files[index]?.path ?? '', outcome.error);
    }
    if (outcome.json === undefined) return undefined;
    try {
      return fromExtractedJson(outcome.json);
    } catch (failure) {
      return new NativeExtractionError(files[index]?.path ?? '', 'its facts are not readable', {
        cause: failure,
      });
    }
  });
}

/** A file as the index keeps it: its facts, and its outline already printed as W-expression text. */
export interface NativeIndexed {
  /** The facts as the indexer defines them; this package does not know their shape. */
  readonly facts: unknown;
  readonly wexpr: string;
}

/**
 * {@link extractFactsNativeMany}, but each file comes back as the index keeps it: the outline is
 * printed as W-expression text natively (the same text `serializeWExpr` gives, without the
 * attributes in `omit`), so it is never rebuilt as objects here. `undefined` as a whole when the
 * addon has no such function.
 */
export async function extractForIndexNativeMany(
  files: readonly NativeExtractInput[],
  omit: readonly string[],
): Promise<(NativeIndexed | undefined | Error)[] | undefined> {
  const extract = loadRustSyntax()?.extractForIndexManyNative;
  if (!extract) return undefined;
  const outcomes = await extract(
    files.map(({ path, language, source }) => ({ path, language, source })),
    mappingsJsonOf(files),
    omit,
  );
  return outcomes.map((outcome, index) => {
    const path = files[index]?.path ?? '';
    if (outcome.error !== undefined) return new NativeExtractionError(path, outcome.error);
    if (outcome.facts === undefined || outcome.wexpr === undefined) return undefined;
    try {
      return { facts: JSON.parse(outcome.facts) as unknown, wexpr: outcome.wexpr };
    } catch (failure) {
      return new NativeExtractionError(path, 'its facts are not readable', { cause: failure });
    }
  });
}

/** The mappings of the files' languages, as one JSON object keyed by language. */
function mappingsJsonOf(files: readonly NativeExtractInput[]): string {
  const mappings: Record<string, string> = {};
  for (const file of files) mappings[file.language] ??= mappingJsonOf(file.mapping);
  return `{${Object.entries(mappings)
    .map(([language, json]) => `${JSON.stringify(language)}:${json}`)
    .join(',')}}`;
}

function fromExtractedJson(json: string): NativeExtracted {
  const raw = JSON.parse(json) as { root: RawNode; stats: RawEncoded['stats']; facts: unknown };
  return {
    root: toWNode(raw.root),
    stats: { nodes: raw.stats.nodes, deepest: raw.stats.deepest, omitted: raw.stats.omitted },
    facts: raw.facts,
  };
}

/** Many files' outlines on every core; an entry is `undefined` where native encoding cannot serve it. */
export function encodeNativeBatch(
  files: readonly FileInput[],
  mappings: Readonly<Record<string, LanguageMapping>>,
  options: Omit<NapiEncodeOptions, 'path'> = {},
): (NativeEncoded | undefined)[] | undefined {
  const encode = loadRustSyntax()?.encodeOutlinesBatchNative;
  if (!encode) return undefined;
  return encode(files, JSON.stringify(mappings), options).map((json) =>
    json === null ? undefined : fromJson(json, options.maxDepth),
  );
}
