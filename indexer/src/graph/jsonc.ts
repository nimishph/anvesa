import { ManifestInvalidError } from '../errors.ts';

/**
 * Parse JSON with comments and trailing commas, the dialect `tsconfig.json` is written in.
 *
 * Comments and commas are removed by a scan that knows about strings, so a `//` inside a string
 * (`"https://..."`) is left alone. The result is then parsed as strict JSON, so anything else that
 * is wrong still fails, with the file named.
 */
export function parseJsonc(text: string, path: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(stripComments(text)));
  } catch (failure) {
    throw new ManifestInvalidError(path, 'JSON with comments', 'it is not valid JSON', {
      cause: failure,
    });
  }
}

function stripComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text.charAt(index) !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      out += ' ';
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** Index just past the closing quote of the string that starts at `start`. */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') index += 2;
    else if (char === '"') return index + 1;
    else index += 1;
  }
  return text.length;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === ',') {
      let ahead = index + 1;
      while (/\s/.test(text.charAt(ahead))) ahead += 1;
      const following = text.charAt(ahead);
      if (following !== '}' && following !== ']') out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}
