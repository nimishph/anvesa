import { InvalidArgumentError, type Page, type PageRequest } from '@cntxt-labs/anvesa-core';
import type { FileFacts, SymbolFact } from '../extract/facts.ts';
import type { Confidence, EdgeRecord, IndexStore } from '../store/index.ts';
import type { WorkspacePackage } from '../workspace/discover.ts';
import { CALL_EDGE_KINDS, EDGE, IMPORT_EDGE_KINDS } from './edges.ts';

/** What a reader needs to recognise a symbol without opening its file. */
export interface SymbolBrief {
  readonly name: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string | undefined;
}

/** A call into a symbol. */
export interface CallerRef {
  /** The symbol id of the caller, or the file path for a call made outside any symbol. */
  readonly from: string;
  /** The file the call is in. */
  readonly path: string;
  /** `calls` was resolved through scope or imports; `calls:name` is a guess by name. */
  readonly evidence: 'resolved' | 'name';
  /** `exact` from scope or imports, `inferred` through a declared type, `guess` by name alone. */
  readonly confidence: Confidence;
  readonly package: string | undefined;
  /** The caller lives in a different workspace package than the symbol it calls. */
  readonly crossPackage: boolean;
  /** The calling symbol's own lines and signature; absent for a call made outside any symbol. */
  readonly symbol: SymbolBrief | undefined;
  /** Lines in the caller's file that call the name (several when it is called more than once). */
  readonly callLines: readonly number[];
}

/** A call out of a symbol or file. */
export interface CalleeRef {
  /** A symbol id, `package#name` for something external, or the called name when unresolved. */
  readonly to: string;
  readonly kind: 'resolved' | 'name' | 'external' | 'unresolved';
  readonly confidence: Confidence;
  /** The called symbol's lines and signature, when it is one this workspace holds. */
  readonly symbol: SymbolBrief | undefined;
  /** Lines, in the calling symbol's file, where it makes this call. */
  readonly callLines: readonly number[];
}

export interface Dependent {
  readonly path: string;
  /** 1 imports the file directly; 2 imports something that does; and so on. */
  readonly depth: number;
}

export interface DependentsOptions {
  /** How many import hops to follow. 1 (the default) is direct importers only. */
  readonly depth?: number;
  /** Maximum number of dependents to return. */
  readonly limit?: number;
  /** Count files that import only types. Off, a type-only importer is not a dependent. */
  readonly includeTypeOnly?: boolean;
}

export interface DependentsResult {
  readonly dependents: readonly Dependent[];
  /** Importers exist beyond the depth that was asked for. */
  readonly moreBeyondDepth: boolean;
}

export type FileChange = 'added' | 'modified' | 'removed';

const RUNTIME_IMPORT_KINDS: readonly string[] = [EDGE.imports, EDGE.reexports, EDGE.importsAsset];

/**
 * Questions about the graph the linker wrote: who calls what, what depends on what, and which
 * files must be re-linked when others change. Reads only; the store holds the answers.
 */
export class GraphQueries {
  readonly #store: IndexStore;
  readonly #packageOf: (path: string) => WorkspacePackage | undefined;

  /** `packageOf` lets results say which package a file is in, and flag calls across packages. */
  constructor(
    store: IndexStore,
    packageOf: (path: string) => WorkspacePackage | undefined = () => undefined,
  ) {
    this.#store = store;
    this.#packageOf = packageOf;
  }

  /** Who calls `symbolId`. Guesses by name are included and marked; ask for resolved only if needed. */
  async callers(
    symbolId: string,
    request: PageRequest & { readonly resolvedOnly?: boolean } = {},
  ): Promise<Page<CallerRef>> {
    const target = await this.#store.symbol(symbolId);
    const targetPackage = target ? this.#packageOf(target.path)?.root : undefined;
    const page = await this.#store.findEdges({
      to: symbolId,
      kinds: request.resolvedOnly ? [EDGE.calls] : CALL_EDGE_KINDS,
      ...pageRequest(request),
    });
    const items: CallerRef[] = [];
    const facts = new FactsCache(this.#store);
    for (const edge of page.items) {
      const caller = await this.#store.symbol(edge.from);
      const path = caller ? caller.path : edge.from;
      const pkg = this.#packageOf(path);
      items.push({
        from: edge.from,
        path,
        evidence: edge.kind === EDGE.calls ? 'resolved' : 'name',
        confidence: confidenceOf(edge),
        package: pkg?.name,
        crossPackage: target !== undefined && pkg?.root !== targetPackage,
        symbol: caller ? briefOf(caller) : undefined,
        callLines: target
          ? await callLines(facts, path, caller ? edge.from : undefined, [target.baseName])
          : [],
      });
    }
    return { ...page, items };
  }

  /** What a symbol (or a file, for calls outside any symbol) calls, including what is unresolved. */
  async callees(from: string, request: PageRequest = {}): Promise<Page<CalleeRef>> {
    const page = await this.#store.findEdges({
      from,
      kinds: [EDGE.calls, EDGE.callsByName, EDGE.callsExternal, EDGE.callsUnresolved],
      ...pageRequest(request),
    });
    const origin = await this.#store.symbol(from);
    const originPath = origin ? origin.path : from;
    const facts = new FactsCache(this.#store);
    const items: CalleeRef[] = [];
    for (const edge of page.items) {
      const kind = calleeOf(edge);
      const callee =
        kind === 'resolved' || kind === 'name' ? await this.#store.symbol(edge.to) : undefined;
      items.push({
        to: edge.to,
        kind,
        confidence: confidenceOf(edge),
        symbol: callee ? briefOf(callee) : undefined,
        callLines: await callLines(facts, originPath, origin ? from : undefined, [
          ...(callee ? [callee.baseName] : []),
          edge.to,
          lastSegment(edge.to),
        ]),
      });
    }
    return { ...page, items };
  }

  /** Files that import `path`, and optionally the files that import those. */
  async dependents(path: string, options: DependentsOptions = {}): Promise<DependentsResult> {
    const depthLimit = options.depth ?? 1;
    if (
      depthLimit !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(depthLimit) || depthLimit < 1)
    ) {
      throw new InvalidArgumentError('depth', 'a positive whole number, or Infinity', depthLimit);
    }
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1)
    ) {
      throw new InvalidArgumentError('limit', 'a positive whole number', options.limit);
    }
    const kinds = options.includeTypeOnly ? IMPORT_EDGE_KINDS : RUNTIME_IMPORT_KINDS;
    const seen = new Set<string>([path]);
    const found: Dependent[] = [];
    let frontier = [path];

    for (let depth = 1; depth <= depthLimit && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const file of frontier) {
        for await (const edge of this.#edgesTo(file, kinds)) {
          if (seen.has(edge.from)) continue;
          seen.add(edge.from);
          found.push({ path: edge.from, depth });
          next.push(edge.from);
        }
      }
      frontier = next;
    }

    // Whatever imports the last files reached is what the depth left out.
    let moreBeyondDepth = false;
    for (const file of frontier) {
      for await (const edge of this.#edgesTo(file, kinds)) {
        if (!seen.has(edge.from)) {
          moreBeyondDepth = true;
          break;
        }
      }
      if (moreBeyondDepth) break;
    }
    found.sort((x, y) => x.depth - y.depth || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    const dependents = options.limit !== undefined ? found.slice(0, options.limit) : found;
    return { dependents, moreBeyondDepth };
  }

  /** The files `path` imports, in the workspace. */
  async dependencies(path: string, request: PageRequest = {}): Promise<Page<string>> {
    const page = await this.#store.findEdges({
      from: path,
      kinds: [...IMPORT_EDGE_KINDS],
      ...pageRequest(request),
    });
    return { ...page, items: page.items.map((edge) => edge.to) };
  }

  /** Callers and callees of a symbol, together. */
  async neighbors(
    symbolId: string,
    request: PageRequest = {},
  ): Promise<{ callers: Page<CallerRef>; callees: Page<CalleeRef> }> {
    const [callers, callees] = await Promise.all([
      this.callers(symbolId, request),
      this.callees(symbolId, request),
    ]);
    return { callers, callees };
  }

  /** Imports that should have resolved inside the workspace and did not. */
  async danglingImports(request: PageRequest = {}): Promise<Page<EdgeRecord>> {
    return this.#store.findEdges({ kind: EDGE.importsDangling, ...pageRequest(request) });
  }

  /**
   * The files whose links may have changed because other files did, so an incremental run knows
   * what to link again. Importers of a changed file see different exports; importers of a file
   * that re-exports it see them second-hand. When a file appears or disappears, files with
   * dangling imports are included, since one of them may now resolve (or an importer now dangle).
   * The changed files themselves are not in the result; they are linked anyway.
   */
  async relinkSet(changes: ReadonlyMap<string, FileChange>): Promise<string[]> {
    const result = new Set<string>();
    const queue = [...changes.keys()];
    const visited = new Set(queue);
    while (queue.length > 0) {
      const file = queue.pop() as string;
      for await (const edge of this.#edgesTo(file, [...IMPORT_EDGE_KINDS])) {
        result.add(edge.from);
        // A re-exporter's own importers depend on the changed file through it.
        if (edge.kind === EDGE.reexports && !visited.has(edge.from)) {
          visited.add(edge.from);
          queue.push(edge.from);
        }
      }
    }
    const membershipChanged = [...changes.values()].some((change) => change !== 'modified');
    if (membershipChanged) {
      for await (const edge of this.#allEdges({ kind: EDGE.importsDangling }))
        result.add(edge.from);
    }
    for (const path of changes.keys()) result.delete(path);
    return [...result].sort();
  }

  #edgesTo(to: string, kinds: readonly string[]): AsyncGenerator<EdgeRecord> {
    return this.#allEdges({ to, kinds });
  }

  /** Every edge matching, across all pages. */
  async *#allEdges(query: {
    readonly to?: string;
    readonly kind?: string;
    readonly kinds?: readonly string[];
  }): AsyncGenerator<EdgeRecord> {
    let cursor: string | undefined;
    do {
      const page: Page<EdgeRecord> = await this.#store.findEdges({
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      });
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }
}

function pageRequest(request: PageRequest): PageRequest {
  return {
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

/** What an edge says of itself; an edge stored before confidence existed is read by its kind. */
function confidenceOf(edge: EdgeRecord): Confidence {
  return edge.confidence ?? (edge.kind === EDGE.callsByName ? 'guess' : 'exact');
}

function calleeOf(edge: EdgeRecord): CalleeRef['kind'] {
  switch (edge.kind) {
    case EDGE.calls:
      return 'resolved';
    case EDGE.callsByName:
      return 'name';
    case EDGE.callsExternal:
      return 'external';
    default:
      return 'unresolved';
  }
}

function briefOf(symbol: SymbolFact): SymbolBrief {
  return {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    signature: symbol.signature,
  };
}

/** `pkg#name` and `Outer.method` both end in the name that was written at the call. */
function lastSegment(text: string): string {
  return text.split(/[#.]/).at(-1) ?? text;
}

/** File facts read once per query however many edges land in the same file. */
class FactsCache {
  readonly #store: IndexStore;
  readonly #byPath = new Map<string, Promise<FileFacts | undefined>>();

  constructor(store: IndexStore) {
    this.#store = store;
  }

  of(path: string): Promise<FileFacts | undefined> {
    let facts = this.#byPath.get(path);
    if (!facts) {
      facts = this.#store.facts(path);
      this.#byPath.set(path, facts);
    }
    return facts;
  }
}

/** The lines in `path` where `from` (or the file itself, when undefined) calls any of `names`. */
async function callLines(
  facts: FactsCache,
  path: string,
  from: string | undefined,
  names: readonly string[],
): Promise<number[]> {
  const file = await facts.of(path);
  if (!file) return [];
  const wanted = new Set(names);
  return [
    ...new Set(
      file.calls.filter((call) => call.from === from && wanted.has(call.name)).map((c) => c.line),
    ),
  ].sort((a, b) => a - b);
}
