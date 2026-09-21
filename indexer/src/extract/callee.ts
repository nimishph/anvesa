import type { Receiver } from './facts.ts';

/** A callee text broken into the part that names what is called and the part it is called on. */
export interface Callee {
  /** `undefined` when the target is not a plain name (`f()()`, `a[0]()`). */
  readonly name: string | undefined;
  readonly receiver: Receiver | undefined;
}

/** Receivers that stand for the enclosing type. */
const SELF_RECEIVERS: ReadonlySet<string> = new Set([
  'this',
  'self',
  'cls',
  'super',
  'parent',
  'static',
  '$this',
]);

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };
const CLOSERS: ReadonlySet<string> = new Set(Object.values(OPENERS));

/**
 * Break the text of a callee into name and receiver. The text is whatever the grammar put in the
 * callee position, in any of the notations the supported languages use: `a.b`, `a?.b`, `a->b`,
 * `A::b`, `A\b`, with generic arguments (`f<T>`) and null/force suffixes (`f!`, `f?`).
 *
 * Separators inside brackets belong to an argument or a nested expression, not to the chain, so
 * `a.b(c.d).e` is a call to `e` on something complex, not on `c.d`.
 */
export function parseCallee(text: string): Callee {
  const segments = splitChain(text.trim());
  const last = segments.at(-1);
  if (last === undefined) return { name: undefined, receiver: undefined };

  const name = plainName(last);
  if (name === undefined) return { name: undefined, receiver: undefined };
  if (segments.length === 1) return { name, receiver: undefined };

  const owners = segments.slice(0, segments.length - 1).map((segment) => plainName(segment));
  if (owners.some((owner) => owner === undefined)) return { name, receiver: { kind: 'complex' } };
  const chain = owners.join('.');
  if (owners.length === 1 && SELF_RECEIVERS.has(chain)) return { name, receiver: { kind: 'self' } };
  return { name, receiver: { kind: 'name', name: chain } };
}

/** The separators, longest first so `?.` and `::` are not read as `.` and `:`. */
const SEPARATORS: readonly string[] = ['?.', '->', '::', '.', '\\'];

function splitChain(text: string): string[] {
  const segments: string[] = [];
  const expected: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const closer = OPENERS[char];
    if (closer !== undefined) {
      expected.push(closer);
      index += 1;
      continue;
    }
    if (CLOSERS.has(char)) {
      if (expected.at(-1) === char) expected.pop();
      index += 1;
      continue;
    }
    if (expected.length === 0) {
      const separator = SEPARATORS.find((candidate) => text.startsWith(candidate, index));
      if (separator !== undefined) {
        segments.push(text.slice(start, index));
        index += separator.length;
        start = index;
        continue;
      }
    }
    index += 1;
  }
  segments.push(text.slice(start));
  return segments;
}

/** The identifier a segment is, once generics and `?`/`!` are set aside; else `undefined`. */
function plainName(segment: string): string | undefined {
  let text = segment.trim();
  const generic = text.indexOf('<');
  if (generic > 0 && text.endsWith('>')) text = text.slice(0, generic);
  text = text.replace(/[?!]+$/, '');
  return IDENTIFIER.test(text) ? text : undefined;
}
