import { ATTR, type WNode, walk } from './node.ts';

/** Tags that name something worth finding by itself. Variables join only in the cases below. */
const SYMBOL_TAGS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'class',
  'struct',
  'interface',
  'type',
  'enum',
  'trait',
  'module',
  'namespace',
  'constant',
]);

/**
 * Grammar node kinds that declare something, as opposed to describing a type or an expression.
 * The `type` tag covers both a type alias and every type expression (`Maybe<T>`, `A | B`, an
 * annotation), and only the declaration is a symbol.
 */
const DECLARATION_KIND = /_(declaration|definition|item|statement|spec|alias)$/;

/** Tags that are not declarations even when the grammar node that made them has a name. */
const NEVER_DECLARING: ReadonlySet<string> = new Set(['import', 'export', 'call']);

/**
 * Whether a node declares what it names, from what the encoder knows when it makes the node: its
 * tag, the grammar's own kind for it, and whether it has a name. Mentions (a type annotation, an
 * imported name) name things without declaring them.
 */
export function declares(tag: string, kind: string, named: boolean): boolean {
  if (!named || NEVER_DECLARING.has(tag)) return false;
  if (tag === 'type') return DECLARATION_KIND.test(kind);
  return SYMBOL_TAGS.has(tag) || tag === 'variable';
}

/** A named declaration in an outline, with what a reader needs to place and describe it. */
export interface OutlineSymbol {
  readonly node: WNode;
  /** `function`, `method`, `class`, ... A variable holding a function is a `function`. */
  readonly kind: string;
  /** Qualified name: `Outer.Inner.method`. */
  readonly name: string;
  /** The last segment of `name`. */
  readonly baseName: string;
  /** Everything before the last segment, or `''`. */
  readonly parentName: string;
  readonly doc: string | undefined;
  readonly signature: string | undefined;
  /** The parameter names of a callable, as written: `a, ...rest`, `{a, b}, c`. */
  readonly params: string | undefined;
  /**
   * Whether the declaration is exported, for languages that mark it (a wrapping `export`).
   * `undefined` where the language has no such marker, so callers do not have to guess.
   */
  readonly exported: boolean | undefined;
  /** For a variable that is only another name: that name. */
  readonly aliasOf?: string;
}

/**
 * The symbols of an outline, in document order.
 *
 * A declaration is a symbol when its tag is one of the named kinds. A variable is a symbol when
 * it holds a function (`const f = () => ...`, which is a function to anyone searching for it) or
 * carries documentation. Plain undocumented variables are left out: they would drown the ones that
 * matter.
 */
export function outlineSymbols(root: WNode): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (const { node, parent } of walk(root)) {
    const name = node.attrs.get(ATTR.name);
    if (name === undefined) continue;
    const doc = node.attrs.get(ATTR.doc);
    const baseName = node.attrs.get(ATTR.baseName) ?? name;
    const shared = {
      node,
      name,
      baseName,
      parentName: name.endsWith(baseName)
        ? name.slice(0, name.length - baseName.length).replace(/\.$/, '')
        : '',
      exported: parent === undefined ? undefined : exportedState(root, parent),
    };

    const kind = node.attrs.get(ATTR.kind) ?? '';
    if (node.tag === 'type' && !DECLARATION_KIND.test(kind)) continue;

    if (SYMBOL_TAGS.has(node.tag)) {
      symbols.push({
        ...shared,
        kind: node.tag,
        doc,
        signature: node.attrs.get(ATTR.signature),
        params: node.attrs.get(ATTR.params),
      });
    } else if (node.tag === 'variable') {
      const callable = node.children.find((child) => child.attrs.get(ATTR.assignedTo) === name);
      if (callable) {
        symbols.push({
          ...shared,
          kind: 'function',
          doc: doc ?? callable.attrs.get(ATTR.doc),
          signature: callable.attrs.get(ATTR.signature),
          params: callable.attrs.get(ATTR.params),
        });
      } else if (doc !== undefined || node.attrs.has(ATTR.aliasOf)) {
        const aliasOf = node.attrs.get(ATTR.aliasOf);
        symbols.push({
          ...shared,
          kind: 'variable',
          doc,
          signature: undefined,
          params: undefined,
          ...(aliasOf === undefined ? {} : { aliasOf }),
        });
      }
    }
  }
  return symbols;
}

/** A declaration directly under an `export` node is exported; the root marks a language that has none. */
function exportedState(root: WNode, parent: WNode): boolean | undefined {
  if (parent.tag === 'export') return true;
  return hasExports(root) ? false : undefined;
}

const exportCache = new WeakMap<WNode, boolean>();

/** Does this outline contain any `export` node? Then absence of one means "not exported". */
function hasExports(root: WNode): boolean {
  const cached = exportCache.get(root);
  if (cached !== undefined) return cached;
  let found = false;
  for (const { node } of walk(root)) {
    if (node.tag === 'export') {
      found = true;
      break;
    }
  }
  exportCache.set(root, found);
  return found;
}
