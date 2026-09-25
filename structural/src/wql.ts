import { WqlRegexError, WqlSyntaxError } from './errors.ts';
import { ATTR, type WNode } from './node.ts';

/**
 * WQL, the W-expression query language.
 *
 *   //class                          every class, at any depth
 *   //*                              every node
 *   //class//method                 a method anywhere inside a class
 *   //class>method                  a method directly inside a class
 *   //method[@name="get"]           attribute equals
 *   //method[@name^="get"]          starts with        ($= ends with)
 *   //method[contains(@name,"et")]  contains
 *   //method[@name~="^get[A-Z]"]    regular expression
 *   //method[@docs]                 attribute exists
 *   //method[@name^="get"][@returns="string"]   predicates combine with AND
 *
 * Quoted values may use single or double quotes. Inside them `\\`, `\"` and `\'` are escapes; any
 * other backslash is kept, so regular expressions read naturally (`"\d+"`). Whitespace inside a
 * value is significant and is never trimmed. `@name` also matches a qualified name by its dotted
 * suffixes: `@name="listRules"` finds `SageService.listRules`.
 */

export type WqlOp =
  | 'eq'
  | 'contains'
  | 'starts'
  | 'ends'
  | 'regex'
  | 'exists'
  | 'and'
  | 'or'
  | 'not';

export interface WqlPredicate {
  readonly attr?: string;
  readonly op: WqlOp;
  readonly value?: string;
  /** Compiled once when the query is parsed. Present only for `regex`. */
  readonly regex?: RegExp;
  readonly left?: WqlPredicate;
  readonly right?: WqlPredicate;
  readonly inner?: WqlPredicate;
}

export interface WqlStep {
  /** A tag, or `*` for any. */
  readonly tag: string;
  /** How this step relates to the previous one (or to the searched trees, for the first step). */
  readonly relation: 'descendant' | 'child';
  readonly predicates: readonly WqlPredicate[];
}

export interface WqlQuery {
  readonly source: string;
  readonly steps: readonly WqlStep[];
}

/** True for text that is a WQL path (`//...`), as opposed to a natural-language query. */
export function looksLikeWql(text: string): boolean {
  return text.trimStart().startsWith('//');
}

// --- parsing ------------------------------------------------------------------------------------

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

/** Parse a WQL query. A malformed query fails with the offset of the problem, never silently. */
export function parseWql(source: string): WqlQuery {
  const parser = new Parser(source);
  return { source, steps: parser.parse() };
}

class Parser {
  #pos = 0;

  constructor(private readonly source: string) {}

  parse(): WqlStep[] {
    this.#space();
    const steps: WqlStep[] = [];
    let relation: WqlStep['relation'] = 'descendant';
    if (this.#eat('//')) this.#space();
    for (;;) {
      steps.push(this.#step(relation));
      this.#space();
      if (this.#pos >= this.source.length) return steps;
      if (this.#eat('//')) relation = 'descendant';
      else if (this.#eat('>')) relation = 'child';
      else this.#fail('"//", ">" or the end of the query');
      this.#space();
    }
  }

  #step(relation: WqlStep['relation']): WqlStep {
    let tag = '*';
    const next = this.source[this.#pos];
    if (next === '*') {
      this.#pos += 1;
    } else if (next !== undefined && IDENT_START.test(next)) {
      tag = this.#ident('a tag name');
    } else if (next !== '[') {
      this.#fail('a tag name, "*" or a "[" predicate');
    }
    const predicates: WqlPredicate[] = [];
    for (this.#space(); this.source[this.#pos] === '['; this.#space()) {
      predicates.push(this.#predicate());
    }
    return { tag, relation, predicates };
  }

  #predicate(): WqlPredicate {
    this.#pos += 1; // "["
    this.#space();
    const start = this.#pos;
    const predicate = this.#orExpr();
    this.#space();
    if (this.source[this.#pos] !== ']') {
      this.#pos = this.#pos < this.source.length ? this.#pos : start;
      this.#fail('"]" to close the predicate');
    }
    this.#pos += 1;
    return predicate;
  }

  #orExpr(): WqlPredicate {
    let left = this.#andExpr();
    this.#space();
    while (this.#isKeyword('or')) {
      this.#pos += 2;
      this.#space();
      const right = this.#andExpr();
      left = { op: 'or', left, right };
      this.#space();
    }
    return left;
  }

  #andExpr(): WqlPredicate {
    let left = this.#unaryExpr();
    this.#space();
    while (this.#isKeyword('and')) {
      this.#pos += 3;
      this.#space();
      const right = this.#unaryExpr();
      left = { op: 'and', left, right };
      this.#space();
    }
    return left;
  }

  #unaryExpr(): WqlPredicate {
    this.#space();
    if (this.#isKeyword('not')) {
      this.#pos += 3;
      this.#space();
      if (this.#eat('(')) {
        this.#space();
        const inner = this.#orExpr();
        this.#space();
        this.#expect(')');
        return { op: 'not', inner };
      }
      const inner = this.#unaryExpr();
      return { op: 'not', inner };
    }
    if (this.#eat('!')) {
      this.#space();
      const inner = this.#unaryExpr();
      return { op: 'not', inner };
    }
    if (this.#eat('(')) {
      this.#space();
      const expr = this.#orExpr();
      this.#space();
      this.#expect(')');
      return expr;
    }
    return this.#atom();
  }

  #atom(): WqlPredicate {
    if (this.source.startsWith('contains', this.#pos)) {
      this.#pos += 'contains'.length;
      this.#space();
      this.#expect('(');
      this.#space();
      const attr = this.#attribute();
      this.#space();
      this.#expect(',');
      this.#space();
      const value = this.#value();
      this.#space();
      this.#expect(')');
      return { attr, op: 'contains', value };
    }
    const attr = this.#attribute();
    this.#space();
    const op = this.#operator();
    if (op === undefined) {
      return { attr, op: 'exists', value: '' };
    }
    this.#space();
    const valueAt = this.#pos;
    const value = this.#value();
    return op === 'regex' ? this.#withRegex(attr, value, valueAt) : { attr, op, value };
  }

  #isKeyword(word: string): boolean {
    if (!this.source.startsWith(word, this.#pos)) return false;
    const next = this.source[this.#pos + word.length];
    return next === undefined || /[\s(!@[\])]/.test(next);
  }

  #withRegex(attr: string, pattern: string, valueAt: number): WqlPredicate {
    try {
      return { attr, op: 'regex', value: pattern, regex: new RegExp(pattern) };
    } catch (compileFailure) {
      throw new WqlRegexError(this.source, valueAt, pattern, { cause: compileFailure });
    }
  }

  #attribute(): string {
    this.#expect('@');
    return this.#ident('an attribute name');
  }

  #operator(): Exclude<WqlOp, 'contains' | 'exists'> | undefined {
    for (const [text, op] of OPERATORS) {
      if (this.source.startsWith(text, this.#pos)) {
        this.#pos += text.length;
        return op;
      }
    }
    return undefined;
  }

  #value(): string {
    const quote = this.source[this.#pos];
    if (quote === '"' || quote === "'") return this.#quoted(quote);
    const start = this.#pos;
    if (BARE_FORBIDDEN_START.test(this.source[this.#pos] ?? ''))
      this.#fail('a quoted or bare value');
    while (this.#pos < this.source.length && !BARE_STOP.test(this.source[this.#pos] as string)) {
      this.#pos += 1;
    }
    if (this.#pos === start) this.#fail('a quoted or bare value');
    return this.source.slice(start, this.#pos);
  }

  #quoted(quote: string): string {
    this.#pos += 1;
    let out = '';
    while (this.#pos < this.source.length) {
      const char = this.source[this.#pos] as string;
      if (char === quote) {
        this.#pos += 1;
        return out;
      }
      if (char === '\\') {
        const escaped = this.source[this.#pos + 1];
        if (escaped === '\\' || escaped === '"' || escaped === "'") {
          out += escaped;
          this.#pos += 2;
          continue;
        }
      }
      out += char;
      this.#pos += 1;
    }
    return this.#fail(`a closing ${quote}`);
  }

  #ident(what: string): string {
    const start = this.#pos;
    const first = this.source[this.#pos];
    if (first === undefined || !IDENT_START.test(first)) this.#fail(what);
    this.#pos += 1;
    while (this.#pos < this.source.length && IDENT_PART.test(this.source[this.#pos] as string)) {
      this.#pos += 1;
    }
    return this.source.slice(start, this.#pos);
  }

  #space(): void {
    while (this.#pos < this.source.length && /\s/.test(this.source[this.#pos] as string)) {
      this.#pos += 1;
    }
  }

  #eat(text: string): boolean {
    if (!this.source.startsWith(text, this.#pos)) return false;
    this.#pos += text.length;
    return true;
  }

  #expect(text: string): void {
    if (!this.#eat(text)) this.#fail(`"${text}"`);
  }

  #fail(expected: string): never {
    throw new WqlSyntaxError(this.source, this.#pos, expected);
  }
}

/** Longest first, so `^=` is never read as `=`. */
const OPERATORS: readonly (readonly [string, Exclude<WqlOp, 'contains' | 'exists'>])[] = [
  ['~=', 'regex'],
  ['^=', 'starts'],
  ['$=', 'ends'],
  ['=', 'eq'],
];

const BARE_STOP = /[\s\])"',]/;
/** A bare value cannot start with an operator character; `==` is a typo, not a value. */
const BARE_FORBIDDEN_START = /[=^$~]/;

// --- matching -----------------------------------------------------------------------------------

/** A node found by a query, with its parent so callers can climb without re-walking the tree. */
export interface WqlMatch {
  readonly node: WNode;
  readonly parent: WNode | undefined;
}

export interface MatchContext {
  /** Answers `@path` for nodes that do not carry a `path` attribute (only the root does). */
  readonly path?: string;
}

interface Located {
  readonly node: WNode;
  readonly parent: WNode | undefined;
}

/**
 * Run a query over a set of trees. Every matching node is returned once, in document order, even
 * when it is reachable through several matches of an earlier step (nested classes, say).
 */
export function matchWql(
  query: WqlQuery,
  roots: readonly WNode[],
  context: MatchContext = {},
): WqlMatch[] {
  const first = query.steps[0];
  if (!first) return [];
  let frontier: Located[] = [];
  for (const root of roots) {
    if (first.relation === 'child') {
      if (nodeMatchesStep(first, root, context)) frontier.push({ node: root, parent: undefined });
    } else {
      collect(root, undefined, 'self-and-descendants', frontier, first, context);
    }
  }

  for (let index = 1; index < query.steps.length && frontier.length > 0; index += 1) {
    const step = query.steps[index] as WqlStep;
    const next: Located[] = [];
    const scope: Scope = step.relation === 'child' ? 'children' : 'descendants';
    // Frontier nodes are in document order. When one sits inside the subtree an earlier one
    // already searched, everything under it has been tested, so searching it again would only
    // repeat work (and turn nested matches into a quadratic search).
    const searched = new Set<WNode>();
    for (const from of frontier) {
      if (scope === 'descendants' && searched.has(from.node)) continue;
      collect(from.node, from.parent, scope, next, step, context, searched);
    }
    frontier = next;
  }
  return frontier;
}

type Scope = 'self-and-descendants' | 'descendants' | 'children';

/** Append to `out`, in document order, the nodes under `from` that satisfy `step`. */
function collect(
  from: WNode,
  fromParent: WNode | undefined,
  scope: Scope,
  out: Located[],
  step: WqlStep,
  context: MatchContext,
  searched?: Set<WNode>,
): void {
  const pending: Located[] = [];
  if (scope === 'self-and-descendants') {
    pending.push({ node: from, parent: fromParent });
  } else {
    pushChildren(pending, from);
  }
  while (pending.length > 0) {
    const entry = pending.pop() as Located;
    searched?.add(entry.node);
    if (nodeMatchesStep(step, entry.node, context)) out.push(entry);
    if (scope !== 'children') pushChildren(pending, entry.node);
  }
}

function pushChildren(pending: Located[], parent: WNode): void {
  const { children } = parent;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    pending.push({ node: children[index] as WNode, parent });
  }
}

export const CALLABLE_TAGS: readonly string[] = [
  'function',
  'method',
  'arrow',
  'lambda',
  'closure',
  'constructor',
];

const CALLABLE_TAG_SET: ReadonlySet<string> = new Set(CALLABLE_TAGS);

export function isCallableTag(tag: string): boolean {
  return CALLABLE_TAG_SET.has(tag);
}

export function isCallableVirtualTag(tag: string): boolean {
  return tag === 'callable' || tag === 'fn';
}

/** Does one node satisfy one step's tag and predicates? (Not its relation to other steps.) */
export function nodeMatchesStep(step: WqlStep, node: WNode, context: MatchContext): boolean {
  if (step.tag !== '*' && step.tag !== node.tag) {
    if (isCallableVirtualTag(step.tag)) {
      if (!isCallableTag(node.tag) && node.attrs.get(ATTR.callable) !== 'true') return false;
    } else if (step.tag === 'method' && node.attrs.get(ATTR.isMethod) === 'true') {
      // Matches python/etc method definition inside class
    } else {
      return false;
    }
  }
  return step.predicates.every((predicate) => predicateMatches(predicate, node, context));
}

function predicateMatches(predicate: WqlPredicate, node: WNode, context: MatchContext): boolean {
  if (predicate.op === 'and') {
    return (
      predicate.left !== undefined &&
      predicate.right !== undefined &&
      predicateMatches(predicate.left, node, context) &&
      predicateMatches(predicate.right, node, context)
    );
  }
  if (predicate.op === 'or') {
    return (
      (predicate.left !== undefined && predicateMatches(predicate.left, node, context)) ||
      (predicate.right !== undefined && predicateMatches(predicate.right, node, context))
    );
  }
  if (predicate.op === 'not') {
    return predicate.inner !== undefined && !predicateMatches(predicate.inner, node, context);
  }

  const attr = predicate.attr;
  if (!attr) return false;
  const value = node.attrs.get(attr) ?? (attr === 'path' ? context.path : undefined);
  if (value === undefined) return false;
  if (predicate.op === 'exists') return true;
  if (attr === ATTR.name) return nameMatches(predicate, value);
  return valueMatches(predicate, value);
}

function valueMatches(predicate: WqlPredicate, value: string): boolean {
  switch (predicate.op) {
    case 'eq':
      return value === predicate.value;
    case 'contains':
      return predicate.value !== undefined && value.includes(predicate.value);
    case 'starts':
      return predicate.value !== undefined && value.startsWith(predicate.value);
    case 'ends':
      return predicate.value !== undefined && value.endsWith(predicate.value);
    case 'regex':
      return predicate.regex?.test(value) ?? false;
    case 'exists':
      return true;
    default:
      return false;
  }
}

/**
 * A qualified name such as `Outer.Inner.method` also answers to each of its dotted suffixes
 * (`Inner.method`, `method`), so callers can look a symbol up by the name they know.
 */
function nameMatches(predicate: WqlPredicate, qualified: string): boolean {
  if (valueMatches(predicate, qualified)) return true;
  for (let dot = qualified.indexOf('.'); dot !== -1; dot = qualified.indexOf('.', dot + 1)) {
    if (valueMatches(predicate, qualified.slice(dot + 1))) return true;
  }
  return false;
}
