import { Charsmap } from './charsmap.ts';
import { TokenizerInvalidError } from './errors.ts';

/** The parts of a Hugging Face `tokenizer.json` that the tokenizers here read. */
export interface HfTokenizerJson {
  readonly normalizer?: HfComponent | null;
  readonly pre_tokenizer?: HfComponent | null;
  readonly post_processor?: HfComponent | null;
  readonly padding?: { readonly pad_id?: number; readonly pad_token?: string } | null;
  readonly added_tokens?: readonly HfAddedToken[];
  readonly model?: HfComponent;
}

export interface HfComponent {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface HfAddedToken {
  readonly id: number;
  readonly content: string;
  readonly special?: boolean;
  readonly single_word?: boolean;
  readonly lstrip?: boolean;
  readonly rstrip?: boolean;
  /** Matched in the normalized text (true) or the raw text (false). Defaults to `!special`. */
  readonly normalized?: boolean;
}

export function parseHfJson(text: string, source: string): HfTokenizerJson {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      throw new TokenizerInvalidError(source, 'file', 'it is not a JSON object');
    }
    return parsed as HfTokenizerJson;
  } catch (failure) {
    if (failure instanceof TokenizerInvalidError) throw failure;
    throw new TokenizerInvalidError(source, 'file', 'it is not JSON', { cause: failure });
  }
}

/** Compile a pattern written for the Rust `regex` crate, or say why this engine cannot. */
export function compileRegex(pattern: string, flags: string, source: string, at: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (failure) {
    throw new TokenizerInvalidError(
      source,
      at,
      `the pattern ${JSON.stringify(pattern)} cannot be run here`,
      { cause: failure },
    );
  }
}

/** A text-to-text step applied before a text is split into words. */
export type Normalize = (text: string) => string;

const UNICODE_FORMS = new Set(['NFC', 'NFD', 'NFKC', 'NFKD']);

/**
 * The normalisers a `tokenizer.json` names, run in order. Only ones whose behaviour is known
 * exactly are understood; any other is refused by name, because a wrong normalisation changes
 * every count and every vector without any error.
 */
export function buildNormalizer(
  spec: HfComponent | null | undefined,
  source: string,
  at = 'normalizer',
): Normalize {
  if (spec === null || spec === undefined) return (text) => text;
  const type = spec.type ?? '';
  if (type === 'Sequence') {
    const parts = (spec.normalizers as readonly HfComponent[] | undefined) ?? [];
    const steps = parts.map((part, index) => buildNormalizer(part, source, `${at}[${index}]`));
    return (text) => steps.reduce((current, step) => step(current), text);
  }
  if (UNICODE_FORMS.has(type)) return (text) => text.normalize(type as 'NFC');
  if (type === 'Lowercase') return (text) => text.toLowerCase();
  if (type === 'Strip') {
    const left = spec.strip_left !== false;
    const right = spec.strip_right !== false;
    return (text) => {
      let out = text;
      if (left) out = out.trimStart();
      if (right) out = out.trimEnd();
      return out;
    };
  }
  if (type === 'Prepend') {
    const prefix = String(spec.prepend ?? '');
    return (text) => (text === '' ? text : `${prefix}${text}`);
  }
  if (type === 'Append') {
    const suffix = String(spec.append ?? '');
    return (text) => (text === '' ? text : `${text}${suffix}`);
  }
  if (type === 'Replace') {
    const pattern = spec.pattern as { String?: string; Regex?: string } | undefined;
    const content = String(spec.content ?? '');
    if (pattern?.String !== undefined) {
      const literal = pattern.String;
      return (text) => text.split(literal).join(content);
    }
    if (pattern?.Regex !== undefined) {
      const regex = compileRegex(pattern.Regex, 'gu', source, at);
      return (text) => text.replace(regex, () => content);
    }
    throw new TokenizerInvalidError(source, at, 'a Replace normalizer has no pattern');
  }
  if (type === 'Precompiled') {
    const encoded = spec.precompiled_charsmap;
    if (typeof encoded !== 'string') {
      throw new TokenizerInvalidError(source, at, 'a Precompiled normalizer has no charsmap');
    }
    const charsmap = Charsmap.fromBase64(encoded, source);
    return (text) => charsmap.normalize(text);
  }
  throw new TokenizerInvalidError(
    source,
    `${at}.type`,
    `the normalizer ${type === '' ? '(unnamed)' : type} is not supported`,
  );
}

/** The ids the model adds before and after every text. */
export interface Frame {
  readonly prefix: readonly number[];
  readonly suffix: readonly number[];
}

const NO_FRAME: Frame = { prefix: [], suffix: [] };

function pairId(pair: unknown, source: string, at: string): number {
  if (Array.isArray(pair) && typeof pair[1] === 'number') return pair[1];
  throw new TokenizerInvalidError(source, at, 'it does not give the token as [content, id]');
}

/** The special tokens a `post_processor` puts around a single text. */
export function buildFrame(
  spec: HfComponent | null | undefined,
  idOf: (token: string) => number | undefined,
  source: string,
): Frame {
  if (spec === null || spec === undefined) return NO_FRAME;
  const type = spec.type ?? '';
  if (type === 'ByteLevel') return NO_FRAME;
  if (type === 'BertProcessing' || type === 'RobertaProcessing') {
    return {
      prefix: [pairId(spec.cls, source, 'post_processor.cls')],
      suffix: [pairId(spec.sep, source, 'post_processor.sep')],
    };
  }
  if (type === 'TemplateProcessing') {
    const single = spec.single as readonly Record<string, { id?: string }>[] | undefined;
    const special = (spec.special_tokens ?? {}) as Record<string, { ids?: number[] }>;
    if (!single) throw new TokenizerInvalidError(source, 'post_processor', 'it has no template');
    const prefix: number[] = [];
    const suffix: number[] = [];
    let seen = false;
    for (const item of single) {
      if (item.Sequence) {
        seen = true;
        continue;
      }
      const name = item.SpecialToken?.id;
      if (name === undefined) {
        throw new TokenizerInvalidError(source, 'post_processor.single', 'an item is neither');
      }
      const ids = special[name]?.ids ?? [idOf(name) as number];
      if (ids.some((id) => id === undefined)) {
        throw new TokenizerInvalidError(source, 'post_processor', `${name} has no id`);
      }
      (seen ? suffix : prefix).push(...ids);
    }
    return { prefix, suffix };
  }
  throw new TokenizerInvalidError(
    source,
    'post_processor.type',
    `the post-processor ${type === '' ? '(unnamed)' : type} is not supported`,
  );
}

/**
 * Ids of the special tokens the file adds. Text must never produce them: a source file that spells
 * out `</s>` would otherwise be read by the model as the end of its input.
 */
export function specialTokenIds(json: HfTokenizerJson): ReadonlySet<number> {
  return new Set((json.added_tokens ?? []).filter((t) => t.special !== false).map((t) => t.id));
}

/**
 * A run of text between added tokens, still to be split and run through the model, or an added
 * token found in the text. `start` says the run begins the original text (Metaspace "first").
 */
export type Segment = { readonly id: number } | { readonly text: string; readonly start: boolean };

type Piece = { readonly id: number } | { readonly text: string; readonly at: number };

const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/u;

/** The code point that ends just before `index`, or `undefined` at the start. */
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  const pair = index >= 2 && low >= 0xdc00 && low <= 0xdfff;
  return text.slice(pair ? index - 2 : index - 1, index);
}

function charAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  return String.fromCodePoint(text.codePointAt(index) as number);
}

/**
 * Find these tokens in a text as the reference (`AddedVocabulary::find_matches`) does, quirks
 * included: matches are leftmost, longest where several start at the same place, and never
 * overlap each other; `single_word` drops one beside a word character; `lstrip` takes the
 * whitespace before it (not past the last match) and `rstrip` the whitespace after it. A later
 * match inside what `rstrip` took is still emitted, as the reference emits it. Special tokens are
 * in the set so they shadow what they overlap, as there, but are left as text.
 */
function matcherOf(
  tokens: readonly { readonly content: string; readonly token: HfAddedToken }[],
): ((text: string) => Piece[]) | undefined {
  if (!tokens.some(({ token }) => token.special === false)) return undefined;
  const byContent = new Map<string, HfAddedToken>();
  for (const { content, token } of tokens)
    if (!byContent.has(content)) byContent.set(content, token);
  const alternatives = [...byContent.keys()]
    .sort((a, b) => b.length - a.length)
    .map((content) => content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(alternatives.join('|'), 'gu');
  return (text) => {
    const pieces: Piece[] = [];
    let cursor = 0;
    let matched = false;
    for (const match of text.matchAll(pattern)) {
      let start = match.index ?? 0;
      let end = start + match[0].length;
      const token = byContent.get(match[0]) as HfAddedToken;
      if (token.special !== false) continue;
      if (token.single_word) {
        const before = charBefore(text, start);
        const after = charAt(text, end);
        if ((before && WORD.test(before)) || (after && WORD.test(after))) continue;
      }
      if (token.lstrip) {
        let from = start;
        while (from > 0 && SPACE.test(text[from - 1] as string)) from -= 1;
        start = Math.max(from, cursor);
      }
      if (token.rstrip) {
        while (end < text.length && SPACE.test(text[end] as string)) end += 1;
      }
      if (cursor < start) pieces.push({ text: text.slice(cursor, start), at: cursor });
      pieces.push({ id: token.id });
      cursor = end;
      matched = true;
    }
    if (!matched) return [{ text, at: 0 }];
    if (cursor < text.length) pieces.push({ text: text.slice(cursor), at: cursor });
    return pieces;
  };
}

/**
 * Split a text on the file's non-special added tokens, as the reference does before anything
 * else: those with `normalized: false` are found in the raw text, the rest is normalized, and
 * those with `normalized: true` (their own content normalized too) are found in that. Special
 * tokens are never matched: a text that spells one is ordinary text (see `specialTokenIds`).
 */
export function addedTokenSplitter(
  json: HfTokenizerJson,
  normalize: (text: string) => string,
): (text: string) => readonly Segment[] {
  const tokens = (json.added_tokens ?? []).filter((token) => token.content !== '');
  // The reference's default: special tokens are matched raw, ordinary ones normalized.
  const isNormalized = (token: HfAddedToken) => token.normalized ?? token.special === false;
  const raw = matcherOf(
    tokens
      .filter((token) => !isNormalized(token))
      .map((token) => ({ content: token.content, token })),
  );
  const normalizedMatch = matcherOf(
    tokens
      .filter(isNormalized)
      .map((token) => ({ content: normalize(token.content), token }))
      .filter(({ content }) => content !== ''),
  );
  return (text) => {
    const segments: Segment[] = [];
    for (const piece of raw ? raw(text) : [{ text, at: 0 }]) {
      if ('id' in piece) {
        segments.push(piece);
        continue;
      }
      const normalized = normalize(piece.text);
      for (const inner of normalizedMatch
        ? normalizedMatch(normalized)
        : [{ text: normalized, at: 0 }]) {
        segments.push(
          'id' in inner ? inner : { text: inner.text, start: piece.at === 0 && inner.at === 0 },
        );
      }
    }
    return segments;
  };
}

/** Names a pad token goes by, tried in order when the file has no `padding` entry. */
const PAD_NAMES = ['<pad>', '[PAD]', '<|pad|>', '<|padding|>'] as const;

/**
 * The id that pads a batch: the file's own padding entry, else a token named as a pad token, else
 * the one special token the file declares whose name says it pads (ModernBERT's `<|padding|>`).
 * Padded positions are masked out, so any declared pad token is a sound choice; two candidates are
 * refused rather than guessed between.
 */
export function padIdOf(
  json: HfTokenizerJson,
  idOf: (token: string) => number | undefined,
  source: string,
): number {
  if (typeof json.padding?.pad_id === 'number') return json.padding.pad_id;
  for (const name of [json.padding?.pad_token, ...PAD_NAMES]) {
    if (name === undefined) continue;
    const id = idOf(name);
    if (id !== undefined) return id;
  }
  const declared = (json.added_tokens ?? []).filter(
    (token) => token.special !== false && /pad/i.test(token.content),
  );
  if (declared.length === 1) return (declared[0] as { id: number }).id;
  throw new TokenizerInvalidError(
    source,
    'padding',
    declared.length > 1
      ? `it names no padding token, and several special tokens could be one (${declared.map((t) => t.content).join(', ')})`
      : `it names no padding token, and none of ${PAD_NAMES.join(', ')} is in the vocabulary or declared as a special token`,
  );
}
