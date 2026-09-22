import type { SyntaxNode } from '@cntxt-labs/code-lens-syntax';
import type { Callee } from './callee.ts';
import type { Receiver } from './facts.ts';

/**
 * Wrappers that do not change what is being called. `await f<T>(x)` is parsed with the `await`
 * around the callee, `(a.b)!()` has parentheses and a non-null assertion, `(f as G)()` a cast.
 */
const TRANSPARENT: ReadonlySet<string> = new Set([
  'await_expression',
  'parenthesized_expression',
  'non_null_expression',
  'as_expression',
  'satisfies_expression',
]);

/** Nodes that are just a name. */
const NAME_NODES: ReadonlySet<string> = new Set([
  'identifier',
  'property_identifier',
  'private_property_identifier',
  'type_identifier',
]);

const SELF_NAMES: ReadonlySet<string> = new Set(['this', 'self', 'cls']);

function unwrap(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (TRANSPARENT.has(current.type)) {
    const inner = current.namedChildren[0];
    if (!inner) break;
    current = inner;
  }
  return current;
}

/**
 * What is called, read from the syntax of the callee: a name, or a member of something. Returns
 * `'unknown'` for a node this does not know, so the caller can fall back to reading its text.
 *
 * Reading the tree matters: the text of a callee can contain whole function bodies (`a(() => {
 * f("(") }).b()`), where a scan of characters cannot tell code from string contents.
 */
export function calleeFromSyntax(node: SyntaxNode): Callee | 'unknown' {
  const callee = unwrap(node);
  if (NAME_NODES.has(callee.type)) return { name: callee.text, receiver: undefined };
  if (callee.type === 'this' || callee.type === 'super') {
    return { name: undefined, receiver: undefined };
  }

  if (callee.type === 'member_expression' || callee.type === 'attribute') {
    const property = callee.childForFieldName(
      callee.type === 'attribute' ? 'attribute' : 'property',
    );
    const object = callee.childForFieldName('object');
    if (!property || !object) return 'unknown';
    if (!NAME_NODES.has(property.type)) return { name: undefined, receiver: undefined };
    return { name: property.text, receiver: receiverOf(object) };
  }

  // A computed member, a call result, a literal: called, but not by a name.
  if (
    callee.type === 'subscript_expression' ||
    callee.type === 'subscript' ||
    callee.type === 'call_expression' ||
    callee.type === 'call' ||
    callee.type === 'function_expression' ||
    callee.type === 'arrow_function' ||
    callee.type === 'lambda'
  ) {
    return { name: undefined, receiver: undefined };
  }
  return 'unknown';
}

/** What a member call is made on. */
function receiverOf(node: SyntaxNode): Receiver {
  const object = unwrap(node);
  if (object.type === 'this' || object.type === 'super') return { kind: 'self' };
  if (object.type === 'identifier') {
    return SELF_NAMES.has(object.text) ? { kind: 'self' } : { kind: 'name', name: object.text };
  }
  // `this.client`, `pkg.util`: a chain of plain names is a name.
  if (object.type === 'member_expression' || object.type === 'attribute') {
    const dotted = dottedName(object);
    if (dotted !== undefined) return { kind: 'name', name: dotted };
  }
  return { kind: 'complex' };
}

function dottedName(node: SyntaxNode): string | undefined {
  const parts: string[] = [];
  let current: SyntaxNode | null = unwrap(node);
  while (current && (current.type === 'member_expression' || current.type === 'attribute')) {
    const property = current.childForFieldName(
      current.type === 'attribute' ? 'attribute' : 'property',
    );
    if (!property || !NAME_NODES.has(property.type)) return undefined;
    parts.unshift(property.text);
    const next: SyntaxNode | null = current.childForFieldName('object');
    current = next ? unwrap(next) : null;
  }
  if (!current) return undefined;
  if (current.type === 'this') parts.unshift('this');
  else if (current.type === 'identifier') parts.unshift(current.text);
  else return undefined;
  return parts.join('.');
}
