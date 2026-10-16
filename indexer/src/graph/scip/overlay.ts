import { ATTR, parseWExpr, WEXPR_FORMAT_VERSION, walk } from '@cntxt-labs/anvesa-structural';
import type { SymbolFact } from '../../extract/facts.ts';
import type { EdgeRecord, IndexStore } from '../../store/index.ts';
import { EDGE } from '../edges.ts';
import { descriptorName, SCIP_ROLE, type ScipDocument, startLine } from './decode.ts';

/**
 * Experimental: lay a SCIP index over the graph. For each file the index covers, the linker's call
 * edges (resolved, by name, unresolved) are replaced by the references the compiler resolved;
 * import and external edges stay as the linker wrote them.
 *
 * An edge starts at the innermost symbol whose span holds the reference (the file itself outside
 * every symbol) and ends at the symbol whose definition SCIP points to, found by file, line and
 * name among anvesa's own symbols. SCIP symbols are only a key here: ids stay anvesa's.
 */
export interface ScipOverlayReport {
  readonly documents: number;
  /** Documents of files the index does not hold, or holds as changed since the SCIP index was made. */
  readonly skipped: number;
  readonly definitions: number;
  /** Definitions matched to one of anvesa's symbols. */
  readonly mapped: number;
  readonly edges: { readonly calls: number; readonly types: number; readonly values: number };
  /** Call edges the overlay replaced: the linker's, or a previous overlay's on a re-run. */
  readonly replaced: number;
}

/** Symbol kinds a reference to which is a call edge; the rest are type or value references. */
const CALLABLE = new Set(['function', 'method', 'class', 'component', 'struct']);
const TYPE_LIKE = new Set(['type', 'interface', 'enum', 'trait']);
/**
 * Edge kinds the overlay rewrites: the linker's calls, which a SCIP index has better evidence for,
 * and its own reference kinds, so applying it again replaces them instead of adding to them.
 */
const REPLACED = new Set<string>([
  EDGE.calls,
  EDGE.callsByName,
  EDGE.callsUnresolved,
  EDGE.referencesType,
  EDGE.references,
]);
/** The linker's call kinds among them, which the report counts. */
const LINKER_CALLS = new Set<string>([EDGE.calls, EDGE.callsByName, EDGE.callsUnresolved]);

async function allEdgesFrom(store: IndexStore, from: string): Promise<EdgeRecord[]> {
  const edges: EdgeRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.findEdges({ from, ...(cursor ? { cursor } : {}) });
    edges.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return edges;
}

/** Every line an import statement of `path` spans, from its W-expression. */
async function importLines(store: IndexStore, path: string): Promise<ReadonlySet<number>> {
  const lines = new Set<number>();
  const text = await store.wexpr(path, WEXPR_FORMAT_VERSION);
  if (text === undefined) return lines;
  for (const { node } of walk(parseWExpr(text))) {
    if (node.tag !== 'import') continue;
    const start = Number(node.attrs.get(ATTR.line));
    const end = Number(node.attrs.get(ATTR.endLine) ?? start);
    for (let line = start; line <= end; line += 1) lines.add(line);
  }
  return lines;
}

/** The innermost symbol whose span holds a 1-based `line`, optionally only those named `name`. */
function innermost(
  symbols: readonly SymbolFact[],
  line: number,
  name?: string,
): SymbolFact | undefined {
  let best: SymbolFact | undefined;
  for (const symbol of symbols) {
    if (symbol.startLine > line || symbol.endLine < line) continue;
    if (name !== undefined && symbol.baseName !== name) continue;
    if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
  }
  return best;
}

export async function applyScipOverlay(
  store: IndexStore,
  documents: readonly ScipDocument[],
  options: { readonly indexedAtMs?: number } = {},
): Promise<ScipOverlayReport> {
  // Only files the index holds unchanged since the SCIP index was written: an edge from an edited
  // file would point at lines that moved.
  const symbolsOf = new Map<string, readonly SymbolFact[]>();
  const importLinesOf = new Map<string, ReadonlySet<number>>();
  let skipped = 0;
  for (const document of documents) {
    const state = await store.fileState(document.path);
    const facts = state ? await store.facts(document.path) : undefined;
    if (
      !state ||
      !facts ||
      (options.indexedAtMs !== undefined && state.mtimeMs > options.indexedAtMs)
    ) {
      skipped += 1;
      continue;
    }
    symbolsOf.set(document.path, facts.symbols);
    importLinesOf.set(document.path, await importLines(store, document.path));
  }

  const target = new Map<string, SymbolFact>();
  let definitions = 0;
  for (const document of documents) {
    const symbols = symbolsOf.get(document.path);
    if (!symbols) continue;
    for (const occurrence of document.occurrences) {
      if (!(occurrence.roles & SCIP_ROLE.definition) || occurrence.symbol.startsWith('local '))
        continue;
      definitions += 1;
      const found = innermost(
        symbols,
        startLine(occurrence) + 1,
        descriptorName(occurrence.symbol),
      );
      if (found && !target.has(occurrence.symbol)) target.set(occurrence.symbol, found);
    }
  }

  const counts = { calls: 0, types: 0, values: 0 };
  let replaced = 0;
  for (const document of documents) {
    const symbols = symbolsOf.get(document.path);
    if (!symbols) continue;
    const found = new Map<string, EdgeRecord & { lines: number[] }>();
    for (const occurrence of document.occurrences) {
      if (occurrence.roles & (SCIP_ROLE.definition | SCIP_ROLE.import)) continue;
      const to = target.get(occurrence.symbol);
      if (!to) continue;
      const line = startLine(occurrence) + 1;
      // An imported name is a reference to SCIP, but the import is not a use: the linker's import
      // edges already say it. Indexers do not all mark it with the `import` role.
      if (importLinesOf.get(document.path)?.has(line)) continue;
      const from = innermost(symbols, line)?.id ?? document.path;
      if (from === to.id) continue;
      const kind = CALLABLE.has(to.kind)
        ? EDGE.calls
        : TYPE_LIKE.has(to.kind)
          ? EDGE.referencesType
          : EDGE.references;
      const key = `${from}\n${to.id}\n${kind}`;
      const edge = found.get(key) ?? { from, to: to.id, kind, lines: [] };
      if (!edge.lines.includes(line)) edge.lines.push(line);
      found.set(key, edge);
    }

    const kept: EdgeRecord[] = [];
    for (const from of [document.path, ...symbols.map((symbol) => symbol.id)]) {
      for (const edge of await allEdgesFrom(store, from)) {
        if (!REPLACED.has(edge.kind)) kept.push(edge);
        else if (LINKER_CALLS.has(edge.kind)) replaced += 1;
      }
    }
    for (const edge of found.values()) {
      if (edge.kind === EDGE.calls) counts.calls += 1;
      else if (edge.kind === EDGE.referencesType) counts.types += 1;
      else counts.values += 1;
    }
    await store.replaceEdges(document.path, [...kept, ...found.values()]);
  }

  return {
    documents: documents.length,
    skipped,
    definitions,
    mapped: new Set([...target.values()].map((symbol) => symbol.id)).size,
    edges: counts,
    replaced,
  };
}
