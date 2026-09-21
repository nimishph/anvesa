import { describe, expect, test } from 'bun:test';
import { WExprSyntaxError } from './errors.ts';
import { makeNode, type WNode } from './node.ts';
import { treesEqual } from './test-support.ts';
import { formatWExpr, parseWExpr, serializeWExpr } from './text.ts';

const sample = (): WNode =>
  makeNode('program', { path: 'src/a.ts' }, [
    makeNode('class', { name: 'A', line: '1' }, [
      makeNode('method', { name: 'A.run', signature: 'A.run(x):void' }),
    ]),
    makeNode('variable', { name: 'x' }),
  ]);

function failure(text: string): WExprSyntaxError {
  try {
    parseWExpr(text);
  } catch (thrown) {
    if (thrown instanceof WExprSyntaxError) return thrown;
    throw thrown;
  }
  throw new WExprSyntaxError(text, 0, 'the parse to fail');
}

describe('round trip', () => {
  test('a tree survives serialize -> parse unchanged', () => {
    const tree = sample();
    expect(treesEqual(parseWExpr(serializeWExpr(tree)), tree)).toBe(true);
  });

  test('values survive exactly, whatever characters they contain', () => {
    const awkward = [
      '',
      'plain',
      'has "double" quotes',
      "it's",
      'back\\slash',
      'ends with backslash\\',
      '\\"',
      'line\nbreak',
      'crlf\r\n',
      'tab\there',
      '(parens) and =equals=',
      '日本語 ✓ 😀',
      ' leading and trailing ',
    ];
    for (const value of awkward) {
      const node = makeNode('n', { v: value });
      const back = parseWExpr(serializeWExpr(node));
      expect(back.attrs.get('v')).toBe(value);
    }
  });

  test('indented output is the same language and parses back to the same tree', () => {
    const tree = sample();
    const pretty = formatWExpr(tree);
    expect(pretty).toContain('\n');
    expect(treesEqual(parseWExpr(pretty), tree)).toBe(true);
  });

  test('omit hides attributes from printed output only', () => {
    const text = serializeWExpr(sample(), { omit: new Set(['path']) });
    expect(text).not.toContain('path=');
    expect(text).toContain('name="A"');
  });

  test('attribute order is preserved', () => {
    const node = makeNode('n', [
      ['z', '1'],
      ['a', '2'],
    ]);
    expect(serializeWExpr(node)).toBe('(n z="1" a="2")');
  });
});

describe('depth', () => {
  test('a very deep tree serializes and parses without touching the call stack', () => {
    const depth = 60_000;
    let node: WNode = makeNode('leaf');
    for (let level = 0; level < depth; level += 1) node = makeNode('n', {}, [node]);
    const text = serializeWExpr(node);
    const back = parseWExpr(text);
    expect(treesEqual(back, node)).toBe(true);
  });

  test('a very wide tree round trips', () => {
    const children = Array.from({ length: 50_000 }, (_, i) => makeNode('c', { i: String(i) }));
    const tree = makeNode('root', {}, children);
    expect(parseWExpr(serializeWExpr(tree)).children).toHaveLength(50_000);
  });
});

describe('malformed input', () => {
  test('reports the offset and shows the line', () => {
    const error = failure('(a (b x="1")');
    expect(error.code).toBe('STRUCTURAL_WEXPR_SYNTAX');
    expect(error.message).toContain('^');
    expect(error.offset).toBe(12);
  });

  test('rejects empty input, plain text and a missing root', () => {
    expect(failure('').offset).toBe(0);
    expect(failure('hello').offset).toBe(0);
    expect(failure('   ').offset).toBe(3);
  });

  test('rejects text after the root node', () => {
    expect(failure('(a) (b)').message).toContain('end of input');
  });

  test('rejects an unterminated string', () => {
    expect(failure('(a v="oops)').message).toContain('closing quote');
  });

  test('rejects an escape it does not define, rather than guessing', () => {
    const error = failure('(a v="bad\\q")');
    expect(error.message).toContain('\\');
    expect(error.offset).toBe(10);
  });

  test('rejects a missing "=" and an unquoted value', () => {
    expect(failure('(a v)').message).toContain('"="');
    expect(failure('(a v=1)').message).toContain('quoted');
  });

  test('rejects a duplicate attribute instead of keeping one silently', () => {
    expect(failure('(a v="1" v="2")').message).toContain('already-used "v"');
  });

  test('an error on the first character of a query that starts with a newline does not crash the excerpt', () => {
    expect(failure('\n)').offset).toBe(1);
  });
});
