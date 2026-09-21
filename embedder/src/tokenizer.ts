import { TokenizerInvalidError } from './errors.ts';
import { bpeFromJson } from './tokenizer-bpe.ts';
import { type HfTokenizerJson, parseHfJson } from './tokenizer-hf.ts';
import type { Tokenizer } from './tokenizer-types.ts';
import { unigramFromJson } from './tokenizer-unigram.ts';

export type { Tokenizer } from './tokenizer-types.ts';

export interface WordPieceOptions {
  readonly vocab: ReadonlyMap<string, number>;
  readonly unknown: string;
  readonly cls: string;
  readonly sep: string;
  readonly pad: string;
  readonly subwordPrefix: string;
  /** A word longer than this is one unknown token, as in the reference implementation. */
  readonly maxCharsPerWord: number;
  readonly lowercase: boolean;
  /** Remove accents. `undefined` follows `lowercase`, which is what BERT tokenizers do. */
  readonly stripAccents: boolean | undefined;
  readonly cleanText: boolean;
  readonly spaceOutCjk: boolean;
  /** Where the vocabulary came from, for error messages. */
  readonly source: string;
}

const COMBINING_MARK = /\p{Mn}/u;
const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}!-/:-@[-`{-~]/u;

/** Ideographs that BERT surrounds with spaces so each becomes its own word. */
function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  );
}

function isControl(char: string): boolean {
  if (char === '\t' || char === '\n' || char === '\r') return false;
  return /\p{Cc}|\p{Cf}/u.test(char);
}

/**
 * The BERT WordPiece tokenizer: clean and normalise the text, split it into words and
 * punctuation, then break each word into the longest pieces the vocabulary has.
 *
 * Literal `[CLS]`-like text in the input is ordinary text, not a special token: a source file that
 * contains the characters `[SEP]` must not be able to change how its card is read.
 */
export class WordPieceTokenizer implements Tokenizer {
  readonly specialTokens = 2;
  readonly padId: number;
  readonly vocabSize: number;
  readonly #options: WordPieceOptions;
  readonly #cls: number;
  readonly #sep: number;
  readonly #unknown: number;

  constructor(options: WordPieceOptions) {
    this.#options = options;
    const id = (token: string, role: string): number => {
      const found = options.vocab.get(token);
      if (found === undefined) {
        throw new TokenizerInvalidError(
          options.source,
          'vocab',
          `it has no ${role} token "${token}"`,
        );
      }
      return found;
    };
    this.#cls = id(options.cls, 'classification');
    this.#sep = id(options.sep, 'separator');
    this.#unknown = id(options.unknown, 'unknown');
    this.padId = id(options.pad, 'padding');
    this.vocabSize = options.vocab.size;
  }

  tokenize(text: string): number[] {
    const ids: number[] = [];
    for (const word of this.#words(text)) this.#pieces(word, ids);
    return ids;
  }

  count(text: string): number {
    return this.tokenize(text).length;
  }

  encode(text: string): number[] {
    return [this.#cls, ...this.tokenize(text), this.#sep];
  }

  /** Normalise, then split on whitespace and around every punctuation mark. */
  *#words(text: string): Generator<string[]> {
    const { lowercase, cleanText, spaceOutCjk } = this.#options;
    const strip = this.#options.stripAccents ?? lowercase;

    let cleaned = '';
    for (const char of text) {
      if (cleanText) {
        if (char === '\u0000' || char === '�' || isControl(char)) continue;
        if (WHITESPACE.test(char)) {
          cleaned += ' ';
          continue;
        }
      }
      const code = char.codePointAt(0) as number;
      cleaned += spaceOutCjk && isCjk(code) ? ` ${char} ` : char;
    }
    if (strip)
      cleaned = [...cleaned.normalize('NFD')].filter((c) => !COMBINING_MARK.test(c)).join('');
    if (lowercase) cleaned = cleaned.toLowerCase();

    let word: string[] = [];
    for (const char of cleaned) {
      if (WHITESPACE.test(char)) {
        if (word.length > 0) yield word;
        word = [];
      } else if (PUNCTUATION.test(char)) {
        if (word.length > 0) yield word;
        word = [];
        yield [char];
      } else {
        word.push(char);
      }
    }
    if (word.length > 0) yield word;
  }

  /** Longest-match-first pieces of one word. A word with a stretch no piece covers is unknown. */
  #pieces(word: readonly string[], into: number[]): void {
    const { vocab, subwordPrefix, maxCharsPerWord } = this.#options;
    if (word.length > maxCharsPerWord) {
      into.push(this.#unknown);
      return;
    }
    const found: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let match: number | undefined;
      while (end > start) {
        const piece = word.slice(start, end).join('');
        match = vocab.get(start === 0 ? piece : `${subwordPrefix}${piece}`);
        if (match !== undefined) break;
        end -= 1;
      }
      if (match === undefined) {
        into.push(this.#unknown);
        return;
      }
      found.push(match);
      start = end;
    }
    into.push(...found);
  }
}

// --- loading ---------------------------------------------------------------------------------

interface HfNormalizer {
  type?: string;
  clean_text?: boolean;
  handle_chinese_chars?: boolean;
  strip_accents?: boolean | null;
  lowercase?: boolean;
}

/**
 * A tokenizer from a Hugging Face `tokenizer.json`: WordPiece (BERT and its relatives), byte-level
 * BPE (RoBERTa and most code models), or SentencePiece unigram (XLM-R and E5). Only what each
 * reads is understood; a file that asks for anything else (another model type, a normaliser or
 * pre-tokenizer it does not know) is refused with the part that is unsupported, because guessing
 * would make every count and every vector wrong.
 */
export function tokenizerFromJson(text: string, source: string): Tokenizer {
  const json = parseHfJson(text, source);
  const model = json.model;
  if (!model) throw new TokenizerInvalidError(source, 'model', 'it has no model');
  // Older files leave the type out of a BPE model.
  const type = model.type ?? (model.merges ? 'BPE' : undefined);
  if (type === 'BPE') return bpeFromJson(json, source);
  if (type === 'Unigram') return unigramFromJson(json, source);
  if (type === 'WordPiece') return wordPieceFromJson(json, source);
  throw new TokenizerInvalidError(
    source,
    'model.type',
    `only WordPiece, BPE and Unigram are supported, this is ${type ?? 'missing'}`,
  );
}

function wordPieceFromJson(json: HfTokenizerJson, source: string): WordPieceTokenizer {
  const model = json.model as {
    vocab?: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
  const normalizer = json.normalizer as HfNormalizer | null | undefined;
  if (normalizer && normalizer.type !== 'BertNormalizer') {
    throw new TokenizerInvalidError(
      source,
      'normalizer.type',
      `only BertNormalizer is supported, this is ${normalizer.type ?? 'unnamed'}`,
    );
  }
  const preTokenizer = json.pre_tokenizer;
  if (preTokenizer && preTokenizer.type !== 'BertPreTokenizer') {
    throw new TokenizerInvalidError(
      source,
      'pre_tokenizer.type',
      `only BertPreTokenizer is supported, this is ${preTokenizer.type ?? 'unnamed'}`,
    );
  }
  if (!model.vocab || typeof model.vocab !== 'object') {
    throw new TokenizerInvalidError(source, 'model.vocab', 'it has no vocabulary');
  }

  return new WordPieceTokenizer({
    vocab: new Map(Object.entries(model.vocab)),
    unknown: model.unk_token ?? '[UNK]',
    cls: '[CLS]',
    sep: '[SEP]',
    pad: '[PAD]',
    subwordPrefix: model.continuing_subword_prefix ?? '##',
    maxCharsPerWord: model.max_input_chars_per_word ?? 100,
    lowercase: normalizer?.lowercase ?? true,
    stripAccents: normalizer?.strip_accents ?? undefined,
    cleanText: normalizer?.clean_text ?? true,
    spaceOutCjk: normalizer?.handle_chinese_chars ?? true,
    source,
  });
}

/** A tokenizer from a `vocab.txt` (one token per line, its line number is its id). */
export function tokenizerFromVocabulary(
  text: string,
  source: string,
  options: { readonly lowercase: boolean },
): WordPieceTokenizer {
  const vocab = new Map<string, number>();
  text
    .split(/\r?\n/)
    .filter((line, index, lines) => line !== '' || index < lines.length - 1)
    .forEach((token, id) => {
      if (!vocab.has(token)) vocab.set(token, id);
    });
  return new WordPieceTokenizer({
    vocab,
    unknown: '[UNK]',
    cls: '[CLS]',
    sep: '[SEP]',
    pad: '[PAD]',
    subwordPrefix: '##',
    maxCharsPerWord: 100,
    lowercase: options.lowercase,
    stripAccents: undefined,
    cleanText: true,
    spaceOutCjk: true,
    source,
  });
}
