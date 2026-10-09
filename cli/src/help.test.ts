import { describe, expect, test } from 'bun:test';
import { HELP, helpFor, renderHelp } from './cli.ts';
import { COMMANDS } from './commands.ts';
import { COMMAND_HELP, SECTIONS } from './help.ts';

/** Commands cli.ts routes itself, beside the COMMANDS table. */
const ROUTED = ['channel', 'model', 'grammar', 'mapping', 'fragments', 'redteam', 'pattern', 'mcp'];

describe('help', () => {
  test('every command the CLI runs has an entry, in a section, under one key', () => {
    const keys = COMMAND_HELP.flatMap((entry) => entry.keys);
    for (const command of [...Object.keys(COMMANDS), ...ROUTED]) expect(keys).toContain(command);
    expect(new Set(keys).size).toBe(keys.length);
    for (const section of SECTIONS) {
      expect(COMMAND_HELP.some((entry) => entry.section === section)).toBe(true);
    }
  });

  test('the overview lists every command once per section, in the sections’ order', () => {
    const at = SECTIONS.map((section) => HELP.indexOf(`\n${section}\n`));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const entry of COMMAND_HELP) expect(HELP).toContain(`  ${entry.name}  `);
    expect(HELP).not.toContain('Recently used');
  });

  test('recent commands come first, once each, and names that are not commands are ignored', () => {
    const help = renderHelp(['search', 'callers', 'neighbors', 'nonsense']);
    const recent = help.slice(help.indexOf('Recently used'), help.indexOf('\nGet started'));
    expect(recent.split('\n').filter((line) => line.startsWith('  '))).toHaveLength(2);
    expect(recent).toContain('search <question>');
    expect(recent).toContain('callers|callees|neighbors <symbol>');
    expect(help.indexOf('Recently used')).toBeLessThan(help.indexOf('Get started'));
  });

  test('the recent block is limited after merging, so names sharing a line take one slot', () => {
    const recentNames = [
      'callers',
      'callees',
      'neighbors',
      'search',
      'index',
      'status',
      'diagnose',
    ];
    const help = renderHelp([...recentNames, 'query']);
    const recent = help.slice(help.indexOf('Recently used'), help.indexOf('\nGet started'));
    const lines = recent.split('\n').filter((line) => line.startsWith('  '));
    expect(lines).toHaveLength(5);
    expect(recent).toContain('callers|callees|neighbors <symbol>');
    expect(recent).toContain('  status');
    expect(recent).toContain('  diagnose');
    expect(recent).not.toContain('  query');
  });

  test('one command’s help is that command in full; an unknown one is the overview', () => {
    expect(helpFor('mapping')).toContain('--min-samples N, default 10');
    expect(helpFor('neighbors')).toContain('callers|callees|neighbors <symbol>');
    expect(helpFor('nonsense')).toBe(HELP);
  });
});
