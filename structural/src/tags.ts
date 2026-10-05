/**
 * Read a grammar's `queries/tags.scm`: the patterns its authors wrote to say what defines a
 * function, a class or a module and what is a call. Patterns are read as data, not run: each
 * `@definition.<kind>` or `@reference.call` capture names a node type, and an `@name` capture on
 * one of its direct children names where its name is.
 */

/** What one capture in a tags query says about a node type. */
export interface TagRule {
  readonly type: string;
  /** The outline tag it maps to. */
  readonly tag: string;
  readonly role: 'declaration' | 'call';
  /** The direct child type holding its name, for a declaration whose name is one. */
  readonly nameChild?: string;
  /** Its name is captured deeper than a direct child, which a mapping cannot follow. */
  readonly nestedName?: boolean;
  /**
   * The pattern only matches it inside this node type (Python's module-level `assignment` as a
   * constant). A mapping tags a node type everywhere, so such a rule cannot be kept as it is.
   */
  readonly within?: string;
  /** The kind as the query wrote it, for a rule that maps to no outline tag. */
  readonly kind: string;
}

/** `@definition.<kind>` kinds and the outline tag each becomes. */
const DEFINITION_TAGS: Readonly<Record<string, string>> = {
  class: 'class',
  function: 'function',
  method: 'method',
  interface: 'interface',
  module: 'module',
  namespace: 'namespace',
  macro: 'macro',
  constant: 'constant',
  type: 'type',
  struct: 'struct',
  enum: 'enum',
  trait: 'trait',
  union: 'union',
};

type Element =
  | { kind: 'node'; type: string; children: Element[]; captures: string[] }
  | { kind: 'alt'; children: Element[]; captures: string[] }
  | { kind: 'other'; captures: string[] };

const TOKEN =
  /\s+|;[^\n]*|"(?:[^"\\]|\\.)*"|[()[\]]|@[\w.-]+|[\w.-]+:|#[\w?!-]+|[*+?.]|[^\s()[\]";@]+/gy;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) {
      TOKEN.lastIndex = start + 1;
      continue;
    }
    const token = match[0];
    if (/^\s/.test(token) || token.startsWith(';')) continue;
    tokens.push(token);
  }
  return tokens;
}

/** Parse the sequence of elements up to `close` (or the end), attaching captures to what they follow. */
function parseSequence(tokens: string[], at: { i: number }, close?: string): Element[] {
  const out: Element[] = [];
  while (at.i < tokens.length) {
    const token = tokens[at.i] as string;
    if (token === close) {
      at.i += 1;
      return out;
    }
    at.i += 1;
    if (token.startsWith('@')) {
      out.at(-1)?.captures.push(token.slice(1));
    } else if (token === '(') {
      const head = tokens[at.i] ?? '';
      if (head.startsWith('#') || head === ')') {
        // A predicate, or `()`: skip to its close.
        parseSequence(tokens, at, ')');
        out.push({ kind: 'other', captures: [] });
      } else {
        at.i += 1;
        out.push({
          kind: 'node',
          type: head,
          children: parseSequence(tokens, at, ')'),
          captures: [],
        });
      }
    } else if (token === '[') {
      out.push({ kind: 'alt', children: parseSequence(tokens, at, ']'), captures: [] });
    } else if (token.endsWith(':') || ['*', '+', '?', '.'].includes(token)) {
      // A field name or a quantifier: the element it belongs to carries what matters.
    } else {
      out.push({ kind: 'other', captures: [] });
    }
  }
  return out;
}

/** The node types an element stands for: itself, or each alternative. */
function typesOf(element: Element): string[] {
  if (element.kind === 'node') return element.type === '_' ? [] : [element.type];
  if (element.kind === 'alt') return element.children.flatMap(typesOf);
  return [];
}

/** Where `@name` is captured below a node: on a direct child (its types), deeper, or nowhere. */
function nameOf(node: Extract<Element, { kind: 'node' }>): { direct?: string; nested: boolean } {
  for (const child of node.children) {
    if (child.captures.includes('name')) {
      const [direct] = typesOf(child);
      return direct === undefined ? { nested: false } : { direct, nested: false };
    }
  }
  const deeper = (elements: Element[]): boolean =>
    elements.some(
      (element) =>
        element.captures.includes('name') ||
        ((element.kind === 'node' || element.kind === 'alt') && deeper(element.children)),
    );
  return { nested: deeper(node.children.flatMap((c) => (c.kind === 'other' ? [] : c.children))) };
}

/**
 * Every definition and call rule in a tags query, in the order written. A node type a query names
 * twice keeps its first rule.
 */
export function parseTagsQuery(text: string): TagRule[] {
  const rules: TagRule[] = [];
  const seen = new Set<string>();
  const add = (rule: TagRule) => {
    if (seen.has(rule.type)) return;
    seen.add(rule.type);
    rules.push(rule);
  };
  const visit = (element: Element, within: string | undefined): void => {
    for (const capture of element.captures) {
      const [scope, kind] = capture.split('.') as [string, string | undefined];
      if (kind === undefined) continue;
      const nodes =
        element.kind === 'node'
          ? [element]
          : element.kind === 'alt'
            ? element.children.filter(
                (child): child is Extract<Element, { kind: 'node' }> => child.kind === 'node',
              )
            : [];
      for (const node of nodes) {
        if (node.type === '_') continue;
        const context = within !== undefined ? { within } : {};
        if (scope === 'reference' && kind === 'call') {
          add({ type: node.type, tag: 'call', role: 'call', kind, ...context });
        } else if (scope === 'definition') {
          const { direct, nested } = nameOf(node);
          add({
            type: node.type,
            tag: DEFINITION_TAGS[kind] ?? '',
            role: 'declaration',
            kind,
            ...(direct !== undefined ? { nameChild: direct } : {}),
            ...(nested ? { nestedName: true } : {}),
            ...context,
          });
        }
      }
    }
    // An alternative's members stand where it stands; a node's children are inside it.
    if (element.kind === 'alt') for (const child of element.children) visit(child, within);
    if (element.kind === 'node') for (const child of element.children) visit(child, element.type);
  };
  for (const element of parseSequence(tokenize(text), { i: 0 })) visit(element, undefined);
  return rules;
}
