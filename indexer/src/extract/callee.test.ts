import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '@sutras/code-lens-core';
import { parseCallee } from './callee.ts';
import type { Receiver } from './facts.ts';
import { bySpan, NestingCursor } from './scope.ts';

describe('parsing a callee', () => {
  const cases: [string, string, Receiver | undefined][] = [
    ['run', 'run', undefined],
    ['this.run', 'run', { kind: 'self' }],
    ['self.run', 'run', { kind: 'self' }],
    ['$this->run', 'run', { kind: 'self' }],
    ['static::create', 'create', { kind: 'self' }],
    ['client.send', 'send', { kind: 'name', name: 'client' }],
    ['this.client.send', 'send', { kind: 'name', name: 'this.client' }],
    ['pkg.util.parse', 'parse', { kind: 'name', name: 'pkg.util' }],
    ['a?.b', 'b', { kind: 'name', name: 'a' }],
    ['Foo::bar', 'bar', { kind: 'name', name: 'Foo' }],
    ['App\\Models\\User', 'User', { kind: 'name', name: 'App.Models' }],
    ['make<Widget>', 'make', undefined],
    ['list.map<string>', 'map', { kind: 'name', name: 'list' }],
    ['maybe!', 'maybe', undefined],
    ['$value', '$value', undefined],
  ];

  test.each(cases)('%s', (text, name, receiver) => {
    expect(parseCallee(text)).toEqual({ name, receiver });
  });

  test('a call on the result of another call has a receiver that cannot be resolved by name', () => {
    expect(parseCallee('a.b().c')).toEqual({ name: 'c', receiver: { kind: 'complex' } });
    expect(parseCallee('items[0].run')).toEqual({ name: 'run', receiver: { kind: 'complex' } });
  });

  test('separators inside brackets do not split the chain', () => {
    expect(parseCallee('make(a.b, c).run')).toEqual({ name: 'run', receiver: { kind: 'complex' } });
  });

  test('a callee that is not a name has no name', () => {
    expect(parseCallee('f()')).toEqual({ name: undefined, receiver: undefined });
    expect(parseCallee('(a || b)')).toEqual({ name: undefined, receiver: undefined });
    expect(parseCallee('')).toEqual({ name: undefined, receiver: undefined });
  });

  test('identifiers may be non-ASCII', () => {
    expect(parseCallee('données.résumé')).toEqual({
      name: 'résumé',
      receiver: { kind: 'name', name: 'données' },
    });
  });
});

describe('nesting cursor', () => {
  const spans = [
    { start: 0, end: 100, id: 'outer' },
    { start: 10, end: 40, id: 'first' },
    { start: 20, end: 30, id: 'deep' },
    { start: 50, end: 90, id: 'second' },
  ].sort(bySpan);

  test('finds the innermost span around each position, walking forward', () => {
    const cursor = new NestingCursor(spans);
    const at = (position: number) => cursor.at(position)?.id;
    expect(at(5)).toBe('outer');
    expect(at(15)).toBe('first');
    expect(at(25)).toBe('deep');
    expect(at(35)).toBe('first');
    expect(at(45)).toBe('outer');
    expect(at(60)).toBe('second');
    expect(at(95)).toBe('outer');
    expect(at(100)).toBeUndefined();
  });

  test('a span ends where its end offset is, exclusive', () => {
    const cursor = new NestingCursor(spans);
    expect(cursor.at(39)?.id).toBe('first');
    expect(cursor.at(40)?.id).toBe('outer');
  });

  test('spans starting together nest the longer one outside', () => {
    const cursor = new NestingCursor(
      [
        { start: 0, end: 5, id: 'short' },
        { start: 0, end: 50, id: 'long' },
      ].sort(bySpan),
    );
    expect(cursor.at(2)?.id).toBe('short');
    expect(cursor.at(10)?.id).toBe('long');
  });

  test('going backwards is a defect and says so', () => {
    const cursor = new NestingCursor(spans);
    cursor.at(50);
    expect(() => cursor.at(10)).toThrow(InvariantViolationError);
  });

  test('no spans, no answers', () => {
    expect(new NestingCursor([]).at(3)).toBeUndefined();
  });
});
