/**
 * The W-expression node model.
 *
 * A W-expression is a compact outline of a syntax tree: only the structural nodes (classes,
 * functions, imports, ...) survive, each carrying string attributes. Because every attribute is a
 * string, the same model serves storage, querying and diffing.
 */

/** Attribute names the encoder writes. Line numbers are 1-based. */
export const ATTR = {
  name: 'name',
  baseName: 'baseName',
  kind: 'kind',
  line: 'line',
  endLine: 'endLine',
  params: 'params',
  returns: 'returns',
  signature: 'signature',
  /** Hash of `name(params):returns`. Equal signatures, whatever the body. */
  hash: 'hash',
  /** Hash of the normalised callable (parameters and body). Equal shapes are clones. */
  shape: 'shape',
  /** Hash of the normalised body alone, so a diff can tell a body change from a signature change. */
  bodyShape: 'bodyShape',
  /** Number of syntax nodes in the normalised body, so callers can judge how trivial a clone is. */
  shapeNodes: 'shapeNodes',
  bodyKind: 'bodyKind',
  bodyStmts: 'bodyStmts',
  /** For a nameless callable assigned to a variable or field: the name it is assigned to. */
  assignedTo: 'assignedTo',
  /** The doc comment (or docstring) attached to a symbol. Written only when `EncodeOptions.docs` is on. */
  doc: 'doc',
  /** Offsets of the node in the source text. Written only when `EncodeOptions.positions` is on. */
  startIndex: 'startIndex',
  endIndex: 'endIndex',
} as const;

/**
 * Hex characters kept from a SHA-256 digest when it is stored as an attribute: 64 bits. This is a
 * fixed format width, not a cap on data. Across the functions of a workspace (millions at most) a
 * 64-bit hash makes an accidental collision vanishingly unlikely, and the short form keeps stored
 * outlines compact.
 */
export const DIGEST_HEX_LENGTH = 16;

/** Shorten a full hex digest to the width stored in attributes. */
export function shortDigest(fullHex: string): string {
  return fullHex.slice(0, DIGEST_HEX_LENGTH);
}

export interface WNode {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly WNode[];
}

export function makeNode(
  tag: string,
  attrs: Iterable<readonly [string, string]> | Readonly<Record<string, string>> = [],
  children: readonly WNode[] = [],
): WNode {
  const entries = Symbol.iterator in attrs ? attrs : Object.entries(attrs);
  return { tag, attrs: new Map(entries as Iterable<readonly [string, string]>), children };
}

export function attrOf(node: WNode, key: string): string | undefined {
  return node.attrs.get(key);
}

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** The 1-based line span of a node, when it has one. */
export function lineRange(node: WNode): LineRange | undefined {
  const start = Number.parseInt(node.attrs.get(ATTR.line) ?? '', 10);
  if (!Number.isFinite(start)) return undefined;
  const end = Number.parseInt(node.attrs.get(ATTR.endLine) ?? '', 10);
  return { startLine: start, endLine: Number.isFinite(end) ? end : start };
}

export interface WalkEntry {
  readonly node: WNode;
  readonly parent: WNode | undefined;
  readonly depth: number;
}

/**
 * Every node in document order (parents before children, siblings left to right). Iterative, so a
 * tree of any depth is walked without growing the call stack.
 */
export function* walk(root: WNode): Generator<WalkEntry> {
  const pending: WalkEntry[] = [{ node: root, parent: undefined, depth: 0 }];
  while (pending.length > 0) {
    const entry = pending.pop() as WalkEntry;
    yield entry;
    const { children } = entry.node;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: children[index] as WNode, parent: entry.node, depth: entry.depth + 1 });
    }
  }
}

export function countNodes(root: WNode): number {
  let total = 0;
  for (const _ of walk(root)) total += 1;
  return total;
}
