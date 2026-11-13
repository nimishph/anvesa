import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SCHEMA_URL } from './config.ts';
import { editConfigFile, readConfigFile } from './config-edit.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'anvesa-config-edit-'));
  roots.push(root);
  if (config !== undefined) {
    mkdirSync(join(root, '.anvesa'), { recursive: true });
    writeFileSync(join(root, '.anvesa', 'config.json'), config);
  }
  return root;
}

const fileOf = (root: string) => readFileSync(join(root, '.anvesa', 'config.json'), 'utf8');

describe('editing .anvesa/config.json from the dashboard', () => {
  test('changes only the keys edited, keeps the rest, its order, indentation and line endings', () => {
    const original = [
      '{',
      '    "model": "anvesa-code-150m",',
      '    "search": { "defaultLimit": 7 },',
      '    "channels": { "docs": { "weight": 0.5 } }',
      '}',
      '',
    ].join('\r\n');
    const root = project(original);
    const read = readConfigFile(root);
    const result = editConfigFile(root, read.revision, {
      channels: { docs: { weight: 1 }, symbols: { enabled: false } },
      fusionK: 40,
    });
    const text = fileOf(root);
    expect(text.includes('\r\n')).toBe(true);
    expect(text.startsWith(`{\r\n    "$schema": "${CONFIG_SCHEMA_URL}"`)).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      '$schema',
      'model',
      'search',
      'channels',
      'fusion',
    ]);
    expect(JSON.parse(text)).toMatchObject({
      model: 'anvesa-code-150m',
      search: { defaultLimit: 7 },
      // A weight of 1 is the default, so it is left out, as `anvesa channel` writes it.
      channels: { docs: {}, symbols: { enabled: false } },
      fusion: { k: 40 },
    });
    expect([...result.changed].sort()).toEqual([
      'channels.docs.weight',
      'channels.symbols.enabled',
      'fusion.k',
    ]);
    expect(result.reindex).toEqual(['channels.symbols.enabled']);
  });

  test('says which changes need a reindex, and null puts a setting back to its default', () => {
    const root = project('{ "model": "anvesa-code-150m", "fusion": { "k": 30 } }');
    const first = editConfigFile(root, readConfigFile(root).revision, {
      model: 'gte-modernbert-base',
      ignore: ['dist/**', '  ', 'vendor/**'],
      telemetry: { show_notice: false },
    });
    expect([...first.reindex].sort()).toEqual(['indexing.ignore', 'model']);
    expect(first.raw).toMatchObject({
      indexing: { ignore: ['dist/**', 'vendor/**'] },
      telemetry: { show_notice: false },
    });
    const second = editConfigFile(root, first.revision, {
      model: null,
      fusionK: null,
      ignore: [],
      telemetry: { show_notice: true },
    });
    expect(JSON.parse(fileOf(root))).toEqual({ $schema: CONFIG_SCHEMA_URL });
    expect(second.reindex).toContain('model');
  });

  test('a project with no config file gets one', () => {
    const root = project();
    const read = readConfigFile(root);
    expect(read.exists).toBe(false);
    editConfigFile(root, read.revision, { telemetry: { enabled: false } });
    expect(JSON.parse(fileOf(root))).toEqual({
      $schema: CONFIG_SCHEMA_URL,
      telemetry: { enabled: false },
    });
  });

  test('refuses an edit to a file that changed since it was read, and writes nothing', () => {
    const root = project('{ "model": "anvesa-code-150m" }');
    const stale = readConfigFile(root).revision;
    writeFileSync(join(root, '.anvesa', 'config.json'), '{ "model": "anvesa-code-400m" }');
    expect(() => editConfigFile(root, stale, { fusionK: 10 })).toThrow(/changed since it was read/);
    expect(fileOf(root)).toBe('{ "model": "anvesa-code-400m" }');
  });

  test('refuses what would not load, and a channel the project does not have', () => {
    const root = project('{}');
    const { revision } = readConfigFile(root);
    expect(() => editConfigFile(root, revision, { fusionK: -1 })).toThrow(/fusion/);
    expect(() => editConfigFile(root, revision, { channels: { notes: { weight: 2 } } })).toThrow(
      /channel add/,
    );
    expect(fileOf(root)).toBe('{}');
  });

  test('refuses while another process holds the lock', () => {
    const root = project('{}');
    const { revision } = readConfigFile(root);
    writeFileSync(join(root, '.anvesa', 'config.json.lock'), '');
    expect(() => editConfigFile(root, revision, { fusionK: 10 })).toThrow(/another anvesa process/);
  });
});
