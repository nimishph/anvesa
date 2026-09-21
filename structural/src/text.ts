import { WExprSyntaxError } from './errors.ts';
import type { WNode } from './node.ts';

/**
 * The W-expression text format.
 *
 *   node  := "(" tag { attr | node } ")"
 *   attr  := key "=" '"' escaped '"'
 *
 * Attributes are written before children. Inside a string `\\`, `\"`, `\n`, `\r` and `\t` are
 * escapes, and nothing else is: a value survives a round trip exactly, whatever it contains.
 *
 * Bump this when the meaning of the text changes, so caches built from older text can be
 * recognised and recomputed.
 */
export const WEXPR_FORMAT_VERSION = 2;

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  '"': '"',
  n: '\n',
  r: '\r',
  t: '\t',
};

export function escapeValue(value: string): string {
  let out = '';
  for (const char of value) {
    switch (char) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += char;
    }
  }
  return out;
}

export interface FormatOptions {
  /** Attribute names left out, e.g. `path` to keep a printed outline short. */
  readonly omit?: ReadonlySet<string>;
}

/** Compact single-line text. Round-trips through `parseWExpr`. */
export function serializeWExpr(root: WNode, options: FormatOptions = {}): string {
  return render(root, options, null);
}

/** Indented text for reading. Same syntax as `serializeWExpr`, so it parses back too. */
export function formatWExpr(root: WNode, options: FormatOptions = {}): string {
  return render(root, options, '  ');
}

interface Frame {
  readonly node: WNode;
  next: number;
}

function render(root: WNode, options: FormatOptions, indent: string | null): string {
  const parts: string[] = [];
  const stack: Frame[] = [];
  const open = (node: WNode): void => {
    if (indent !== null && stack.length > 0) parts.push('\n', indent.repeat(stack.length));
    else if (indent === null && stack.length > 0) parts.push(' ');
    parts.push('(', node.tag);
    for (const [key, value] of node.attrs) {
      if (options.omit?.has(key)) continue;
      parts.push(' ', key, '="', escapeValue(value), '"');
    }
    stack.push({ node, next: 0 });
  };

  open(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    const child = frame.node.children[frame.next];
    if (child) {
      frame.next += 1;
      open(child);
      continue;
    }
    stack.pop();
    if (indent !== null && frame.node.children.length > 0) {
      parts.push('\n', indent.repeat(stack.length));
    }
    parts.push(')');
  }
  return parts.join('');
}

interface Building {
  readonly tag: string;
  readonly attrs: Map<string, string>;
  readonly children: WNode[];
}

/** Parse W-expression text. Any malformed input fails with the offset where it went wrong. */
export function parseWExpr(source: string): WNode {
  let pos = 0;
  const fail = (expected: string): never => {
    throw new WExprSyntaxError(source, pos, expected);
  };
  const skipSpace = (): void => {
    while (pos < source.length && isSpace(source.charCodeAt(pos))) pos += 1;
  };
  const readToken = (what: string): string => {
    const start = pos;
    while (pos < source.length && !isDelimiter(source.charCodeAt(pos))) pos += 1;
    if (pos === start) fail(what);
    return source.slice(start, pos);
  };
  const readString = (): string => {
    pos += 1; // opening quote
    let out = '';
    for (;;) {
      if (pos >= source.length) return fail('a closing quote');
      const char = source[pos] as string;
      if (char === '"') {
        pos += 1;
        return out;
      }
      if (char === '\\') {
        const escaped = ESCAPES[source[pos + 1] ?? ''];
        if (escaped === undefined) {
          pos += 1;
          return fail('one of \\\\ \\" \\n \\r \\t');
        }
        out += escaped;
        pos += 2;
        continue;
      }
      out += char;
      pos += 1;
    }
  };

  const stack: Building[] = [];
  const finish = (): WNode => {
    const done = stack.pop() as Building;
    return { tag: done.tag, attrs: done.attrs, children: done.children };
  };

  skipSpace();
  if (source[pos] !== '(') fail('"(" to start a node');
  let root: WNode | undefined;
  while (root === undefined) {
    skipSpace();
    const char = source[pos];
    if (char === undefined) return fail('")" to close the node');
    if (char === '(') {
      pos += 1;
      skipSpace();
      stack.push({ tag: readToken('a tag name'), attrs: new Map(), children: [] });
      continue;
    }
    if (char === ')') {
      pos += 1;
      const node = finish();
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else root = node;
      continue;
    }
    const current = stack[stack.length - 1] as Building;
    const keyAt = pos;
    const key = readToken('an attribute name, a child "(" or ")"');
    skipSpace();
    if (source[pos] !== '=') fail('"=" after the attribute name');
    pos += 1;
    if (source[pos] !== '"') fail('a quoted attribute value');
    if (current.attrs.has(key)) {
      pos = keyAt;
      fail(`an attribute name other than the already-used "${key}"`);
    }
    current.attrs.set(key, readString());
  }

  skipSpace();
  if (pos < source.length) fail('end of input after the root node');
  return root;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

function isDelimiter(code: number): boolean {
  return isSpace(code) || code === 0x28 || code === 0x29 || code === 0x3d || code === 0x22;
}
