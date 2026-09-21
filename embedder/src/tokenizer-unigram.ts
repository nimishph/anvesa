import { TokenizerInvalidError } from './errors.ts';
import {
  buildFrame,
  buildNormalizer,
  type Frame,
  type HfComponent,
  type HfTokenizerJson,
  type Normalize,
  padIdOf,
  refuseTextAddedTokens,
  specialTokenIds,
} from './tokenizer-hf.ts';
import type { Tokenizer } from './tokenizer-types.ts';

/** How much worse than the worst real piece an unknown character is scored. */
const UNKNOWN_PENALTY = 10;

export interface UnigramOptions {
  readonly pieces: readonly (readonly [string, number])[];
  /** Ids that a text may never produce, whatever it spells. */
  readonly reserved: ReadonlySet<number>;
  readonly unknownId: number;
  readonly normalize: Normalize;
  /** Splits a normalised text into the parts that are segmented independently. */
  readonly split: (text: string) => readonly string[];
  readonly frame: Frame;
  readonly padId: number;
  readonly source: string;
}

/**
 * The SentencePiece unigram tokenizer: each part of a text is cut into the pieces whose scores add
 * up highest (found exactly, by dynamic programming), and a character no piece covers becomes the
 * unknown token, with runs of them fused into one.
 */
export class UnigramTokenizer implements Tokenizer {
  readonly specialTokens: number;
  readonly padId: number;
  readonly vocabSize: number;
  readonly #options: UnigramOptions;
  readonly #ids = new Map<string, number>();
  readonly #scores = new Map<string, number>();
  /** Longest piece, in characters: no lookup needs to look further. */
  readonly #longest: number;
  readonly #unknownScore: number;

  constructor(options: UnigramOptions) {
    this.#options = options;
    this.padId = options.padId;
    this.vocabSize = options.pieces.length;
    this.specialTokens = options.frame.prefix.length + options.frame.suffix.length;
    let longest = 1;
    let lowest = Number.POSITIVE_INFINITY;
    options.pieces.forEach(([piece, score], id) => {
      if (options.reserved.has(id)) return;
      if (!this.#ids.has(piece)) {
        this.#ids.set(piece, id);
        this.#scores.set(piece, score);
      }
      longest = Math.max(longest, [...piece].length);
      lowest = Math.min(lowest, score);
    });
    this.#longest = longest;
    this.#unknownScore = lowest - UNKNOWN_PENALTY;
  }

  tokenize(text: string): number[] {
    const ids: number[] = [];
    for (const part of this.#options.split(this.#options.normalize(text))) {
      this.#segment([...part], ids);
    }
    return ids;
  }

  count(text: string): number {
    return this.tokenize(text).length;
  }

  encode(text: string): number[] {
    const { prefix, suffix } = this.#options.frame;
    return [...prefix, ...this.tokenize(text), ...suffix];
  }

  #segment(chars: readonly string[], into: number[]): void {
    const n = chars.length;
    if (n === 0) return;
    // best[p]: the best path that ends at p, as its score, where it began and whether it is unknown.
    const score = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY);
    const begin = new Int32Array(n + 1).fill(-1);
    const unknown = new Uint8Array(n + 1);
    score[0] = 0;
    for (let from = 0; from < n; from += 1) {
      const base = score[from] as number;
      if (base === Number.NEGATIVE_INFINITY) continue;
      let single = false;
      let piece = '';
      const limit = Math.min(n, from + this.#longest);
      for (let to = from + 1; to <= limit; to += 1) {
        piece += chars[to - 1];
        const pieceScore = this.#scores.get(piece);
        if (pieceScore === undefined) continue;
        if (to === from + 1) single = true;
        // Strictly better only: among equal paths the one that began earlier stays.
        if (base + pieceScore > (score[to] as number)) {
          score[to] = base + pieceScore;
          begin[to] = from;
          unknown[to] = 0;
        }
      }
      if (!single && base + this.#unknownScore > (score[from + 1] as number)) {
        score[from + 1] = base + this.#unknownScore;
        begin[from + 1] = from;
        unknown[from + 1] = 1;
      }
    }

    // Walk back from the end, fusing consecutive unknowns into one token.
    const reversed: number[] = [];
    let end = n;
    let previousUnknown = false;
    while (end > 0) {
      const from = begin[end] as number;
      if (unknown[end]) {
        if (!previousUnknown) reversed.push(this.#options.unknownId);
        previousUnknown = true;
      } else {
        reversed.push(this.#ids.get(chars.slice(from, end).join('')) as number);
        previousUnknown = false;
      }
      end = from;
    }
    for (let i = reversed.length - 1; i >= 0; i -= 1) into.push(reversed[i] as number);
  }
}

const WHITESPACE_RUN = /\s+/u;

/** Pre-tokenizers that a unigram model is used with: Metaspace, WhitespaceSplit, or both. */
function buildSplit(
  spec: HfComponent | null | undefined,
  source: string,
): (text: string) => readonly string[] {
  if (spec === null || spec === undefined) return (text) => [text];
  if (spec.type === 'Sequence') {
    const steps = ((spec.pretokenizers as HfComponent[]) ?? []).map((part) =>
      buildSplit(part, source),
    );
    return (text) => steps.reduce<readonly string[]>((parts, step) => parts.flatMap(step), [text]);
  }
  if (spec.type === 'WhitespaceSplit') {
    return (text) => text.split(WHITESPACE_RUN).filter((part) => part !== '');
  }
  if (spec.type === 'Metaspace') {
    const replacement = String(spec.replacement ?? '▁');
    const scheme =
      (spec.prepend_scheme as string | undefined) ??
      (spec.add_prefix_space === false ? 'never' : 'always');
    if (!['always', 'first', 'never'].includes(scheme)) {
      throw new TokenizerInvalidError(
        source,
        'pre_tokenizer.prepend_scheme',
        `${scheme} is unknown`,
      );
    }
    const splitting = spec.split !== false;
    return (text) => {
      if (text === '') return [];
      let replaced = text.replaceAll(' ', replacement);
      if (scheme !== 'never' && !replaced.startsWith(replacement)) {
        replaced = replacement + replaced;
      }
      if (!splitting) return [replaced];
      // Each replacement starts a new part, which runs to the next one.
      const parts: string[] = [];
      let current = '';
      for (const char of replaced) {
        if (char === replacement && current !== '') {
          parts.push(current);
          current = '';
        }
        current += char;
      }
      if (current !== '') parts.push(current);
      return parts;
    };
  }
  throw new TokenizerInvalidError(
    source,
    'pre_tokenizer.type',
    `the pre-tokenizer ${spec.type ?? '(unnamed)'} is not supported for a unigram model`,
  );
}

/** The SentencePiece unigram tokenizer a `tokenizer.json` describes. */
export function unigramFromJson(json: HfTokenizerJson, source: string): UnigramTokenizer {
  const model = json.model as HfComponent;
  refuseTextAddedTokens(json, source);
  const pieces = model.vocab as readonly (readonly [string, number])[] | undefined;
  if (!Array.isArray(pieces)) {
    throw new TokenizerInvalidError(source, 'model.vocab', 'a unigram model needs scored pieces');
  }
  if (model.byte_fallback === true) {
    throw new TokenizerInvalidError(
      source,
      'model.byte_fallback',
      'byte fallback is not supported',
    );
  }
  if (typeof model.unk_id !== 'number') {
    throw new TokenizerInvalidError(source, 'model.unk_id', 'it has no unknown token');
  }
  const ids = new Map<string, number>();
  pieces.forEach(([piece], id) => {
    if (!ids.has(piece)) ids.set(piece, id);
  });
  const idOf = (token: string) => ids.get(token);
  return new UnigramTokenizer({
    pieces,
    reserved: specialTokenIds(json),
    unknownId: model.unk_id,
    normalize: buildNormalizer(json.normalizer, source),
    split: buildSplit(json.pre_tokenizer, source),
    frame: buildFrame(json.post_processor, idOf, source),
    padId: padIdOf(json, idOf, source),
    source,
  });
}
