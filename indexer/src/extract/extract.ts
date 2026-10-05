import { createHash } from 'node:crypto';
import { type Deadline, InvariantViolationError } from '@cntxt-labs/anvesa-core';
import {
  ATTR,
  attachSfcComponent,
  extractFactsNative,
  extractFactsNativeMany,
  extractForIndexNativeMany,
  type NativeExtracted,
  type NativeExtractInput,
  type OutlineSymbol,
  outlineSymbols,
  SFC_COMPONENT_TAG,
  type StructuralEngine,
  serializeWExpr,
  WEXPR_FORMAT_VERSION,
  type WNode,
} from '@cntxt-labs/anvesa-structural';
import { extractVueScript, type SyntaxNode } from '@cntxt-labs/anvesa-syntax';
import { CallCollector } from './calls.ts';
import type { FileFacts, SymbolFact } from './facts.ts';
import { importCollectorFor } from './imports.ts';
import { bySpan, NestingCursor, type Span } from './scope.ts';
import { TypeCollector } from './types.ts';

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
 * Bump when what is extracted from the same outline changes (a new fact, a different rule), or
 * when the edges linked from the same facts do (4: every call edge keeps its own lines), so
 * indexes built before it are extracted and linked again instead of quietly lacking it.
 * 5: a single-file component is a symbol of its own.
 */
const FACTS_VERSION = 5;

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
    return this.#extractOne(path, source, options);
  }

  #extractOne(
    path: string,
    source: string,
    options: ExtractOptions,
  ): Promise<Extracted> | Extracted {
    return (
      this.#extractNatively(path, source, options) ?? this.#extractOnWasm(path, source, options)
    );
  }

  /**
   * `extractWithStructure` for many files, the ones the addon parses extracted together on every
   * core and away from the JavaScript thread. One outcome per file, in order: what that file would
   * have given alone, or what it would have thrown. Nothing is shared between files, so one that
   * fails does not affect the others.
   */
  async extractManyWithStructure(
    files: readonly { readonly path: string; readonly source: string }[],
    options: ExtractOptions = {},
  ): Promise<({ readonly extracted: Extracted } | { readonly failure: unknown })[]> {
    options.deadline?.throwIfExpired(`extract facts from ${files.length} files`);
    const outcomes: ({ extracted: Extracted } | { failure: unknown } | undefined)[] = files.map(
      () => undefined,
    );
    type NativeFile = { index: number; path: string; language: string; source: string };
    // A single-file component gains a symbol from its outline here, so it needs the outline as
    // objects; every other file only needs it as the text the index caches, printed natively.
    const printed: { file: NativeFile; input: NativeExtractInput }[] = [];
    let outlined: { file: NativeFile; input: NativeExtractInput }[] = [];
    for (const [index, file] of files.entries()) {
      const input = this.#nativeInput(file.path, file.source);
      if (!input) continue;
      const entry = {
        file: { index, path: file.path, language: input.language, source: file.source },
        input,
      };
      if (input.language === 'vue') outlined.push(entry);
      else printed.push(entry);
    }
    const fromText =
      printed.length > 0
        ? await extractForIndexNativeMany(
            printed.map((entry) => entry.input),
            [...CACHE_OMITS],
          )
        : [];
    if (fromText === undefined) outlined = [...printed, ...outlined];
    else {
      for (const [at, result] of fromText.entries()) {
        const file = printed[at]?.file;
        if (!file || result === undefined) continue;
        outcomes[file.index] =
          result instanceof Error
            ? { failure: result }
            : { extracted: { facts: result.facts as FileFacts, wexpr: result.wexpr } };
      }
    }
    const many =
      outlined.length > 0
        ? await extractFactsNativeMany(outlined.map((entry) => entry.input))
        : undefined;
    if (many) {
      for (const [at, result] of many.entries()) {
        const file = outlined[at]?.file;
        if (!file || result === undefined) continue;
        if (result instanceof Error) {
          outcomes[file.index] = { failure: result };
          continue;
        }
        try {
          outcomes[file.index] = {
            extracted: this.#finishNative(file.path, file.language, file.source, result),
          };
        } catch (failure) {
          outcomes[file.index] = { failure };
        }
      }
    }
    // Whatever was not extracted together goes the way it would alone.
    for (const [index, file] of files.entries()) {
      if (outcomes[index] !== undefined) continue;
      try {
        outcomes[index] = { extracted: await this.#extractOne(file.path, file.source, options) };
      } catch (failure) {
        outcomes[index] = { failure };
      }
    }
    return outcomes as ({ extracted: Extracted } | { failure: unknown })[];
  }

  /** What the addon needs to extract `path`, or `undefined` when it has no grammar or mapping. */
  #nativeInput(path: string, source: string) {
    const language = this.#engine.nativeLanguageOf({ path });
    if (language === undefined) return undefined;
    const mapping = this.#engine.mappings.mappingFor(language);
    if (!mapping) return undefined;
    const text = language === 'vue' ? extractVueScript(source) : source;
    return { path, language, source: text, mapping };
  }

  /** The native result as `Extracted`: a single-file component's own symbol, and the cached text. */
  #finishNative(
    path: string,
    language: string,
    source: string,
    extracted: NativeExtracted,
  ): Extracted {
    const withSfc = withSfcComponent(
      path,
      language,
      source,
      extracted.root,
      extracted.facts as FileFacts,
    );
    return {
      facts: withSfc.facts,
      wexpr: serializeWExpr(withSfc.root, { omit: CACHE_OMITS }),
    };
  }

  /**
   * The same facts from one native parse, for a language the addon has a grammar for; `undefined`
   * otherwise, and the file is read on web-tree-sitter instead.
   */
  #extractNatively(path: string, source: string, options: ExtractOptions): Extracted | undefined {
    const input = this.#nativeInput(path, source);
    if (!input) return undefined;
    options.deadline?.throwIfExpired(`extract facts from ${path}`);
    const extracted = extractFactsNative(path, input.language, input.source, input.mapping);
    if (!extracted) return undefined;
    return this.#finishNative(path, input.language, source, extracted);
  }

  async #extractOnWasm(path: string, source: string, options: ExtractOptions): Promise<Extracted> {
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
        const typeRules = this.#engine.mappings.mappingFor(encoded.language)?.typeRules;
        const types = typeRules
          ? new TypeCollector(typeRules, (position) => scope.at(position)?.id)
          : undefined;

        let visited = 0;
        for (const node of preorder(tree.root)) {
          visited += 1;
          if (visited % DEADLINE_CHECK_INTERVAL === 0) {
            deadline?.throwIfExpired(`extract facts from ${path}`);
          }
          calls.visit(node);
          imports?.visit(node);
          types?.visit(node);
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
          ...(types === undefined || types.types.length === 0 ? {} : { types: types.types }),
        };
        // Symbols are read before the component joins the outline, so its own symbol is added
        // here and nesting stays what the native side computed.
        const withSfc = withSfcComponent(path, encoded.language, source, encoded.root, facts);
        return {
          facts: withSfc.facts,
          wexpr: serializeWExpr(withSfc.root, { omit: CACHE_OMITS }),
        };
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

/**
 * A `.vue` file's component: on its outline, and among its symbols when none carries that name.
 * `<script setup>` declares nothing by name, so without it a component is findable only by what
 * it happens to declare inside itself.
 *
 * Both parse paths call this after their symbols are read and before the outline is written, so a
 * native parse and a web-tree-sitter one agree: the same node in the same place, the same symbol
 * first in the same list, with the same id.
 */
function withSfcComponent(
  path: string,
  language: string,
  source: string,
  root: WNode,
  facts: FileFacts,
): { readonly root: WNode; readonly facts: FileFacts } {
  const attached = attachSfcComponent(language, path, source, root);
  if (attached === undefined) return { root, facts };
  const symbol = outlineSymbols(attached).find((entry) => entry.node.tag === SFC_COMPONENT_TAG);
  if (symbol === undefined) return { root: attached, facts };
  const placed = placeSymbols(path, [symbol])[0];
  if (placed === undefined) return { root: attached, facts };
  const taken = new Set(facts.symbols.map((entry) => entry.id));
  let id = placed.id;
  for (let count = 2; taken.has(id); count += 1) id = `${path}#${symbol.name}~${count}`;
  const fact = symbolFacts(path, [placed.id === id ? placed : { ...placed, id }])[0];
  if (fact === undefined) return { root: attached, facts };
  return { root: attached, facts: { ...facts, symbols: [fact, ...facts.symbols] } };
}
