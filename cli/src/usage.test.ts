import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage, recentCommands, recordUse, usageFile } from './usage.ts';

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'anvesa-usage-'));
  homes.push(dir);
  return dir;
};
const known = new Set(['search', 'index', 'status', 'query']);
const DAY = 24 * 60 * 60 * 1000;

describe('usage', () => {
  test('is kept under ANVESA_HOME or the home directory, and nowhere when off or homeless', () => {
    expect(usageFile({ ANVESA_HOME: '/x' })).toBe(join('/x', 'usage.json'));
    expect(usageFile({ HOME: '/h' })).toBe(join('/h', '.anvesa', 'usage.json'));
    expect(usageFile({ USERPROFILE: 'C:/u' })).toBe(join('C:/u', '.anvesa', 'usage.json'));
    expect(usageFile({ HOME: '/h', ANVESA_NO_USAGE: '1' })).toBeUndefined();
    expect(usageFile({})).toBeUndefined();
  });

  test('records only command names it knows, and nothing at all when off', () => {
    const env = { ANVESA_HOME: home() };
    expect(recordUse(env, 'search', known)).toBe(true);
    expect(recordUse(env, '/etc/passwd', known)).toBe(false);
    const stored = JSON.parse(readFileSync(usageFile(env) as string, 'utf8'));
    expect(Object.keys(stored.commands)).toEqual(['search']);

    const off = { ANVESA_HOME: home(), ANVESA_NO_USAGE: '1' };
    expect(recordUse(off, 'search', known)).toBe(false);
    expect(recentCommands(off)).toEqual([]);
  });

  test('what is used now outranks what was used a lot long ago; what went quiet drops off', () => {
    const env = { ANVESA_HOME: home() };
    const now = Date.UTC(2026, 9, 9);
    for (let i = 0; i < 10; i += 1) recordUse(env, 'index', known, {}, now - 60 * DAY);
    recordUse(env, 'search', known, {}, now - DAY);
    recordUse(env, 'search', known, {}, now);
    recordUse(env, 'status', known, {}, now - 120 * DAY);
    expect(recentCommands(env, now)).toEqual(['search', 'index']);
    expect(recentCommands(env, now, 1)).toEqual(['search']);
  });

  test('a file that is not what it should be is started again, not trusted or fatal', () => {
    const env = { ANVESA_HOME: home() };
    const path = usageFile(env) as string;
    writeFileSync(path, '{not json');
    expect(recentCommands(env)).toEqual([]);
    expect(recordUse(env, 'query', known)).toBe(true);
    writeFileSync(
      path,
      JSON.stringify({ query: { score: 'x' }, rm: { score: 9, last: Date.now() } }),
    );
    // The malformed entry is skipped; a well-formed one is read (the help shows only real commands).
    expect(recentCommands(env)).toEqual(['rm']);
    // An unknown name in the file is dropped the next time anything is recorded.
    recordUse(env, 'search', known);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).commands)).toEqual(['search']);
  });

  test('each field holds one fact about the runs', () => {
    const env = { ANVESA_HOME: home() };
    const t0 = Date.UTC(2026, 9, 9, 12);
    recordUse(env, 'search', known, { exit: 0, ms: 120, results: 5, version: '1.2.0' }, t0);
    recordUse(env, 'search', known, { exit: 0, ms: 80, results: 0 }, t0 + 30_000);
    recordUse(env, 'search', known, { exit: 1, ms: 10 }, t0 + DAY);
    recordUse(env, 'search', known, { exit: 2, ms: 1, results: 9 }, t0 + 3 * DAY);
    const use = readUsage(env, t0 + 3 * DAY)?.commands.search;
    expect(use).toMatchObject({
      first_used: t0,
      last_used: t0 + 3 * DAY,
      last_failed: t0 + DAY,
      runs: 4,
      succeeded: 2,
      failed: 1,
      misused: 1,
      // A failed or misused run is neither found nor empty, whatever it reported.
      found: 1,
      empty: 1,
      repeated: 1,
      active_days: 3,
      total_ms: 211,
      last_ms: 1,
      last_version: '1.2.0',
    });
    // Only the two successful runs scored, and they have decayed for three days since.
    expect(use?.score).toBeGreaterThan(1.6);
    expect(use?.score).toBeLessThan(2);
  });

  test('a run that never succeeded does not show in the help', () => {
    const env = { ANVESA_HOME: home() };
    recordUse(env, 'index', known, { exit: 1 });
    recordUse(env, 'query', known, { exit: 2 });
    expect(recentCommands(env)).toEqual([]);
    expect(readUsage(env)?.commands.index?.failed).toBe(1);
  });

  test('a format 1 file is carried over: its score and last use kept, counting from now', () => {
    const env = { ANVESA_HOME: home() };
    const path = usageFile(env) as string;
    const then = Date.UTC(2026, 9, 1);
    const now = Date.UTC(2026, 9, 2);
    writeFileSync(path, JSON.stringify({ query: { score: 10, last: then } }));
    expect(recentCommands(env, now)).toEqual(['query']);
    recordUse(env, 'search', known, {}, now);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored).toMatchObject({ format: 2, half_life_days: 14, counting_since: now });
    expect(stored.commands.query).toMatchObject({ last_used: then, score: 10, runs: 0 });
    expect(stored.commands.query.first_used).toBeUndefined();
    expect(stored.commands.search).toMatchObject({ first_used: now, runs: 1, succeeded: 1 });
  });

  test('a run waits for another writing it, and takes over a lock left behind', () => {
    const env = { ANVESA_HOME: home() };
    const path = usageFile(env) as string;
    const held = `${path}.lock`;
    writeFileSync(held, '');
    // Another run holds it: this one is not counted, rather than writing over that one's count.
    expect(recordUse(env, 'search', known)).toBe(false);
    expect(readUsage(env)?.commands.search).toBeUndefined();
    // A lock from a run that died long ago is stale.
    const old = new Date(Date.now() - 60_000);
    utimesSync(held, old, old);
    expect(recordUse(env, 'search', known)).toBe(true);
    expect(recordUse(env, 'search', known)).toBe(true);
    expect(readUsage(env)?.commands.search?.runs).toBe(2);
  });

  test('a bad value loses only itself', () => {
    const env = { ANVESA_HOME: home() };
    const path = usageFile(env) as string;
    const now = Date.UTC(2026, 9, 2);
    writeFileSync(
      path,
      JSON.stringify({
        format: 2,
        counting_since: now - DAY,
        commands: {
          search: { last_used: now, score: 3, runs: -4, failed: 'x', last_version: '../../x' },
        },
      }),
    );
    const use = readUsage(env, now)?.commands.search;
    expect(use).toMatchObject({ last_used: now, score: 3, runs: 0, failed: 0 });
    expect(use?.last_version).toBeUndefined();
    expect(readUsage(env, now)?.counting_since).toBe(now - DAY);
  });
});
