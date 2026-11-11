import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryEvent } from '@cntxt-labs/anvesa-core';
import {
  enqueue,
  MAX_QUEUED_EVENTS,
  queueState,
  readQueue,
  SEND_INTERVAL_MS,
  takeDue,
  withEvents,
} from './telemetry-queue.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function queuePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'anvesa-queue-'));
  temporary.push(directory);
  return join(directory, 'telemetry-queue.json');
}

const event = (name: string): TelemetryEvent => ({ type: 'cli_command', name });
const DAY = SEND_INTERVAL_MS;

describe('telemetry queue', () => {
  it('lets the first batch go at once, then at most one a day', () => {
    const path = queuePath();
    const start = 1_800_000_000_000;
    expect(takeDue(path, start)).toBeUndefined(); // nothing to send

    expect(enqueue(path, [event('search'), event('index')])).toBe(true);
    expect(takeDue(path, start)?.map((e) => e.name)).toEqual(['search', 'index']);
    expect(readQueue(path)).toMatchObject({ last_sent: start, seen: 0, events: [] });

    enqueue(path, [event('query')]);
    expect(takeDue(path, start + DAY - 1)).toBeUndefined();
    expect(queueState(path, start + 1)).toEqual({ waiting: 1, nextSendAt: start + DAY });
    expect(takeDue(path, start + DAY)?.map((e) => e.name)).toEqual(['query']);
  });

  it('does not wait out a clock that moved back', () => {
    const path = queuePath();
    enqueue(path, [event('a')]);
    takeDue(path, 2_000_000_000_000);
    enqueue(path, [event('b')]);
    expect(takeDue(path, 1_999_000_000_000)?.map((e) => e.name)).toEqual(['b']);
  });

  it('keeps an even sample of a busy day, capped', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => event(`e${i}`));
    let state = 0;
    const random = (): number => {
      state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
      return state / 2 ** 31;
    };
    const queue = withEvents({ format: 1, seen: 0, events: [] }, many, random);
    expect(queue.events).toHaveLength(MAX_QUEUED_EVENTS);
    expect(queue.seen).toBe(1_000);
    // Not just the first 150: later events made it in.
    const late = queue.events.filter((e) => Number(e.name.slice(1)) >= 500).length;
    expect(late).toBeGreaterThan(30);
  });

  it('reads a broken file as empty, and drops entries that are not events', () => {
    const path = queuePath();
    writeFileSync(path, 'not json', 'utf8');
    expect(readQueue(path)).toEqual({ format: 1, seen: 0, events: [] });
    writeFileSync(
      path,
      JSON.stringify({ last_sent: 5, seen: 'x', events: [event('ok'), 7, { type: 1 }] }),
      'utf8',
    );
    expect(readQueue(path)).toEqual({ format: 1, last_sent: 5, seen: 1, events: [event('ok')] });
  });
});
