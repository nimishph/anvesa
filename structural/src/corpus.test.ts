import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Deadline, InvalidArgumentError, OperationAbortedError } from '@cntxt-labs/anvesa-core';
import { StructuralIndex } from './corpus.ts';
import type { EncodedFile } from './engine.ts';
import { makeNode, type WNode } from './node.ts';
import { disposeEngines, makeEngine } from './test-support.ts';
import { matchWql, parseWql } from './wql.ts';

const engine = makeEngine();
afterAll(disposeEngines);

const sources: Record<string, string> = {
  'src/parser.ts': `export class Parser {
  parse(input: string): Ast { return build(input); }
  static create() { return new Parser(); }
  class Nested { parse() {} }
}
export function build(text: string) { return text.length; }`,
  'src/lexer.ts': `export class Lexer {
  next() { return 1; }
  parse() { return 2; }
}
export const tokens = () => [];`,
  'pkg/a/util.ts': `export function build(x: number) { return x; }
export function parse(x: number) { return x; }
const helper = () => build(1);`,
  'pkg/b/util.ts': `interface Options { deep: boolean }
export function parse() { return 0; }`,
};

let files: EncodedFile[] = [];
beforeAll(async () => {
  files = await Promise.all(
    Object.entries(sources).map(([path, source]) => engine.encode(source, { path })),
  );
});

function fresh(order: readonly EncodedFile[] = files): StructuralIndex {
  const index = new StructuralIndex();
  for (const file of order) index.set({ path: file.path as string, root: file.root });
  return index;
}

/** What a naive scan of every file would return, in the index's fixed order. */
function reference(query: string): string[] {
  const parsed = parseWql(query);
  return [...files]
    .sort((a, b) => (a.path as string).localeCompare(b.path as string))
    .flatMap((file) =>
      matchWql(parsed, [file.root], { path: file.path as string }).map(
        (m) => `${file.path}:${m.node.attrs.get('line')}:${m.node.attrs.get('name')}`,
      ),
    );
}

const key = (hit: {
  path: string | undefined;
  startLine: number | undefined;
  name: string | undefined;
}) => `${hit.path}:${hit.startLine}:${hit.name}`;

describe('agrees with scanning every file', () => {
  const queries = [
    '//class',
    '//function',
    '//method',
    '//method[@name="parse"]',
    '//method[@name="Parser.parse"]',
    '//*[@name="parse"]',
    '//class//method',
    '//class>method',
    '//class//class//method',
    '//class[@name="Parser"]>method[@name^="cre"]',
    '//export>function[@name="build"]',
    '//function[@name~="^(build|parse)$"]',
    '//*[contains(@name,"ars")]',
    '//variable>arrow',
    '//interface',
    '//function[@path^="pkg/a"]',
    '//*[@returns]',
    '//nothing',
  ];

  test.each(queries)('%s', (query) => {
    const got = fresh().query(query).items.map(key);
    expect(got).toEqual(reference(query));
  });

  test('the result does not depend on the order files were added', () => {
    const forward = fresh(files).query('//method').items.map(key);
    const backward = fresh([...files].reverse())
      .query('//method')
      .items.map(key);
    expect(backward).toEqual(forward);
  });
});

describe('postings pruning', () => {
  test('a query for a tag only looks in files that have it', () => {
    const index = fresh();
    const result = index.query('//interface');
    expect(result.items).toHaveLength(1);
    expect(result.filesExamined).toBe(1);
    expect(index.fileCount).toBe(4);
  });

  test('a tag no file has examines nothing', () => {
    expect(fresh().query('//enum').filesExamined).toBe(0);
  });

  test('an exact-name query touches only files that contain the name', () => {
    expect(fresh().query('//*[@name="tokens"]').items).toHaveLength(1);
  });

  test('include restricts the search to a subset of paths, such as one package', () => {
    const hits = fresh().query('//function[@name="parse"]', {
      include: (p) => p.startsWith('pkg/b'),
    });
    expect(hits.items.map((h) => h.path)).toEqual(['pkg/b/util.ts']);
  });
});

describe('paging', () => {
  test('walking every page yields each hit once, in order, and reports the limit', () => {
    const index = fresh();
    const all = index.query('//*[@name]').items.map(key);
    const walked: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = index.query(
        '//*[@name]',
        cursor === undefined ? { limit: 4 } : { limit: 4, cursor },
      );
      walked.push(...page.items.map(key));
      expect(page.limit).toMatchObject({ applied: 4, source: 'caller' });
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(walked).toEqual(all);
    expect(pages).toBeGreaterThan(1);
  });

  test('says when a limit cut results off, and knows the total when it did not', () => {
    const index = fresh();
    const cut = index.query('//class', { limit: 1 });
    expect(cut.limit.reached).toBe(true);
    expect(cut.total).toBeNull();
    expect(cut.nextCursor).not.toBeNull();
    const whole = index.query('//class', { limit: 100 });
    expect(whole.limit.reached).toBe(false);
    expect(whole.total).toBe(whole.items.length);
  });

  test('a cursor from before a change is refused rather than returning shifted results', () => {
    const index = fresh();
    const { nextCursor } = index.query('//*[@name]', { limit: 2 });
    index.set({
      path: 'src/new.ts',
      root: makeNode('program', {}, [makeNode('class', { name: 'X' })]),
    });
    expect(() => index.query('//*[@name]', { limit: 2, cursor: nextCursor as string })).toThrow(
      InvalidArgumentError,
    );
  });

  test('a garbage cursor is refused with the parse failure kept', () => {
    try {
      fresh().query('//class', { cursor: '!!!' });
      throw new InvalidArgumentError('test', 'a failure', '');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(InvalidArgumentError);
      expect((thrown as InvalidArgumentError).cause).toBeDefined();
    }
  });
});

describe('changing the index', () => {
  test('set replaces a file and delete removes it', () => {
    const index = fresh();
    expect(index.query('//class[@name="Lexer"]').items).toHaveLength(1);
    index.set({
      path: 'src/lexer.ts',
      root: makeNode('program', {}, [makeNode('class', { name: 'Other' })]),
    });
    expect(index.query('//class[@name="Lexer"]').items).toHaveLength(0);
    expect(index.query('//class[@name="Other"]').items).toHaveLength(1);
    expect(index.delete('src/lexer.ts')).toBe(true);
    expect(index.delete('src/lexer.ts')).toBe(false);
    expect(index.has('src/lexer.ts')).toBe(false);
    expect(index.query('//class[@name="Other"]').items).toHaveLength(0);
  });

  test('tag postings are cleaned up when the last file with a tag goes', () => {
    const index = fresh();
    index.delete('pkg/b/util.ts');
    expect(index.query('//interface').filesExamined).toBe(0);
  });

  test('paths() is sorted and get() returns what was stored', () => {
    const index = fresh();
    expect(index.paths()).toEqual([...index.paths()].sort());
    expect(index.get('src/parser.ts')?.root.tag).toBe('program');
    expect(index.get('missing.ts')).toBeUndefined();
  });
});

describe('deadlines and errors', () => {
  test('a cancelled deadline stops the query with a typed error', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      fresh().query('//class', { deadline: Deadline.of({ signal: controller.signal }) }),
    ).toThrow(OperationAbortedError);
  });

  test('a malformed query reports where it is wrong', () => {
    expect(() => fresh().query('//class[@name=]')).toThrow(/offset 14/);
  });
});

describe('scale and depth', () => {
  test('a very deep chain is matched without recursion or quadratic work', () => {
    let node: WNode = makeNode('leaf', { name: 'target' });
    for (let level = 0; level < 50_000; level += 1) node = makeNode('n', { name: 'x' }, [node]);
    const index = new StructuralIndex();
    index.set({ path: 'deep.ts', root: node });
    const started = performance.now();
    const result = index.query('//n//n//leaf');
    expect(result.items).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('many files stay queryable and consistent with a scan', () => {
    const index = new StructuralIndex();
    for (let i = 0; i < 2000; i += 1) {
      index.set({
        path: `gen/f${String(i).padStart(4, '0')}.ts`,
        root: makeNode('program', {}, [
          makeNode('class', { name: `C${i}` }, [makeNode('method', { name: `C${i}.run` })]),
        ]),
      });
    }
    expect(index.query('//method[@name="run"]', { limit: 5000 }).items).toHaveLength(2000);
    expect(index.query('//class[@name="C1999"]>method').items).toHaveLength(1);
  });
});
