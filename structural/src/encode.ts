import { createHash } from 'node:crypto';
import type { LimitReport } from '@cntxt-labs/code-lens-core';
import type { SyntaxNode } from '@cntxt-labs/code-lens-syntax';
import type { CompiledMapping } from './mapping.ts';
import { ATTR, shortDigest, type WNode } from './node.ts';
import { declares } from './symbols.ts';

export interface EncodeOptions {
  readonly mapping: CompiledMapping;
  /** Recorded as the root's `path` attribute. */
  readonly path?: string;
  /**
   * Record each symbol's doc comment as a `doc` attribute. Off by default because doc text can be
   * large; turn it on when the outline feeds something that reads documentation.
   */
  readonly docs?: boolean;
  /**
   * Record where each node sits in the source as `startIndex` and `endIndex` (offsets into the
   * text, end exclusive). Lets a caller match outline nodes to syntax nodes exactly, which line
   * numbers alone cannot do when several nodes share a line. Off by default.
   */
  readonly positions?: boolean;
  /**
   * Stop descending below this structural depth. Off by default: a tree keeps only structural
   * nodes, so its depth is the depth of the code's own nesting. When set, nodes cut off are
   * counted in `EncodeStats.depthLimit`, never dropped silently.
   */
  readonly maxDepth?: number;
}

export interface EncodeStats {
  /** Structural nodes in the result. */
  readonly nodes: number;
  /** Deepest structural nesting reached (the root is depth 0). */
  readonly deepest: number;
  /** Present only when the caller set `maxDepth`. `reached` says whether it cut anything off. */
  readonly depthLimit?: LimitReport;
  /** How many structural nodes were left out because of `maxDepth`. */
  readonly omitted: number;
}

export interface EncodeResult {
  readonly root: WNode;
  readonly stats: EncodeStats;
}

/** Optional attributes an encode adds to every node. */
interface Attach {
  readonly docs: boolean;
  readonly positions: boolean;
}

/** A W-expression node under construction. Structurally a `WNode`, so it needs no finishing pass. */
interface Building extends WNode {
  readonly attrs: Map<string, string>;
  readonly children: WNode[];
}

interface Task {
  readonly syntax: SyntaxNode;
  readonly into: Building;
  readonly depth: number;
  /** Qualified name of the nearest named structural ancestor. */
  readonly qualifier: string | undefined;
  readonly parentTag: string;
}

/**
 * Turn a syntax tree into a W-expression tree.
 *
 * One walker serves every language; a `CompiledMapping` supplies what differs. Only named syntax
 * nodes are visited (keywords and punctuation carry no structure), structural ones become nodes,
 * and everything between them is transparent, so a method inside a wrapper is still a child of
 * its class. The walk is iterative and never recurses, so nesting depth cannot overflow the stack.
 */
export function encodeTree(root: SyntaxNode, options: EncodeOptions): EncodeResult {
  const { mapping, maxDepth } = options;
  const rootTag = mapping.tagOf(root.type);
  const shapes = callableShapes(root, mapping);
  const attach: Attach = { docs: options.docs === true, positions: options.positions === true };
  const top = startNode(root, rootTag, mapping, shapes, undefined, rootTag, options.path, attach);

  let nodes = 1;
  let deepest = 0;
  let omitted = 0;

  const pending: Task[] = [];
  const pushChildren = (syntax: SyntaxNode, task: Omit<Task, 'syntax'>): void => {
    const children = syntax.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child?.isNamed) pending.push({ ...task, syntax: child });
    }
  };
  pushChildren(root, { into: top, depth: 0, qualifier: nameOf(top), parentTag: rootTag });

  while (pending.length > 0) {
    const task = pending.pop() as Task;
    const tag = mapping.tagOf(task.syntax.type);
    if (!mapping.isStructural(tag)) {
      pushChildren(task.syntax, task);
      continue;
    }
    const depth = task.depth + 1;
    if (maxDepth !== undefined && depth > maxDepth) {
      omitted += 1;
      continue;
    }
    const node = startNode(
      task.syntax,
      tag,
      mapping,
      shapes,
      task.qualifier,
      task.parentTag,
      undefined,
      attach,
    );
    task.into.children.push(node);
    nodes += 1;
    if (depth > deepest) deepest = depth;
    pushChildren(task.syntax, {
      into: node,
      depth,
      qualifier: nameOf(node) ?? task.qualifier,
      parentTag: tag,
    });
  }

  const stats: EncodeStats = {
    nodes,
    deepest,
    omitted,
    ...(maxDepth === undefined
      ? {}
      : {
          depthLimit: {
            name: 'maxDepth',
            applied: maxDepth,
            source: 'caller' as const,
            reached: omitted > 0,
          },
        }),
  };
  return { root: top, stats };
}

function nameOf(node: WNode): string | undefined {
  return node.attrs.get(ATTR.name);
}

function startNode(
  syntax: SyntaxNode,
  tag: string,
  mapping: CompiledMapping,
  shapes: ReadonlyMap<number, CallableShape>,
  qualifier: string | undefined,
  parentTag: string,
  path: string | undefined,
  attach: Attach,
): Building {
  const attrs = new Map<string, string>();
  const base = nameText(syntax, mapping);
  if (base !== undefined) {
    attrs.set(ATTR.name, qualifier ? `${qualifier}.${base}` : base);
    attrs.set(ATTR.baseName, base);
  }
  attrs.set(ATTR.kind, syntax.type);
  if (tag === 'variable' && base !== undefined) {
    const alias = aliasTarget(syntax);
    if (alias !== undefined) attrs.set(ATTR.aliasOf, alias);
  }
  if (declares(tag, syntax.type, base !== undefined)) attrs.set(ATTR.declaration, 'true');
  attrs.set(ATTR.line, String(syntax.startPosition.row + 1));
  attrs.set(ATTR.endLine, String(syntax.endPosition.row + 1));
  if (path !== undefined) attrs.set('path', path);
  if (attach.docs) {
    const doc = docOf(syntax);
    if (doc !== undefined) attrs.set(ATTR.doc, doc);
  }
  if (attach.positions) {
    attrs.set(ATTR.startIndex, String(syntax.startIndex));
    attrs.set(ATTR.endIndex, String(syntax.endIndex));
  }

  if (mapping.isCallable(tag)) {
    describeCallable(syntax, attrs, base, qualifier, parentTag, shapes.get(syntax.id));
  }
  return { tag, attrs, children: [] };
}

// --- docs ---------------------------------------------------------------------------------------

/** Wrappers that start where their declaration starts, or precede it: the comment sits before them. */
const DOC_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'decorated_definition',
  'export_statement',
]);

/**
 * The documentation attached to a declaration: the run of comments directly above it (above its
 * `export` or decorator wrapper, when it has one), or a leading string literal in its body, which
 * is how Python writes docstrings.
 */
function docOf(syntax: SyntaxNode): string | undefined {
  let anchor = syntax;
  while (
    anchor.parent &&
    (anchor.parent.startIndex === anchor.startIndex || DOC_WRAPPER_TYPES.has(anchor.parent.type)) &&
    anchor.parent.parent
  ) {
    anchor = anchor.parent;
  }

  const comments: string[] = [];
  let expectedRow = anchor.startPosition.row;
  for (
    let prev = anchor.previousSibling;
    prev && isComment(prev.type);
    prev = prev.previousSibling
  ) {
    if (prev.endPosition.row < expectedRow - 1) break;
    comments.unshift(prev.text);
    expectedRow = prev.startPosition.row;
  }
  if (comments.length > 0) return comments.join('\n');

  const first = syntax.childForFieldName('body')?.namedChildren[0];
  const literal = first?.type === 'expression_statement' ? first.namedChildren[0] : first;
  if (literal?.type === 'string' || literal?.type === 'string_literal') return literal.text;
  return undefined;
}

// --- names --------------------------------------------------------------------------------------

/** Types a name is usually held in when the mapping names none. */
const NAME_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'type_identifier',
  'property_identifier',
  'name',
]);

/** A declaration that wraps the real name one level down: `const x = ...`, a class field. */
const DECLARATOR_TYPES: ReadonlySet<string> = new Set([
  'variable_declarator',
  'public_field_definition',
  'field_definition',
]);

function nameText(syntax: SyntaxNode, mapping: CompiledMapping): string | undefined {
  const explicit = mapping.nameChildType(syntax.type);
  const direct = nameChild(syntax, explicit);
  if (direct) return direct.text;
  for (const child of syntax.children) {
    if (DECLARATOR_TYPES.has(child.type)) {
      const wrapped = nameChild(child, explicit);
      if (wrapped) return wrapped.text;
    }
  }
  return undefined;
}

/** Grammar fields whose child is something other than the node's name. */
const NON_NAME_FIELDS: readonly string[] = [
  'body',
  'parameter',
  'parameters',
  'return_type',
  'value',
];

function nameChild(syntax: SyntaxNode, explicit: string | undefined): SyntaxNode | undefined {
  const field = syntax.childForFieldName('name');
  if (field) return field;
  // Children that fill a role other than naming (an arrow function's body or lone parameter can
  // be a bare identifier: `y => y`) are never the name.
  const other = new Set<number>();
  for (const role of NON_NAME_FIELDS) {
    const child = syntax.childForFieldName(role);
    if (child) other.add(child.id);
  }
  return syntax.children.find(
    (child) =>
      !other.has(child.id) &&
      (explicit === undefined ? NAME_TYPES.has(child.type) : child.type === explicit),
  );
}

// --- callables ----------------------------------------------------------------------------------

const PARAMETER_LIST_TYPES: ReadonlySet<string> = new Set([
  'formal_parameters',
  'parameters',
  'parameter_list',
]);

/** Wrappers that change nothing about what is assigned: `(f)`, `f as T`, `f!`. */
const VALUE_WRAPPERS: ReadonlySet<string> = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
  'type_assertion',
]);

/**
 * Declarations that give the outline node above them a value: `const f = ...`, a class field. An
 * object key (`{ on: () => 1 }`) also binds a value, but names the property, not the variable.
 */
const VALUE_HOSTS: ReadonlySet<string> = new Set([
  'variable_declarator',
  'public_field_definition',
  'field_definition',
  'property_definition',
]);

/** Whether this node is itself the value being bound, not something nested deeper inside it. */
function isAssignedValue(syntax: SyntaxNode): boolean {
  let parent = syntax.parent;
  while (parent && VALUE_WRAPPERS.has(parent.type)) parent = parent.parent;
  return parent !== null && VALUE_HOSTS.has(parent.type);
}

const CLASS_LIKE_PARENT_TAGS: ReadonlySet<string> = new Set([
  'class',
  'struct',
  'interface',
  'trait',
  'impl',
]);

function describeCallable(
  syntax: SyntaxNode,
  attrs: Map<string, string>,
  baseName: string | undefined,
  qualifier: string | undefined,
  parentTag: string,
  shape: CallableShape | undefined,
): void {
  attrs.set(ATTR.callable, 'true');
  if (
    CLASS_LIKE_PARENT_TAGS.has(parentTag) ||
    syntax.type === 'method_declaration' ||
    syntax.type === 'method_definition'
  ) {
    attrs.set(ATTR.isMethod, 'true');
  }
  const params = parametersOf(syntax);
  const returns = returnTypeOf(syntax);
  if (params) attrs.set(ATTR.params, params);
  if (returns) attrs.set(ATTR.returns, returns);

  // An anonymous callable takes its identity from what it is assigned to:
  // `const f = () => ...` is `f`, not "" and not a dangling "parent.". Only when it *is* the
  // assigned value: a callback inside `const r = make({ on: () => 1 })` is not `r`.
  const label =
    baseName ??
    ((parentTag === 'variable' || parentTag === 'property') && isAssignedValue(syntax)
      ? qualifier
      : undefined);
  if (baseName === undefined && label !== undefined) attrs.set(ATTR.assignedTo, label);
  const qualified =
    baseName === undefined ? (label ?? '') : qualifier ? `${qualifier}.${baseName}` : baseName;

  const signature = `${qualified}(${params ?? ''})${returns ? `:${returns}` : ''}`;
  attrs.set(ATTR.signature, signature);
  attrs.set(ATTR.hash, shortHash(`${label ?? ''}(${params ?? ''})${returns ? `:${returns}` : ''}`));

  const body = classifyBody(syntax);
  if (body) {
    attrs.set(ATTR.bodyKind, body.bodyKind);
    attrs.set(ATTR.bodyStmts, String(body.bodyStmts));
  }
  if (shape) {
    attrs.set(ATTR.shape, shape.hash);
    attrs.set(ATTR.shapeNodes, String(shape.nodes));
    if (shape.body !== undefined) attrs.set(ATTR.bodyShape, shape.body);
  }
}

function shortHash(text: string): string {
  return shortDigest(createHash('sha256').update(text).digest('hex'));
}

function parametersOf(syntax: SyntaxNode): string | undefined {
  const list =
    syntax.childForFieldName('parameters') ??
    syntax.children.find((child) => PARAMETER_LIST_TYPES.has(child.type));
  if (!list) {
    // `x => x + 1`: a single bare parameter has no list.
    const single = syntax.childForFieldName('parameter');
    return single ? paramLabel(single) : undefined;
  }
  const labels: string[] = [];
  for (const param of list.children) {
    if (!param.isNamed || isComment(param.type)) continue;
    const label = paramLabel(param);
    if (label) labels.push(label);
  }
  return labels.length > 0 ? labels.join(', ') : undefined;
}

const SPLAT_PREFIX: Readonly<Record<string, string>> = {
  rest_pattern: '...',
  rest_parameter: '...',
  list_splat_pattern: '...',
  dictionary_splat_pattern: '**',
};

function paramLabel(param: SyntaxNode): string | undefined {
  if (param.type === 'identifier' || param.type === 'shorthand_property_identifier_pattern') {
    return param.text;
  }
  const splat = SPLAT_PREFIX[param.type];
  if (splat !== undefined) {
    const inner = param.namedChildren[0];
    return `${splat}${inner ? (paramLabel(inner) ?? inner.text) : ''}`;
  }
  if (param.type === 'object_pattern' || param.type === 'array_pattern') {
    return `{${patternNames(param).join(', ')}}`;
  }
  const named = param.childForFieldName('name') ?? param.childForFieldName('pattern');
  if (named) return paramLabel(named) ?? named.text;
  const firstName = param.namedChildren.find((child) => child.type.endsWith('identifier'));
  if (firstName) return firstName.text;
  const head = param.text.split(/[:=]/, 1)[0]?.trim();
  return head || undefined;
}

/** The names bound by a destructuring pattern, at its own level. */
function patternNames(pattern: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of pattern.namedChildren) {
    if (child.type === 'pair_pattern') {
      const value = child.childForFieldName('value');
      if (value?.type === 'identifier') names.push(value.text);
    } else if (
      child.type === 'identifier' ||
      child.type === 'shorthand_property_identifier_pattern'
    ) {
      names.push(child.text);
    }
  }
  return names;
}

function returnTypeOf(syntax: SyntaxNode): string | undefined {
  const node =
    syntax.childForFieldName('return_type') ??
    syntax.children.find((child) => child.type === 'type_annotation');
  if (!node) return undefined;
  const text = node.text
    .replace(/^\s*(?::|->)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

// --- body classification ------------------------------------------------------------------------

export type BodyKind = 'empty' | 'comment-only' | 'throw-only' | 'return-literal' | 'real';

export interface BodyShape {
  readonly bodyKind: BodyKind;
  readonly bodyStmts: number;
}

const BLOCK_BODY = /block|compound_statement|declaration_list|^body$/;
const LITERAL_TYPES: ReadonlySet<string> = new Set([
  'string',
  'string_literal',
  'template_string',
  'number',
  'number_literal',
  'integer',
  'float',
  'true',
  'false',
  'null',
  'nil',
  'none',
  'undefined',
  'boolean',
  'regex',
]);
const NO_OP_STATEMENTS: ReadonlySet<string> = new Set([
  'pass_statement',
  'ellipsis',
  'empty_statement',
]);
const THROW_STATEMENTS: ReadonlySet<string> = new Set(['throw_statement', 'raise_statement']);

function isComment(type: string): boolean {
  return type.includes('comment');
}

/**
 * How much a callable's body actually does: nothing, only comments, only a throw, only a literal
 * return, or real work. Lets a caller ignore stubs when looking for clones or dead code.
 */
export function classifyBody(callable: SyntaxNode): BodyShape | undefined {
  const body = callable.childForFieldName('body');
  if (!body) return undefined;
  if (!BLOCK_BODY.test(body.type)) {
    return { bodyStmts: 1, bodyKind: isLiteral(body) ? 'return-literal' : 'real' };
  }

  const statements = body.namedChildren.filter((child) => !isComment(child.type));
  const hasComments = body.namedChildren.some((child) => isComment(child.type));

  if (statements.length === 1) {
    const only = statements[0] as SyntaxNode;
    const inner = only.type === 'expression_statement' ? (only.namedChildren[0] ?? only) : only;
    if (inner.type === 'string' || inner.type === 'string_literal') {
      return { bodyStmts: 0, bodyKind: 'comment-only' };
    }
  }

  const effective = statements.filter((child) => !NO_OP_STATEMENTS.has(child.type));
  if (effective.length === 0) {
    return { bodyStmts: 0, bodyKind: hasComments ? 'comment-only' : 'empty' };
  }
  if (effective.length === 1) {
    const only = effective[0] as SyntaxNode;
    if (THROW_STATEMENTS.has(only.type)) return { bodyStmts: 1, bodyKind: 'throw-only' };
    if (only.type === 'return_statement') {
      const value = only.namedChildren.find((child) => !isComment(child.type));
      if (!value || isLiteral(value)) return { bodyStmts: 1, bodyKind: 'return-literal' };
    }
  }
  return { bodyStmts: effective.length, bodyKind: 'real' };
}

function isLiteral(node: SyntaxNode): boolean {
  if (LITERAL_TYPES.has(node.type)) return true;
  return (node.type === 'array' || node.type === 'object') && node.namedChildCount === 0;
}

// --- structural shape ---------------------------------------------------------------------------

export interface Shape {
  readonly hash: string;
  /** Named syntax nodes in the normalised subtree. */
  readonly nodes: number;
}

/** What is recorded about a callable: its whole shape and, when it has one, its body's shape. */
interface CallableShape extends Shape {
  readonly body: string | undefined;
}

/** Identifier-like and literal node types, whose text is replaced so renamed clones still match. */
const PLACEHOLDER_ID = /identifier$/;
const PLACEHOLDER_LITERAL: ReadonlySet<string> = new Set([
  ...LITERAL_TYPES,
  'string_fragment',
  'string_content',
  'escape_sequence',
]);

/** Hex characters of an internal (node-to-node) digest. Wide enough that collisions are not a concern. */
const NODE_DIGEST_HEX_LENGTH = 32;

function nodeDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, NODE_DIGEST_HEX_LENGTH);
}

interface ShapeFrame {
  readonly node: SyntaxNode;
  readonly children: readonly SyntaxNode[];
  next: number;
  /** One token per child that counts: a digest, a placeholder, or a leaf's type. */
  readonly tokens: string[];
  readonly childIds: number[];
  named: number;
}

/**
 * A hash of a subtree's structure with names and literal values removed. Two functions with the
 * same shape do the same thing with different names or constants (a "type-2 clone"). Operators
 * and keywords stay in, so `a + b` and `a - b` differ, and a node's digest is built from its
 * children's, so grouping matters: `f(a(b), c)` and `f(a(b, c))` differ.
 */
export function shapeOf(root: SyntaxNode): Shape {
  return hashSubtree(root).root;
}

/**
 * Hash a subtree bottom-up in one pass, so each node is visited once. `onCallable` is told the
 * shape of every node whose type `isCallable` accepts, and of its body, without walking anything
 * again; a nest of callables costs the same per node as flat code.
 */
function hashSubtree(
  root: SyntaxNode,
  isCallable?: (type: string) => boolean,
  onCallable?: (node: SyntaxNode, shape: CallableShape) => void,
): { root: Shape } {
  const open = (node: SyntaxNode): ShapeFrame => ({
    node,
    children: node.children,
    next: 0,
    tokens: [],
    childIds: [],
    named: 0,
  });

  const stack: ShapeFrame[] = [open(root)];
  let result: Shape = { hash: '', nodes: 0 };
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as ShapeFrame;
    const child = frame.children[frame.next];
    if (child) {
      frame.next += 1;
      if (isComment(child.type)) continue;
      const leaf = leafToken(child);
      if (leaf !== undefined) {
        frame.tokens.push(leaf);
        frame.childIds.push(child.id);
        if (child.isNamed) frame.named += 1;
      } else {
        stack.push(open(child));
      }
      continue;
    }

    stack.pop();
    const digest = nodeDigest(`${frame.node.type}[${frame.tokens.join(',')}]`);
    const nodes = frame.named + (frame.node.isNamed ? 1 : 0);
    if (isCallable?.(frame.node.type)) {
      const bodyId = frame.node.childForFieldName('body')?.id;
      const at = bodyId === undefined ? -1 : frame.childIds.indexOf(bodyId);
      onCallable?.(frame.node, {
        hash: shortDigest(digest),
        nodes,
        body: at === -1 ? undefined : shortDigest(frame.tokens[at] as string),
      });
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.tokens.push(digest);
      parent.childIds.push(frame.node.id);
      parent.named += nodes;
    } else {
      result = { hash: shortDigest(digest), nodes };
    }
  }
  return { root: result };
}

/** The token a childless or placeholder node contributes, or undefined when it has structure. */
function leafToken(node: SyntaxNode): string | undefined {
  if (PLACEHOLDER_ID.test(node.type)) return 'ID';
  if (PLACEHOLDER_LITERAL.has(node.type)) return `${node.type}:LIT`;
  return node.childCount === 0 ? node.type : undefined;
}

/** Shapes of every callable in a tree, keyed by syntax node id, computed in one pass. */
function callableShapes(root: SyntaxNode, mapping: CompiledMapping): Map<number, CallableShape> {
  const shapes = new Map<number, CallableShape>();
  hashSubtree(
    root,
    (type) => mapping.isCallable(mapping.tagOf(type)),
    (node, shape) => shapes.set(node.id, shape),
  );
  return shapes;
}

/**
 * The name a declaration's value is, when the value is nothing but a name: `const a = b` and
 * `const a: typeof b = b`, not `const a = b()` or `const a = obj.b`.
 */
function aliasTarget(declaration: SyntaxNode): string | undefined {
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const value = declarator.childForFieldName('value');
    if (value?.type === 'identifier') return value.text;
  }
  return undefined;
}
