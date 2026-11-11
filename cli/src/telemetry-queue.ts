import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TelemetryEvent } from '@cntxt-labs/anvesa-core';
import { lockFile } from './file-lock.ts';

/**
 * The events waiting for the day's batch, kept beside the user config so each person sends at most
 * one batch a day, however many commands and servers they run. It holds anonymous events (what
 * `TelemetryEvent` allows, nothing more), when the last batch went, and how many events the day
 * saw; never an id. Like the usage record, nothing here may fail a command: a file that cannot be
 * read is started again, and a lock that stays busy drops that run's events.
 */

/** At most one batch per person in this long. */
export const SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How many of a day's events the batch carries. The collector takes at most 200 per batch and 64
 * KiB per body; a busy day keeps an even sample of its events (reservoir sampling), not just the
 * first or the last.
 */
export const MAX_QUEUED_EVENTS = 150;
const FORMAT = 1;

export interface TelemetryQueue {
  readonly format: number;
  /** When the last batch was taken to be sent; absent until the first. */
  readonly last_sent?: number;
  /** Events seen since then, of which `events` is an even sample of at most `MAX_QUEUED_EVENTS`. */
  readonly seen: number;
  readonly events: readonly TelemetryEvent[];
}

const empty: TelemetryQueue = { format: FORMAT, seen: 0, events: [] };

const isEvent = (value: unknown): value is TelemetryEvent =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as { readonly type?: unknown }).type === 'string' &&
  typeof (value as { readonly name?: unknown }).name === 'string';

/** The queue as it is on disk; anything missing or malformed reads as empty. */
export function readQueue(path: string): TelemetryQueue {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Missing, unreadable or not JSON: start again rather than fail a command over it.
    return empty;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const queue = raw as Record<string, unknown>;
  const events = Array.isArray(queue.events)
    ? queue.events.filter(isEvent).slice(0, MAX_QUEUED_EVENTS)
    : [];
  const lastSent = queue.last_sent;
  const seen = queue.seen;
  return {
    format: FORMAT,
    ...(typeof lastSent === 'number' && Number.isFinite(lastSent) ? { last_sent: lastSent } : {}),
    seen:
      typeof seen === 'number' && Number.isFinite(seen) && seen >= events.length
        ? Math.floor(seen)
        : events.length,
    events,
  };
}

function writeQueue(path: string, queue: TelemetryQueue): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(queue)}\n`, 'utf8');
  renameSync(temporary, path);
}

/** Run `change` on the queue under its lock; `undefined` when the lock stayed busy or I/O failed. */
function update<T>(
  path: string,
  change: (queue: TelemetryQueue) => [TelemetryQueue, T],
): T | undefined {
  let unlock: (() => void) | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    unlock = lockFile(`${path}.lock`);
    if (!unlock) return undefined;
    const [next, result] = change(readQueue(path));
    writeQueue(path, next);
    return result;
  } catch {
    return undefined;
  } finally {
    unlock?.();
  }
}

/** `queue` with `events` added, keeping an even sample of everything seen since the last batch. */
export function withEvents(
  queue: TelemetryQueue,
  events: readonly TelemetryEvent[],
  random: () => number = Math.random,
): TelemetryQueue {
  const kept = [...queue.events];
  let seen = queue.seen;
  for (const event of events) {
    seen += 1;
    if (kept.length < MAX_QUEUED_EVENTS) kept.push(event);
    else {
      const slot = Math.floor(random() * seen);
      if (slot < MAX_QUEUED_EVENTS) kept[slot] = event;
    }
  }
  return { ...queue, seen, events: kept };
}

/** Add this run's events to the queue. Says whether they were kept. */
export function enqueue(
  path: string,
  events: readonly TelemetryEvent[],
  random: () => number = Math.random,
): boolean {
  if (events.length === 0) return true;
  return update(path, (queue) => [withEvents(queue, events, random), true]) === true;
}

/**
 * The events to send now, if a batch is due: there are some, and none was sent in the last
 * `SEND_INTERVAL_MS`. Taking them marks the batch sent and empties the queue in the same locked
 * step, so two processes never both send, and a failed send still counts: one request a day.
 */
export function takeDue(path: string, now: number): readonly TelemetryEvent[] | undefined {
  return update(path, (queue): [TelemetryQueue, readonly TelemetryEvent[] | undefined] => {
    const due =
      queue.events.length > 0 &&
      (queue.last_sent === undefined ||
        now - queue.last_sent >= SEND_INTERVAL_MS ||
        // A clock moved back: do not wait for it to catch up.
        now < queue.last_sent);
    if (!due) return [queue, undefined];
    return [{ format: FORMAT, last_sent: now, seen: 0, events: [] }, queue.events];
  });
}

/** When the next batch may go, and how many events wait for it: what `telemetry status` shows. */
export function queueState(
  path: string,
  now: number,
): { readonly waiting: number; readonly nextSendAt: number } {
  const queue = readQueue(path);
  const last = queue.last_sent;
  const nextSendAt =
    last === undefined || now < last ? now : Math.max(now, last + SEND_INTERVAL_MS);
  return { waiting: queue.events.length, nextSendAt };
}
