import { afterAll, describe, expect, test } from 'bun:test';
import type { StructuralEngine } from './engine.ts';
import type { WNode } from './node.ts';
import { disposeEngines, encodeTs, makeEngine, nodesTagged } from './test-support.ts';

const engine: StructuralEngine = makeEngine();
afterAll(disposeEngines);

const attr = (node: WNode | undefined, key: string) => node?.attrs.get(key);
const byName = (root: WNode, tag: string, name: string) =>
  nodesTagged(root, tag).find((n) => n.attrs.get('name') === name);

describe('anonymous callables', () => {
  test('an expression body that is a bare identifier does not become the name', async () => {
    const source = `const a = (x) => x;
const b = (x: number): number => x;
const c = y => y;
`;
    const { root } = await encodeTs(engine, source);
    for (const owner of ['a', 'b', 'c']) {
      const variable = byName(root, 'variable', owner);
      const arrow = variable?.children.find((child) => child.tag === 'arrow');
      expect(attr(arrow, 'name')).toBeUndefined();
      expect(attr(arrow, 'assignedTo')).toBe(owner);
    }
  });
});

describe('naming and structure (TypeScript)', () => {
  const source = `import { x } from './x';
export class Outer {
  run(a: number, ...rest: string[]): void {}
  helper() {
    class Inner {
      deep() {}
    }
  }
}
export function top({ a, b }: Opts, c = 1): string { return c + 1; }
const arrow = (x: number) => x * 2;
export const exported = () => 1;
interface Shape { area(): number }
type Id = string;
`;

  test('produces a program root carrying the path, with 1-based lines', async () => {
    const { root, language } = await encodeTs(engine, source, 'src/a.ts');
    expect(language).toBe('typescript');
    expect(root.tag).toBe('program');
    expect(attr(root, 'path')).toBe('src/a.ts');
    expect(attr(byName(root, 'class', 'Outer'), 'line')).toBe('2');
    expect(attr(byName(root, 'class', 'Outer'), 'endLine')).toBe('9');
  });

  test('only the root carries a path; other nodes do not repeat it', async () => {
    const { root } = await encodeTs(engine, source);
    const others = nodesTagged(root, 'class').concat(nodesTagged(root, 'method'));
    expect(others.every((n) => !n.attrs.has('path'))).toBe(true);
  });

  test('qualifies names through every named ancestor, and through nameless wrappers', async () => {
    const { root } = await encodeTs(engine, source);
    expect(byName(root, 'method', 'Outer.run')).toBeDefined();
    expect(byName(root, 'class', 'Outer.helper.Inner')).toBeDefined();
    expect(byName(root, 'method', 'Outer.helper.Inner.deep')).toBeDefined();
    expect(attr(byName(root, 'method', 'Outer.run'), 'baseName')).toBe('run');
    // `export` has no name of its own, yet its class is still "Outer", not "export.Outer".
    expect(byName(root, 'class', 'Outer')).toBeDefined();
  });

  test('keeps the nesting of the code: a method sits under its class', async () => {
    const { root } = await encodeTs(engine, source);
    const outer = byName(root, 'class', 'Outer') as WNode;
    expect(nodesTagged(outer, 'method').map((m) => attr(m, 'name'))).toContain('Outer.run');
  });

  test('does not visit keyword or punctuation tokens', async () => {
    const { root } = await encodeTs(engine, 'class A {}');
    const classes = nodesTagged(root, 'class');
    expect(classes).toHaveLength(1);
    expect(classes[0]?.children).toHaveLength(0);
  });

  test('extracts parameters (destructuring, rest, defaults) and return types', async () => {
    const { root } = await encodeTs(engine, source);
    const run = byName(root, 'method', 'Outer.run');
    expect(attr(run, 'params')).toBe('a, ...rest');
    expect(attr(run, 'returns')).toBe('void');
    expect(attr(run, 'signature')).toBe('Outer.run(a, ...rest):void');
    const top = byName(root, 'function', 'top');
    expect(attr(top, 'params')).toBe('{a, b}, c');
    expect(attr(top, 'returns')).toBe('string');
  });

  test('an arrow assigned to a variable is identified by that name', async () => {
    const { root } = await encodeTs(engine, source);
    const arrows = nodesTagged(root, 'arrow');
    const named = arrows.find((n) => attr(n, 'assignedTo') === 'arrow');
    expect(named).toBeDefined();
    expect(named?.attrs.has('name')).toBe(false);
    expect(attr(named, 'signature')).toBe('arrow(x)');
    expect(arrows.some((n) => attr(n, 'assignedTo') === 'exported')).toBe(true);
    expect(attr(byName(root, 'variable', 'arrow'), 'name')).toBe('arrow');
  });

  test('interfaces and type aliases are named', async () => {
    const { root } = await encodeTs(engine, source);
    expect(byName(root, 'interface', 'Shape')).toBeDefined();
    expect(byName(root, 'type', 'Id')).toBeDefined();
  });

  test('import statements are structural', async () => {
    const { root } = await encodeTs(engine, source);
    expect(nodesTagged(root, 'import')).toHaveLength(1);
  });
});

describe('body classification', () => {
  const kinds = async (source: string) => {
    const { root } = await encodeTs(engine, source);
    return nodesTagged(root, 'function')
      .concat(nodesTagged(root, 'arrow'))
      .map((n) => [attr(n, 'bodyKind'), attr(n, 'bodyStmts')]);
  };

  test.each([
    ['function f() {}', ['empty', '0']],
    ['function f() { /* todo */ }', ['comment-only', '0']],
    ["function f() { throw new Error('x'); }", ['throw-only', '1']],
    ['function f() { return 42; }', ['return-literal', '1']],
    ['function f() { return; }', ['return-literal', '1']],
    ['function f() { const x = 1; return x; }', ['real', '2']],
    ['const g = () => 42;', ['return-literal', '1']],
    ['const g = () => a + b;', ['real', '1']],
    ['const g = () => ({});', ['real', '1']],
  ])('%s', async (source, expected) => {
    expect((await kinds(source))[0]).toEqual(expected);
  });
});

describe('structural shape', () => {
  const shapes = async (source: string) => {
    const { root } = await encodeTs(engine, source);
    return new Map(
      nodesTagged(root, 'function').map((n) => [attr(n, 'name') as string, attr(n, 'shape')]),
    );
  };

  test('renamed and re-valued copies share a shape', async () => {
    const s = await shapes(`
      function add(a, b) { return a + b; }
      function plus(x, y) { /* different comment */ return x + y; }
      function scaled(a, b) { return a * 2; }
      function scaled2(p, q) { return p * 9; }
    `);
    expect(s.get('add')).toBe(s.get('plus'));
    expect(s.get('scaled')).toBe(s.get('scaled2'));
  });

  test('a different operator or extra work changes the shape', async () => {
    const s = await shapes(`
      function add(a, b) { return a + b; }
      function sub(a, b) { return a - b; }
      function more(a, b) { return a + b + 1; }
    `);
    expect(s.get('add')).not.toBe(s.get('sub'));
    expect(s.get('add')).not.toBe(s.get('more'));
  });

  test('the grouping of subtrees matters, not just the sequence of nodes', async () => {
    const s = await shapes(`
      function p() { return f(a(b), c); }
      function q() { return f(a(b, c)); }
    `);
    expect(s.get('p')).not.toBe(s.get('q'));
  });

  test('records how many syntax nodes the shape covers', async () => {
    const { root } = await encodeTs(
      engine,
      'function tiny() {}\nfunction big(a) { return a + a * a; }',
    );
    const [tiny, big] = nodesTagged(root, 'function');
    expect(Number(attr(big, 'shapeNodes'))).toBeGreaterThan(Number(attr(tiny, 'shapeNodes')));
  });
});

describe('depth', () => {
  const nested = 'function a() { function b() { function c() {} } }';

  test('reports the deepest nesting and has no limit by default', async () => {
    const { stats } = await encodeTs(engine, nested);
    expect(stats.deepest).toBe(3);
    expect(stats.omitted).toBe(0);
    expect(stats.depthLimit).toBeUndefined();
  });

  test('a caller-set maxDepth is applied, counted and reported, never silent', async () => {
    const result = await engine.encode(nested, { path: 'n.ts' }, { maxDepth: 2 });
    expect(nodesTagged(result.root, 'function').map((n) => attr(n, 'name'))).toEqual(['a', 'a.b']);
    expect(result.stats.omitted).toBe(1);
    expect(result.stats.depthLimit).toEqual({
      name: 'maxDepth',
      applied: 2,
      source: 'caller',
      reached: true,
    });
  });

  test('a maxDepth that cuts nothing says it was not reached', async () => {
    const result = await engine.encode(nested, { path: 'n.ts' }, { maxDepth: 10 });
    expect(result.stats.depthLimit?.reached).toBe(false);
    expect(result.stats.omitted).toBe(0);
  });

  test('deeply nested code encodes without recursion', async () => {
    const depth = 1500;
    const source = `${Array.from({ length: depth }, (_, i) => `function f${i}() {`).join('')}${'}'.repeat(depth)}`;
    const { stats, root } = await encodeTs(engine, source);
    expect(stats.deepest).toBe(depth);
    expect(nodesTagged(root, 'function')).toHaveLength(depth);
  });
});

describe('broken and other-language source', () => {
  test('source that does not fully parse still encodes, and says so', async () => {
    const result = await encodeTs(engine, 'function ok() {}\nfunction ( { const = ;');
    expect(result.hasSyntaxErrors).toBe(true);
    expect(nodesTagged(result.root, 'function').some((n) => attr(n, 'name') === 'ok')).toBe(true);
  });

  test('clean source reports no syntax errors', async () => {
    expect((await encodeTs(engine, 'const a = 1;')).hasSyntaxErrors).toBe(false);
  });

  test('Python: classes, methods as functions, splats and docstring bodies', async () => {
    const source = `class Repo:
    """Docs."""
    def find(self, key, *args, **kwargs):
        pass

    def stub(self):
        """only docs"""

def top(a, b=1):
    return a
`;
    const { root, language } = await engine.encode(source, { path: 'repo.py' });
    expect(language).toBe('python');
    expect(root.tag).toBe('module');
    const find = byName(root, 'function', 'Repo.find');
    expect(attr(find, 'params')).toBe('self, key, ...args, **kwargs');
    expect(attr(find, 'bodyKind')).toBe('empty');
    expect(attr(byName(root, 'function', 'Repo.stub'), 'bodyKind')).toBe('comment-only');
    expect(attr(byName(root, 'function', 'top'), 'params')).toBe('a, b');
    expect(attr(byName(root, 'function', 'top'), 'bodyKind')).toBe('real');
  });
});

describe('doc comments', () => {
  const documented = `/** Parses input.
 * @param text the text
 */
export function parse(text: string) { return text; }

// first line
// second line
class Widget {
  // inside the class
  render() {}

  // detached comment

  stale() {}
}

const undocumented = () => 1;
`;
  const docs = async (source: string, path = 'a.ts') =>
    (await engine.encode(source, { path }, { docs: true })).root;

  test('are off by default', async () => {
    const { root } = await encodeTs(engine, documented);
    expect(nodesTagged(root, 'function')[0]?.attrs.has('doc')).toBe(false);
  });

  test('attach a block comment above an exported declaration', async () => {
    const root = await docs(documented);
    const parse = byName(root, 'function', 'parse');
    expect(attr(parse, 'doc')).toContain('Parses input.');
    expect(attr(parse, 'doc')).toContain('@param text');
  });

  test('join consecutive line comments, and only those directly above', async () => {
    const root = await docs(documented);
    expect(attr(byName(root, 'class', 'Widget'), 'doc')).toBe('// first line\n// second line');
    expect(attr(byName(root, 'method', 'Widget.render'), 'doc')).toBe('// inside the class');
  });

  test('a comment separated by a blank line is not the doc of the symbol below it', async () => {
    const root = await docs(documented);
    expect(byName(root, 'method', 'Widget.stale')?.attrs.has('doc')).toBe(false);
  });

  test('symbols without a comment carry no doc attribute', async () => {
    const root = await docs(documented);
    const arrow = nodesTagged(root, 'arrow')[0];
    expect(arrow?.attrs.has('doc')).toBe(false);
  });

  test('Python docstrings are found in the body', async () => {
    const root = await docs(
      'class Repo:\n    """Stores things."""\n    def find(self):\n        """Look one up."""\n        return 1\n',
      'r.py',
    );
    expect(attr(byName(root, 'class', 'Repo'), 'doc')).toContain('Stores things.');
    expect(attr(byName(root, 'function', 'Repo.find'), 'doc')).toContain('Look one up.');
  });
});
