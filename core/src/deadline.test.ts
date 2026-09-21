import { describe, expect, test } from 'bun:test';
import { Deadline } from './deadline.ts';
import {
  DeadlineExceededError,
  InvalidArgumentError,
  InvariantViolationError,
  OperationAbortedError,
  UnexpectedFailureError,
} from './errors.ts';

/** Stands in for an error thrown by a third-party library. */
class ThirdPartyError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

describe('Deadline', () => {
  test('rejects a non-positive or non-finite budget', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => Deadline.of({ timeoutMs: bad })).toThrow(InvalidArgumentError);
    }
  });

  test('unbounded never expires and has no remaining budget', () => {
    const deadline = Deadline.unbounded();
    expect(deadline.expired).toBe(false);
    expect(deadline.remainingMs()).toBeNull();
    expect(() => deadline.throwIfExpired('op')).not.toThrow();
  });

  test('a time budget reports remaining time and then expires as DeadlineExceeded', async () => {
    const deadline = Deadline.of({ timeoutMs: 30 });
    expect(deadline.remainingMs()).toBeGreaterThan(0);
    await sleep(80);
    expect(deadline.expired).toBe(true);
    expect(() => deadline.throwIfExpired('embed')).toThrow(DeadlineExceededError);
  });

  test('a budget that runs out during synchronous work is noticed without an event-loop turn', () => {
    const deadline = Deadline.of({ timeoutMs: 10 });
    const until = performance.now() + 30;
    while (performance.now() < until) {
      // Busy-wait: the timer behind the signal cannot fire while this loop holds the thread.
    }
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.expired).toBe(true);
    expect(() => deadline.throwIfExpired('parse')).toThrow(DeadlineExceededError);
  });

  test('caller cancellation is reported as an abort, not a timeout', () => {
    const controller = new AbortController();
    const deadline = Deadline.of({ signal: controller.signal, timeoutMs: 60_000 });
    controller.abort(new InvariantViolationError('user pressed ctrl-c'));
    expect(() => deadline.throwIfExpired('index')).toThrow(OperationAbortedError);
  });

  test('run returns the result when work finishes in time', async () => {
    const result = await Deadline.of({ timeoutMs: 1000 }).run('op', async () => 7);
    expect(result).toBe(7);
  });

  test('run converts a deadline-caused failure and keeps the original as cause', async () => {
    const deadline = Deadline.of({ timeoutMs: 20 });
    const failure = await deadline.run('slow', (signal) => sleep(500, signal)).catch((e) => e);
    expect(failure).toBeInstanceOf(DeadlineExceededError);
    expect(failure.cause).toBeDefined();
    expect(failure.context).toMatchObject({ operation: 'slow', timeoutMs: 20 });
  });

  test('run wraps unrelated failures but keeps typed errors as they are', async () => {
    const deadline = Deadline.unbounded();
    const wrapped = await deadline
      .run('op', async () => Promise.reject(new ThirdPartyError('x')))
      .catch((e) => e);
    expect(wrapped).toBeInstanceOf(UnexpectedFailureError);
    const typed = new InvalidArgumentError('a', 'b', 'c');
    const same = await deadline.run('op', async () => Promise.reject(typed)).catch((e) => e);
    expect(same).toBe(typed);
  });

  test('run refuses to start once already expired', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = { value: false };
    const outcome = await Deadline.of({ signal: controller.signal })
      .run('op', async () => {
        started.value = true;
      })
      .catch((e) => e);
    expect(outcome).toBeInstanceOf(OperationAbortedError);
    expect(started.value).toBe(false);
  });
});
