import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recentCommands, recordUse, usageFile } from './usage.ts';

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
    expect(Object.keys(stored)).toEqual(['search']);

    const off = { ANVESA_HOME: home(), ANVESA_NO_USAGE: '1' };
    expect(recordUse(off, 'search', known)).toBe(false);
    expect(recentCommands(off)).toEqual([]);
  });

  test('what is used now outranks what was used a lot long ago; what went quiet drops off', () => {
    const env = { ANVESA_HOME: home() };
    const now = Date.UTC(2026, 9, 9);
    for (let i = 0; i < 10; i += 1) recordUse(env, 'index', known, now - 60 * DAY);
    recordUse(env, 'search', known, now - DAY);
    recordUse(env, 'search', known, now);
    recordUse(env, 'status', known, now - 120 * DAY);
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
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toEqual(['search']);
  });
});
