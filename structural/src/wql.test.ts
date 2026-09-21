import { describe, expect, test } from 'bun:test';
import { WqlRegexError, WqlSyntaxError } from './errors.ts';
import { makeNode, type WNode } from './node.ts';
import { Wql, WqlSpec } from './spec.ts';
import { looksLikeWql, matchWql, parseWql } from './wql.ts';

function syntaxFailure(query: string): WqlSyntaxError {
  try {
    parseWql(query);
  } catch (thrown) {
    if (thrown instanceof WqlSyntaxError) return thrown;
    throw thrown;
  }
  throw new WqlSyntaxError(query, 0, 'the parse to fail');
}

const named = (tag: string, name: string, children: WNode[] = [], extra = {}) =>
  makeNode(tag, { name, baseName: name.split('.').pop() as string, ...extra }, children);

describe('parsing', () => {
  test('reads steps, relations and every predicate kind', () => {
    const query = parseWql(
      `//class//method[@name^="get"][@returns="string"]>param[contains(@name,"x")][@docs][@k$="z"][@n~="^a"]`,
    );
    expect(query.steps.map((s) => [s.tag, s.relation])).toEqual([
      ['class', 'descendant'],
      ['method', 'descendant'],
      ['param', 'child'],
    ]);
    expect(query.steps[1]?.predicates.map((p) => p.op)).toEqual(['starts', 'eq']);
    expect(query.steps[2]?.predicates.map((p) => p.op)).toEqual([
      'contains',
      'exists',
      'ends',
      'regex',
    ]);
  });

  test('a leading "//" is optional, and "*" and a predicate-only step mean any tag', () => {
    expect(parseWql('class').steps[0]?.tag).toBe('class');
    expect(parseWql('//*').steps[0]?.tag).toBe('*');
    expect(parseWql('//[@name="x"]').steps[0]?.tag).toBe('*');
  });

  test('whitespace around steps and inside brackets is allowed', () => {
    expect(parseWql('  //class  >  method [ @name = "x" ]  ').steps).toHaveLength(2);
  });

  test('single and double quotes both work and values keep their whitespace', () => {
    const [double, single] = [parseWql('//a[@x=" p q "]'), parseWql("//a[@x=' p q ']")];
    expect(double.steps[0]?.predicates[0]?.value).toBe(' p q ');
    expect(single.steps[0]?.predicates[0]?.value).toBe(' p q ');
  });

  test('bare values are accepted', () => {
    expect(parseWql('//a[@name=foo]').steps[0]?.predicates[0]?.value).toBe('foo');
  });

  test('escapes: \\\\, \\" and \\\' are unescaped; other backslashes are kept for regexes', () => {
    const value = (text: string) => parseWql(text).steps[0]?.predicates[0]?.value;
    expect(value('//a[@x="say \\"hi\\""]')).toBe('say "hi"');
    expect(value("//a[@x='it\\'s']")).toBe("it's");
    expect(value('//a[@x="a\\\\b"]')).toBe('a\\b');
    expect(value('//a[@x~="\\d+\\.\\d"]')).toBe('\\d+\\.\\d');
  });

  test('a quoted "]" no longer closes the predicate', () => {
    expect(parseWql('//a[@x="a]b"]').steps[0]?.predicates[0]?.value).toBe('a]b');
  });

  test('looksLikeWql tells paths from prose', () => {
    expect(looksLikeWql('  //class')).toBe(true);
    expect(looksLikeWql('how do I parse a file')).toBe(false);
  });
});

describe('errors', () => {
  test('an empty query is an error, not an empty result', () => {
    expect(syntaxFailure('').code).toBe('STRUCTURAL_WQL_SYNTAX');
    expect(syntaxFailure('   ').offset).toBe(3);
  });

  test('points at the offending character with a caret', () => {
    const error = syntaxFailure('//class[@name=]');
    expect(error.offset).toBe(14);
    expect(error.message).toContain('//class[@name=]\n');
    expect(error.message).toContain(`${' '.repeat(14)}^`);
    expect(error.hint).toContain('Example');
  });

  test.each([
    ['//class[', '"@"'],
    ['//class[@name="x"', '"]"'],
    ['//class[@name="x]', 'closing "'],
    ['//class[name="x"]', '"@"'],
    ['//class[@name=="x"]', 'value'],
    ['//class//', 'tag name'],
    ['//class method', '"//", ">"'],
    ['//1abc', 'tag name'],
    ['//class[contains(@name "x")]', '","'],
  ])('%s -> mentions %s', (query, expected) => {
    expect(syntaxFailure(query).message).toContain(expected);
  });

  test('an invalid regular expression is its own error, with the cause kept', () => {
    try {
      parseWql('//a[@name~="(unclosed"]');
      throw new WqlSyntaxError('', 0, 'a regex failure');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(WqlRegexError);
      expect((thrown as WqlRegexError).cause).toBeInstanceOf(SyntaxError);
      expect((thrown as WqlRegexError).context.pattern).toBe('(unclosed');
    }
  });
});

describe('matching', () => {
  const tree = makeNode('program', { path: 'src/a.ts' }, [
    named('class', 'Outer', [
      named('method', 'Outer.run', [], { returns: 'void' }),
      named('class', 'Outer.Inner', [
        named('method', 'Outer.Inner.run', [], { returns: 'string' }),
      ]),
    ]),
    named('function', 'run', [], { returns: 'string', docs: 'yes' }),
  ]);
  const names = (query: string, roots: readonly WNode[] = [tree]) =>
    matchWql(parseWql(query), roots).map((m) => m.node.attrs.get('name'));

  test('descendant finds a tag at any depth, in document order', () => {
    expect(names('//method')).toEqual(['Outer.run', 'Outer.Inner.run']);
  });

  test('child finds only direct children', () => {
    expect(names('//class>method')).toEqual(['Outer.run', 'Outer.Inner.run']);
    expect(names('//program>method')).toEqual([]);
    expect(names('//program>function')).toEqual(['run']);
  });

  test('a node reachable through several matches is returned once', () => {
    // The inner method is inside both Outer and Outer.Inner.
    expect(names('//class//method')).toEqual(['Outer.run', 'Outer.Inner.run']);
    expect(names('//class//class//method')).toEqual(['Outer.Inner.run']);
  });

  test('"*" matches every node', () => {
    expect(matchWql(parseWql('//*'), [tree])).toHaveLength(6);
  });

  test('a first step with a child relation only matches the roots themselves', () => {
    expect(matchWql(parseWql('//program'), [tree])).toHaveLength(1);
    expect(
      matchWql({ source: '', steps: [{ tag: 'program', relation: 'child', predicates: [] }] }, [
        tree,
      ]),
    ).toHaveLength(1);
    expect(
      matchWql({ source: '', steps: [{ tag: 'class', relation: 'child', predicates: [] }] }, [
        tree,
      ]),
    ).toHaveLength(0);
  });

  test('every operator', () => {
    expect(names('//*[@name="run"]')).toEqual(['Outer.run', 'Outer.Inner.run', 'run']);
    expect(names('//*[@returns^="str"]')).toEqual(['Outer.Inner.run', 'run']);
    expect(names('//*[@returns$="oid"]')).toEqual(['Outer.run']);
    expect(names('//*[contains(@name,"nner")]')).toEqual(['Outer.Inner', 'Outer.Inner.run']);
    expect(names('//function[@returns~="^s.r"]')).toEqual(['run']);
    expect(names('//*[@docs]')).toEqual(['run']);
  });

  test('predicates combine with AND', () => {
    expect(names('//*[@name="run"][@returns="void"]')).toEqual(['Outer.run']);
  });

  test('@name answers to every dotted suffix of a qualified name', () => {
    expect(names('//method[@name="Outer.Inner.run"]')).toEqual(['Outer.Inner.run']);
    expect(names('//method[@name="Inner.run"]')).toEqual(['Outer.Inner.run']);
    expect(names('//method[@name="Outer.run"]')).toEqual(['Outer.run']);
    expect(names('//method[@name="ner.run"]')).toEqual([]);
  });

  test('an absent attribute never matches a value test', () => {
    expect(names('//program[@name=""]')).toEqual([]);
    expect(names('//program[contains(@name,"")]')).toEqual([]);
    expect(names('//*[@nothing]')).toEqual([]);
  });

  test('@path is answered from the context when a node carries none', () => {
    const hits = matchWql(parseWql('//class[@path="src/a.ts"]'), [tree], { path: 'src/a.ts' });
    expect(hits).toHaveLength(2);
    expect(
      matchWql(parseWql('//class[@path="other.ts"]'), [tree], { path: 'src/a.ts' }),
    ).toHaveLength(0);
  });

  test('matches a very deep tree without recursion', () => {
    let node: WNode = named('leaf', 'target');
    for (let level = 0; level < 50_000; level += 1) node = named('n', 'x', [node]);
    expect(matchWql(parseWql('//n//leaf'), [node])).toHaveLength(1);
  });

  test('returns each match with its parent', () => {
    const [match] = matchWql(parseWql('//method[@name="Outer.run"]'), [tree]);
    expect(match?.parent?.attrs.get('name')).toBe('Outer');
  });
});

describe('the builder produces queries the parser reads back exactly', () => {
  // Deterministic pseudo-random strings drawn from the characters that used to break the language.
  const alphabet = [
    'a',
    'B',
    '1',
    ' ',
    '"',
    "'",
    '\\',
    ']',
    '[',
    '(',
    ')',
    ',',
    '=',
    '^',
    '$',
    '~',
    '@',
    '/',
    '>',
    '\n',
    'é',
  ];
  let seed = 42;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed;
  };
  const randomValue = () =>
    Array.from({ length: next() % 12 }, () => alphabet[next() % alphabet.length]).join('');

  test('any value round-trips through eq, starts, ends and contains', () => {
    for (let i = 0; i < 300; i += 1) {
      const value = randomValue();
      for (const build of [Wql.eq, Wql.starts, Wql.ends, Wql.contains]) {
        const query = parseWql(WqlSpec.tag('t').where(build('attr', value)).toString());
        expect(query.steps[0]?.predicates[0]?.value).toBe(value);
      }
    }
  });

  test('regex patterns round-trip too', () => {
    const pattern = '^get[A-Z]\\w+\\\\$';
    const query = parseWql(WqlSpec.tag('t').where(Wql.regex('name', pattern)).toString());
    expect(query.steps[0]?.predicates[0]?.value).toBe(pattern);
    expect(query.steps[0]?.predicates[0]?.regex?.source).toBe(pattern);
  });

  test('a value that would have injected a predicate stays a value', () => {
    const hostile = '") or @kind="function"] //*[@x="';
    const query = parseWql(WqlSpec.tag('a').where(Wql.eq('name', hostile)).toString());
    expect(query.steps).toHaveLength(1);
    expect(query.steps[0]?.predicates).toHaveLength(1);
    expect(query.steps[0]?.predicates[0]?.value).toBe(hostile);
  });

  test('chains descendant, child and exists', () => {
    const text = WqlSpec.tag('class')
      .descendant('method')
      .child('param')
      .where(Wql.exists('type'))
      .toString();
    expect(text).toBe('//class//method>param[@type]');
    expect(parseWql(text).steps).toHaveLength(3);
  });

  test('tag and attribute names are validated', () => {
    expect(() => WqlSpec.tag('bad name')).toThrow(/tag name/);
    expect(() => Wql.eq('a]', 'x')).toThrow(/attribute name/);
    expect(() => WqlSpec.tag('a').child('')).toThrow(/tag name/);
  });
});
