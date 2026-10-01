import { describe, expect, it } from 'bun:test';
import type { SearchPage, SearchResult } from '@cntxt-labs/anvesa-retriever';
import { extractDocSummary, jumpLink, renderSearch, renderStructural, scoreBar } from './render.ts';

const sampleHit: SearchResult = {
  key: 'src/config.ts:45',
  title: 'parseConfig',
  path: 'src/config.ts',
  line: 45,
  endLine: 80,
  kind: 'function',
  foundBy: [
    { lane: 'dense', rank: 1, weight: 1, score: 0.89 },
    { lane: 'structural', rank: 2, weight: 1, score: 0.5 },
  ],
  score: 0.89,
  bestScore: 0.842,
  card: {
    id: 'test-fn-1',
    channel: 'code',
    categoryId: '1',
    categoryLabel: 'code',
    source: {
      path: 'src/config.ts',
      contentHash: 'hash-abc',
      span: { startLine: 45, endLine: 80 },
    },
    attrs: {
      symbol: 'parseConfig',
      kind: 'function',
      signature: '(path: string) => Promise<Config>',
    },
    provenance: {
      trust: 'untrusted',
      transformer: 'ast',
      transformerVersion: '1.0.0',
    },
    text: `/**
 * Read and validate .anvesa/config.json.
 * @param path Path to config file.
 */
export async function parseConfig(path: string): Promise<Config> {
  return {};
}`,
  },
};

const samplePage: SearchPage = {
  items: [sampleHit],
  depth: 1,
  limit: { name: 'limit', applied: 20, source: 'default', reached: false },
  nextCursor: null,
  total: 1,
  lanes: [
    { name: 'dense', hits: 1 },
    { name: 'structural', hits: 1 },
  ],
  degraded: [],
};

describe('Multi-Mode Results Formatting (anv-80l)', () => {
  it('extractDocSummary extracts single-line docstring from JSDoc, Python, and comments', () => {
    expect(extractDocSummary('/**\n * First line of docs.\n * Second line.\n */')).toBe(
      'First line of docs.',
    );
    expect(extractDocSummary('"""Single line python summary."""')).toBe(
      'Single line python summary.',
    );
    expect(extractDocSummary('// Helper function for search.')).toBe('Helper function for search.');
    expect(extractDocSummary(undefined)).toBeUndefined();
  });

  it('scoreBar renders accurate visual confidence bars', () => {
    expect(scoreBar(0.0)).toBe('[░░░░░░░░░░] 0.000');
    expect(scoreBar(0.5)).toBe('[█████░░░░░] 0.500');
    expect(scoreBar(0.842)).toBe('[████████░░] 0.842');
    expect(scoreBar(1.0)).toBe('[██████████] 1.000');
    expect(scoreBar(undefined)).toBe('');
  });

  it('jumpLink generates editor-clickable path:line:col locations', () => {
    expect(jumpLink({ path: 'src/config.ts', line: 45, endLine: 80 })).toBe('src/config.ts:45:1');
    expect(jumpLink({ path: 'README.md' })).toBe('README.md:1:1');
  });

  it('renderSearch in compact mode omits raw card text and includes docstring summary', () => {
    const compact = renderSearch(samplePage, { mode: 'compact', full: false });
    expect(compact).toContain('1. parseConfig (function)  src/config.ts:45-80');
    expect(compact).toContain('// Read and validate .anvesa/config.json.');
    expect(compact).not.toContain('export async function parseConfig');
    expect(compact).not.toContain('<<<UNTRUSTED');
    expect(compact).toContain('lanes: dense 1, structural 1');
  });

  it('renderSearch in compact mode with full: true includes fenced card body', () => {
    const fullCompact = renderSearch(samplePage, { mode: 'compact', full: true });
    expect(fullCompact).toContain('1. parseConfig (function)');
    expect(fullCompact).toContain('// Read and validate .anvesa/config.json.');
    expect(fullCompact).toContain('<<<untrusted');
    expect(fullCompact).toContain('export async function parseConfig');
  });

  it('renderSearch in locations mode outputs quickfix lines for fzf/editors', () => {
    const locations = renderSearch(samplePage, { mode: 'locations' });
    expect(locations.trim()).toBe(
      'src/config.ts:45:1: function parseConfig [dense#1 structural#2]',
    );
  });

  it('renderSearch in pretty mode includes score confidence bar and fenced body', () => {
    const pretty = renderSearch(samplePage, { mode: 'pretty', isTTY: false });
    expect(pretty).toContain('1. parseConfig (function)');
    expect(pretty).toContain('best 0.842');
    expect(pretty).toContain('[████████░░] 0.842');
    expect(pretty).toContain('<<<untrusted');
  });

  it('renderSearch in json mode returns strictly typed JSON', () => {
    const jsonStr = renderSearch(samplePage, { mode: 'json' });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].title).toBe('parseConfig');
  });

  it('renderStructural supports compact and locations formatting', () => {
    const structuralPage = {
      items: [
        {
          path: 'src/config.ts',
          tag: 'function',
          name: 'parseConfig',
          startLine: 45,
          endLine: 80,
          signature: '(path: string) => Promise<Config>',
          score: 0.91,
        },
      ],
      coverage: { files: 1, missing: [] },
      limit: { name: 'limit', applied: 20, source: 'default' as const, reached: false },
      nextCursor: null,
      total: 1,
    };

    const compact = renderStructural(structuralPage, { mode: 'compact' });
    expect(compact).toContain('1. function parseConfig  src/config.ts:45-80');
    expect(compact).toContain('score 0.910');

    const locations = renderStructural(structuralPage, { mode: 'locations' });
    expect(locations.trim()).toBe('src/config.ts:45:1: function parseConfig');
  });
});
