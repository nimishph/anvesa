import { describe, expect, test } from 'bun:test';
import {
  AggregateFailureError,
  assertNever,
  CodeLensError,
  DeadlineExceededError,
  ERROR_CODE_FORMAT,
  InvalidArgumentError,
  InvariantViolationError,
  OperationAbortedError,
  toCodeLensError,
  UnexpectedFailureError,
} from './errors.ts';

/** Stands in for an error thrown by a third-party library. */
class ThirdPartyError extends Error {}

const samples: readonly CodeLensError[] = [
  new InvalidArgumentError('limit', 'a positive integer', 0),
  new DeadlineExceededError('embed'),
  new OperationAbortedError('index'),
  new InvariantViolationError('impossible'),
  new AggregateFailureError('fan-out', []),
  new UnexpectedFailureError('parse', 'boom'),
];

describe('error taxonomy', () => {
  test('every code follows <SUBSYSTEM>_<REASON> and is unique', () => {
    const codes = samples.map((e) => e.code);
    for (const code of codes) expect(code).toMatch(ERROR_CODE_FORMAT);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('name is the concrete class, not "Error"', () => {
    expect(new InvalidArgumentError('x', 'y', 1).name).toBe('InvalidArgumentError');
  });

  test('is() recognises typed errors only', () => {
    expect(CodeLensError.is(samples[0])).toBe(true);
    expect(CodeLensError.is(new ThirdPartyError('x'))).toBe(false);
    expect(CodeLensError.is('x')).toBe(false);
  });
});

describe('serialization', () => {
  test('carries code, subsystem, context, hint and the whole cause chain', () => {
    const root = new ThirdPartyError('disk gone');
    const mid = new UnexpectedFailureError('read', root, { context: { path: 'a.ts' } });
    const top = new InvalidArgumentError('path', 'readable file', 'a.ts', {
      cause: mid,
      hint: 'check permissions',
    });
    const json = top.toJSON();
    expect(json).toMatchObject({
      name: 'InvalidArgumentError',
      code: 'CORE_INVALID_ARGUMENT',
      subsystem: 'core',
      hint: 'check permissions',
      context: { argument: 'path' },
    });
    expect(json.cause).toMatchObject({
      code: 'CORE_UNEXPECTED_FAILURE',
      context: { path: 'a.ts' },
    });
    expect(JSON.stringify(json)).toContain('disk gone');
  });

  test('survives cyclic context, bigint, functions and non-error causes', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    function named(): string {
      return 'x';
    }
    const error = new InvariantViolationError('weird', {
      cause: { not: 'an error' },
      context: { cyclic, big: 10n, fn: named, nothing: undefined, nan: Number.NaN },
    });
    const text = JSON.stringify(error.toJSON());
    expect(text).toContain('[circular]');
    expect(text).toContain('"big":"10"');
    expect(text).toContain('[function named]');
    expect(text).toContain('NonErrorCause');
  });

  test('a cause cycle terminates and is marked', () => {
    const a = new InvariantViolationError('a');
    const b = new InvariantViolationError('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    expect(JSON.stringify(a.toJSON())).toContain('[circular cause]');
    expect(a.causeChain()).toEqual([a, b]);
  });
});

describe('normalisation', () => {
  test('typed errors pass through untouched', () => {
    const typed = new DeadlineExceededError('x');
    expect(toCodeLensError(typed, 'op')).toBe(typed);
  });

  test('foreign errors are wrapped with the operation and kept as the cause', () => {
    const foreign = new ThirdPartyError('bad json');
    const wrapped = toCodeLensError(foreign, 'load-config', { file: 'c.json' });
    expect(wrapped).toBeInstanceOf(UnexpectedFailureError);
    expect(wrapped.cause).toBe(foreign);
    expect(wrapped.context).toMatchObject({ operation: 'load-config', file: 'c.json' });
  });

  test('non-error throwables are described, not lost', () => {
    const wrapped = toCodeLensError({ reason: 42 }, 'op');
    expect(wrapped.message).toContain('42');
  });

  test('aggregate keeps every failure', () => {
    const failures = [new DeadlineExceededError('a'), new OperationAbortedError('b')];
    const aggregate = new AggregateFailureError('index', failures);
    expect(aggregate.failures).toEqual(failures);
    expect(aggregate.context.failures).toHaveLength(2);
  });

  test('assertNever throws an invariant violation naming the place', () => {
    expect(() => assertNever('surprise' as never, 'render')).toThrow(InvariantViolationError);
  });
});
