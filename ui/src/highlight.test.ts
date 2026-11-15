import { describe, expect, test } from 'bun:test';
// @ts-expect-error: the dashboard's browser script has no type declarations
import { highlightLine } from '../public/js/search.js';

const highlight = highlightLine as (line: string) => string;

/** The text a reader sees: tags dropped, entities decoded. */
const visible = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

describe('result card highlighting (#48)', () => {
  const lines = [
    'export async function search(query: string): Promise<Result> {',
    'const label = "a <b> & \\"c\\""; // class="x"',
    "if (s === 'it\\'s') return render(`<span class=\"hl-fn\">${x}</span>`);",
    'class Foo extends Bar<T> {}',
  ];

  test.each(lines)('shows %p exactly as written, with no markup as text', (line) => {
    const html = highlight(line);
    // What the reader sees is the line, character for character: no `hl-keyword">` leaks in.
    expect(visible(html)).toBe(line);
  });

  test('keywords, strings, calls and comments get one span each', () => {
    expect(highlight('export const x = f("y"); // z')).toBe(
      '<span class="hl-keyword">export</span> <span class="hl-keyword">const</span> x = <span class="hl-fn">f</span>(<span class="hl-string">&quot;y&quot;</span>); <span class="hl-comment">// z</span>',
    );
  });
});
