import { describe, expect, test } from 'bun:test';
import { documentQueries } from './retrieval.ts';

const doc = (path: string, ...paragraphs: string[]) => ({
  path,
  content: paragraphs.join('\n\n'),
});

describe('queries from documentation', () => {
  test('the first sentence of the first plain paragraph is the question, and the file is the answer', () => {
    const queries = documentQueries(
      [
        doc(
          'docs/setup.md',
          '# Setup',
          'Run the installer to set the service up on a new machine. Then restart it.',
          'A second paragraph is not used.',
        ),
      ],
      3,
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      population: 'doc',
      text: 'Run the installer to set the service up on a new machine',
    });
    expect([...(queries[0]?.relevant ?? [])]).toEqual(['docs/setup.md']);
  });

  test('headings, code, tables and markup are skipped, markdown noise is stripped, and short ones are not asked', () => {
    const queries = documentQueries(
      [
        doc('a.md', '# Title', '```sh\nbun install\n```', '| a | b |\n|---|---|', 'Too short.'),
        doc(
          'b.md',
          '<div>html</div>',
          'See the `parseConfig` [guide](x.md) for **details** about settings.',
        ),
        doc('test/c.md', 'A perfectly long sentence that would be a fine question to ask.'),
      ],
      3,
    );
    expect(queries.map((q) => q.symbol)).toEqual(['b.md']);
    expect(queries[0]?.text).toBe('See the parseConfig guidex.md for details about settings');
  });
});
