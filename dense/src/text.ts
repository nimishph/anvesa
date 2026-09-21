/**
 * Text helpers shared by card-building transformers. Pure and synchronous.
 *
 * The aim throughout is the same: turn code-shaped text into something an English-trained encoder
 * can use. `resolveGrants` is one opaque token to such an encoder; `resolve grants` is two
 * meaningful words.
 */

/**
 * Split an identifier into lowercase words.
 *
 * Handles camelCase, PascalCase, snake_case, SCREAMING_SNAKE, kebab-case, namespace separators
 * and acronym runs: `parseHTTPResponse` -> `parse http response`.
 */
export function decomposeIdentifier(identifier: string): string[] {
  return identifier
    .replace(/(::|->|[_\-.\\#/]+)/g, ' ')
    .replace(/[$@%&?!]+/g, ' ')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/** Module context from a path: `services/pipeline/controller.ts` -> `services pipeline controller`. */
export function decomposePath(path: string): string[] {
  return path
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .flatMap(decomposeIdentifier);
}

const DOC_LEADING = /^(\/\*+|\*+\/|\*|\/\/+|#+|"""|'''|--\[\[|--+|=begin|=end|<!--|-->|\{-|-\})\s?/;
const DOC_TRAILING = /\s?(\*+\/|"""|'''|\]\]|-->|-\}|=end)$/;
const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const DOC_TAGS =
  /@(param|returns?|throws|exception|example|remarks|typeParam|defaultValue|var|type|deprecated)\b|^:(param|returns?|rtype|raises)\b|\b(Args|Arguments|Returns|Raises|Yields|Attributes|Parameters|Examples?|Note)s?:/g;

/**
 * Strip comment syntax and collapse whitespace, keeping the prose.
 *
 * Tagged prose (`@param registry the grantor's set`) is kept and only the marker goes, because a
 * marker on every symbol dilutes every vector equally. Fenced code is removed: a card describes
 * what a symbol is for, and pasted code would smuggle the raw body back in.
 */
export function normalizeDoc(doc: string): string {
  return doc
    .replace(FENCED_CODE, ' ')
    .split(/\r?\n/)
    .map(stripMarkers)
    .join(' ')
    .replace(/\{@\w+\s+([^}]*)\}/g, '$1')
    .replace(DOC_TAGS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkers(line: string): string {
  let text = line.trim();
  let previous: string;
  do {
    previous = text;
    text = text.replace(DOC_LEADING, '').replace(DOC_TRAILING, '').trim();
  } while (text !== previous);
  return text;
}

/** Sentences of prose, in order, with their terminal punctuation. Never drops text. */
export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(`])/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
