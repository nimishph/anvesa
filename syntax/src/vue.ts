/**
 * Extract script blocks from a Vue Single File Component (SFC) while preserving
 * exact character offsets, line numbers, and column positions for tree-sitter.
 */

function findOpeningTagEnd(text: string, startIndex: number): number {
  let inDouble = false;
  let inSingle = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '>' && !inDouble && !inSingle) {
      return i;
    }
  }
  return -1;
}

/**
 * Extracts script content from a Vue SFC.
 * All non-script regions (templates, styles, HTML tags) are replaced with whitespace,
 * maintaining identical byte length, newlines, and character offsets so that syntax
 * node positions map 1:1 to the original .vue file.
 */
export function extractVueScript(source: string): string {
  if (/<script\b/i.test(source)) {
    const matches: { contentStart: number; contentEnd: number }[] = [];
    const scriptOpenRegex = /<script\b/gi;

    while (true) {
      const openMatch = scriptOpenRegex.exec(source);
      if (openMatch === null) break;
      const tagStart = openMatch.index;
      const tagEnd = findOpeningTagEnd(source, tagStart);
      if (tagEnd === -1) break;
      const contentStart = tagEnd + 1;
      const closeIndex = source.indexOf('</script>', contentStart);
      if (closeIndex === -1) {
        matches.push({ contentStart, contentEnd: source.length });
        break;
      }
      matches.push({ contentStart, contentEnd: closeIndex });
      scriptOpenRegex.lastIndex = closeIndex + 9; // length of </script>
    }

    if (matches.length === 0) {
      return source.replace(/[^\r\n]/g, ' ');
    }

    let out = '';
    let cursor = 0;
    for (const m of matches) {
      const before = source.slice(cursor, m.contentStart);
      out += before.replace(/[^\r\n]/g, ' ');
      out += source.slice(m.contentStart, m.contentEnd);
      cursor = m.contentEnd;
    }
    const remaining = source.slice(cursor);
    out += remaining.replace(/[^\r\n]/g, ' ');
    return out;
  }

  // Template-only or style-only Vue component: blank out non-newlines
  if (/<template\b|<style\b/i.test(source)) {
    return source.replace(/[^\r\n]/g, ' ');
  }

  // Raw script snippet without SFC tags (e.g. in test assertions)
  return source;
}
