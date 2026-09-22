import { createHash } from 'node:crypto';
import { type Deadline, InvariantViolationError } from '@cntxt-labs/code-lens-core';
import {
  ATTR,
  type OutlineSymbol,
  outlineSymbols,
  type StructuralEngine,
  serializeWExpr,
  WEXPR_FORMAT_VERSION,
} from '@cntxt-labs/code-lens-structural';
import type { SyntaxNode } from '@cntxt-labs/code-lens-syntax';
import { CallCollector } from './calls.ts';
import type { FileFacts, SymbolFact } from './facts.ts';
import { importCollectorFor } from './imports.ts';
import { bySpan, NestingCursor, type Span } from './scope.ts';

/**
 * How many syntax nodes are visited between checks of the deadline. This sets how promptly a
 * cancelled extraction stops; it never limits how large a file may be.
 */
const DEADLINE_CHECK_INTERVAL = 4096;

export interface ExtractOptions {
  readonly deadline?: Deadline;
}

/** Facts, and the file's W-expression text from the same parse. */
export interface Extracted {
  readonly facts: FileFacts;
  /** The outline as W-expression text, without source offsets, ready to cache. */
  readonly wexpr: string;
}

/**
 * Bump when what is extracted from the same outline changes (a new fact, a different rule), so
 * indexes built before it are extracted again instead of quietly lacking it.
 */
const FACTS_VERSION = 2;

/** Offsets locate nodes in the source; a cached outline does not need them. */
const CACHE_OMITS: ReadonlySet<string> = new Set([ATTR.startIndex, ATTR.endIndex]);

/** A symbol with the span it covers in the source. */
interface PlacedSymbol extends Span {
  readonly symbol: OutlineSymbol;
  readonly id: string;
}

/**
 * Turns a source file into `FileFacts` with a single parse: the symbol outline and the walk that
 * finds calls and imports read the same syntax tree.
 *
 * A file that does not fully parse still yields what its parseable parts contain, flagged with
 * `hasSyntaxErrors`, because a half-edited file is the normal state of a working tree.
 */
export class FactExtractor {
  readonly #engine: StructuralEngine;
  #signature: string | undefined;

  constructor(engine: StructuralEngine) {
    this.#engine = engine;
  }

  /**
   * What the facts of a file depend on besides the file: how facts are read from an outline, the
   * outline format, and every mapping in use (a project's or a user's included). When it changes,
   * facts stored under the old one are out of date even though no file changed.
   */
  get signature(): string {
    if (this.#signature === undefined) {
      const hash = createHash('sha256');
      hash.update(`facts=${FACTS_VERSION};wexpr=${WEXPR_FORMAT_VERSION}`);
      for (const language of [...this.#engine.mappings.languages()].sort()) {
        hash.update(`\n${language}=${JSON.stringify(this.#engine.mappings.mappingFor(language))}`);
      }
      this.#signature = hash.digest('hex');
    }
    return this.#signature;
  }

  async extract(path: string, source: string, options: ExtractOptions = {}): Promise<FileFacts> {
    return (await this.extractWithStructure(path, source, options)).facts;
  }

  /** As `extract`, and the outline text too, from the same single parse. */
  async extractWithStructure(
    path: string,
    source: string,
    options: ExtractOptions = {},
  ): Promise<Extracted> {
    const deadline = options.deadline;
    return this.#engine.withEncoded(
      source,
      { path },
      { docs: true, positions: true, ...(deadline ? { deadline } : {}) },
      (tree, encoded) => {
        const placed = placeSymbols(path, outlineSymbols(encoded.root));

        const scope = new NestingCursor(placed);
        const calls = new CallCollector((position) => scope.at(position)?.id);
        const imports = importCollectorFor(encoded.language);

        let visited = 0;
        for (const node of preorder(tree.root)) {
          visited += 1;
          if (visited % DEADLINE_CHECK_INTERVAL === 0) {
            deadline?.throwIfExpired(`extract facts from ${path}`);
          }
          calls.visit(node);
          imports?.visit(node);
        }

        const exports = imports?.exports ?? [];
        // A declaration listed in `export { f }` is exported, wherever the list is.
        const listed = new Set(exports.map((entry) => entry.local));
        const symbols = symbolFacts(path, placed).map((symbol) =>
          symbol.parentId === undefined && symbol.exported === false && listed.has(symbol.baseName)
            ? { ...symbol, exported: true }
            : symbol,
        );

        const facts: FileFacts = {
          path,
          language: encoded.language,
          symbols,
          calls: calls.calls,
          imports: imports?.imports ?? [],
          exports,
          hasSyntaxErrors: encoded.hasSyntaxErrors,
          importsSupported: imports !== undefined,
          gaps: {
            unnamedCalls: calls.gaps.unnamedCalls,
            computedImports: imports?.gaps.computedImports ?? 0,
          },
        };
        return { facts, wexpr: serializeWExpr(encoded.root, { omit: CACHE_OMITS }) };
      },
    );
  }
}

/** Every named node, parents before children and siblings in source order. Iterative: no depth limit. */
function* preorder(root: SyntaxNode): Generator<SyntaxNode> {
  const pending: SyntaxNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as SyntaxNode;
    yield node;
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index] as SyntaxNode);
    }
  }
}

/** Give each outline symbol its source span and a workspace-unique id, in document order. */
function placeSymbols(path: string, symbols: readonly OutlineSymbol[]): PlacedSymbol[] {
  const seen = new Map<string, number>();
  const placed = symbols.map((symbol): PlacedSymbol => {
    const start = Number.parseInt(symbol.node.attrs.get(ATTR.startIndex) ?? '', 10);
    const end = Number.parseInt(symbol.node.attrs.get(ATTR.endIndex) ?? '', 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new InvariantViolationError('Outline symbol has no source position', {
        context: { path, symbol: symbol.name },
      });
    }
    const count = (seen.get(symbol.name) ?? 0) + 1;
    seen.set(symbol.name, count);
    const base = `${path}#${symbol.name}`;
    return { symbol, start, end, id: count === 1 ? base : `${base}~${count}` };
  });
  return placed.sort(bySpan);
}

function symbolFacts(path: string, placed: readonly PlacedSymbol[]): SymbolFact[] {
  const facts: SymbolFact[] = [];
  const open: PlacedSymbol[] = [];
  for (const current of placed) {
    while (open.length > 0 && (open.at(-1) as PlacedSymbol).end <= current.start) open.pop();
    const { symbol } = current;
    facts.push({
      id: current.id,
      path,
      name: symbol.name,
      baseName: symbol.baseName,
      kind: symbol.kind,
      parentId: open.at(-1)?.id,
      exported: symbol.exported,
      startLine: lineAttr(symbol, ATTR.line),
      endLine: lineAttr(symbol, ATTR.endLine),
      signature: symbol.signature,
      ...(symbol.params === undefined ? {} : { params: symbol.params }),
      doc: symbol.doc,
      ...(symbol.aliasOf === undefined ? {} : { aliasOf: symbol.aliasOf }),
    });
    open.push(current);
  }
  return facts;
}

function lineAttr(symbol: OutlineSymbol, key: string): number {
  const value = Number.parseInt(symbol.node.attrs.get(key) ?? '', 10);
  return Number.isFinite(value) ? value : 0;
}
