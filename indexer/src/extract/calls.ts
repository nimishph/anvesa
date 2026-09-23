import type { SyntaxNode } from '@cntxt-labs/anvesa-syntax';
import { type Callee, parseCallee } from './callee.ts';
import { calleeFromSyntax } from './callee-syntax.ts';
import type { CallFact, CallKind, ExtractionGaps } from './facts.ts';

/**
 * How a syntax node that makes a call says what it calls. Node type names are shared across
 * grammars (`call_expression` is TypeScript, C, Go and Rust alike), so one table covers them; a
 * type that a grammar does not have simply never matches.
 */
interface CallShape {
  readonly kind: CallKind;
  /** A field holding the whole callee: `a.b` in `a.b(x)`. */
  readonly callee?: string;
  /** Fields holding the receiver and the name separately (Java, PHP, Ruby). */
  readonly receiver?: string;
  readonly name?: string;
  /** What joins receiver to name when they are separate fields. */
  readonly joiner?: string;
}

const CALL_SHAPES: Readonly<Record<string, CallShape>> = {
  call_expression: { kind: 'call', callee: 'function' },
  call: { kind: 'call', callee: 'function', receiver: 'receiver', name: 'method' },
  new_expression: { kind: 'new', callee: 'constructor' },
  function_call_expression: { kind: 'call', callee: 'function' },
  invocation_expression: { kind: 'call', callee: 'function' },
  method_invocation: { kind: 'call', receiver: 'object', name: 'name' },
  member_call_expression: { kind: 'call', receiver: 'object', name: 'name' },
  scoped_call_expression: { kind: 'call', receiver: 'scope', name: 'name', joiner: '::' },
  object_creation_expression: { kind: 'new', callee: 'type' },
  jsx_self_closing_element: { kind: 'jsx', callee: 'name' },
  jsx_opening_element: { kind: 'jsx', callee: 'name' },
};

/**
 * Names that look like calls but are not references to a symbol: the parent constructor call and
 * the two loading forms, which are imports.
 */
const NOT_REFERENCES: ReadonlySet<string> = new Set(['super', 'import', 'require']);

/** Collects the calls of one file as a syntax tree is walked, attributing each to its symbol. */
export class CallCollector {
  readonly calls: CallFact[] = [];
  #unnamed = 0;
  readonly #enclosing: (position: number) => string | undefined;

  /** `enclosing` maps a source position to the id of the symbol around it. */
  constructor(enclosing: (position: number) => string | undefined) {
    this.#enclosing = enclosing;
  }

  get gaps(): Pick<ExtractionGaps, 'unnamedCalls'> {
    return { unnamedCalls: this.#unnamed };
  }

  visit(node: SyntaxNode): void {
    const shape = CALL_SHAPES[node.type];
    if (shape === undefined) return;
    const callee = calleeOf(node, shape);
    if (callee === undefined) return;
    if (callee.name === undefined) {
      // `<my-element>` is markup, not an unresolvable call.
      if (shape.kind !== 'jsx') this.#unnamed += 1;
      return;
    }
    if (shape.kind === 'jsx' && !isComponent(callee.name, callee.receiver !== undefined)) return;
    if (callee.receiver === undefined && NOT_REFERENCES.has(callee.name)) return;

    this.calls.push({
      from: this.#enclosing(node.startIndex),
      name: callee.name,
      receiver: callee.receiver,
      kind: shape.kind,
      line: node.startPosition.row + 1,
    });
  }
}

/**
 * What a call node calls. The callee's syntax is read directly where the grammar is known; only
 * for other shapes (a receiver and a name in separate fields, another language's notation) is its
 * text taken apart.
 */
function calleeOf(node: SyntaxNode, shape: CallShape): Callee | undefined {
  if (shape.callee !== undefined && shape.receiver === undefined) {
    const field = node.childForFieldName(shape.callee);
    if (field) {
      const read = calleeFromSyntax(field);
      if (read !== 'unknown') return read;
    }
  }
  const text = calleeText(node, shape);
  return text === undefined ? undefined : parseCallee(text);
}

function calleeText(node: SyntaxNode, shape: CallShape): string | undefined {
  if (shape.receiver !== undefined && shape.name !== undefined) {
    const owner = node.childForFieldName(shape.receiver);
    const name = node.childForFieldName(shape.name);
    if (owner && name) return `${owner.text}${shape.joiner ?? '.'}${name.text}`;
    if (name && shape.callee === undefined) return name.text;
  }
  if (shape.callee !== undefined) {
    const callee = node.childForFieldName(shape.callee);
    if (callee) return callee.text;
  }
  // `new Foo()` in PHP names its class in an unlabelled child.
  if (shape.kind === 'new') {
    return node.namedChildren.find(
      (child) => child.type === 'name' || child.type === 'qualified_name',
    )?.text;
  }
  return undefined;
}

/** `<Card/>` renders a component; `<div/>` is markup. Components are capitalised or dotted. */
function isComponent(name: string, hasReceiver: boolean): boolean {
  if (hasReceiver) return true;
  const first = name.charAt(0);
  return first !== first.toLowerCase();
}
