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

/** Added tokens that appear in text as themselves would need matching before splitting. */
export function refuseTextAddedTokens(json: HfTokenizerJson, source: string): void {
  for (const token of json.added_tokens ?? []) {
    if (token.special === false || token.single_word === true || token.rstrip === true) {
      throw new TokenizerInvalidError(
        source,
        'added_tokens',
        `the added token ${JSON.stringify(token.content)} is matched inside text, which is not supported`,
      );
    }
  }
}

/** The id that pads a batch: the file's own padding entry, else a token named as a pad token. */
export function padIdOf(
  json: HfTokenizerJson,
  idOf: (token: string) => number | undefined,
  source: string,
): number {
  if (typeof json.padding?.pad_id === 'number') return json.padding.pad_id;
  for (const name of [json.padding?.pad_token, '<pad>', '[PAD]', '<|pad|>']) {
    if (name === undefined) continue;
    const id = idOf(name);
    if (id !== undefined) return id;
  }
  throw new TokenizerInvalidError(
    source,
    'padding',
    'it names no padding token, and none of <pad>, [PAD] is in the vocabulary',
  );
}
