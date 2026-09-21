import { TokenizerInvalidError } from './errors.ts';
import {
  buildFrame,
  buildNormalizer,
  compileRegex,
  type Frame,
  type HfComponent,
  type HfTokenizerJson,
  type Normalize,
  padIdOf,
  refuseTextAddedTokens,
  specialTokenIds,
} from './tokenizer-hf.ts';
import type { Tokenizer } from './tokenizer-types.ts';

/** GPT-2's map from every byte to a printable character, so a word is a string of characters. */
function byteCharacters(): readonly string[] {
  const kept: number[] = [];
  for (let b = 33; b <= 126; b += 1) kept.push(b);
  for (let b = 161; b <= 172; b += 1) kept.push(b);
  for (let b = 174; b <= 255; b += 1) kept.push(b);
  const table: string[] = new Array<string>(256);
  for (const b of kept) table[b] = String.fromCharCode(b);
  let next = 0;
  for (let b = 0; b < 256; b += 1) {
    if (table[b] === undefined) {
      table[b] = String.fromCharCode(256 + next);
      next += 1;
    }
  }
  return table;
}

const BYTE_CHARACTERS = byteCharacters();
const encoder = new TextEncoder();

/** The pattern the reference byte-level pre-tokenizer splits on when not told another. */
const GPT2_PATTERN = String.raw`'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`;

/** An adjacent pair that could be merged: its rank, where it sits, and what each side was. */
type Pair = readonly [
  rank: number,
  left: number,
  right: number,
  leftText: string,
  rightText: string,
];

export interface BpeOptions {
  readonly vocab: ReadonlyMap<string, number>;
  readonly vocabSize: number;
  /** Merge pairs, best first. */
  readonly merges: readonly (readonly [string, string])[];
  readonly normalize: Normalize;
  /** Splits a text into the pieces that are merged independently. */
  readonly split: (text: string) => readonly string[];
  readonly addPrefixSpace: boolean;
  readonly ignoreMerges: boolean;
  readonly unknown: number | undefined;
  readonly fuseUnknown: boolean;
  readonly frame: Frame;
  readonly padId: number;
  readonly source: string;
}

/**
 * Byte-level BPE, as GPT-2, RoBERTa and most code models use it: the text becomes bytes, the
 * bytes are split into words, and each word is merged pair by pair in the order the merge list
 * ranks them. The order of merging is what the reference does: lowest rank first, leftmost first.
 */
export class ByteLevelBpeTokenizer implements Tokenizer {
  readonly specialTokens: number;
  readonly padId: number;
  readonly vocabSize: number;
  readonly #options: BpeOptions;
  readonly #ranks = new Map<string, number>();

  constructor(options: BpeOptions) {
    this.#options = options;
    this.padId = options.padId;
    this.vocabSize = options.vocabSize;
    this.specialTokens = options.frame.prefix.length + options.frame.suffix.length;
    options.merges.forEach(([left, right], rank) => {
      // A merge whose result is not a token can never be applied.
      if (!options.vocab.has(left + right)) return;
      const key = `${left} ${right}`;
      if (!this.#ranks.has(key)) this.#ranks.set(key, rank);
    });
  }

  tokenize(text: string): number[] {
    const { normalize, split, addPrefixSpace } = this.#options;
    let prepared = normalize(text);
    if (addPrefixSpace && !prepared.startsWith(' ')) prepared = ` ${prepared}`;
    const ids: number[] = [];
    for (const piece of split(prepared)) this.#word(piece, ids);
    return ids;
  }

  count(text: string): number {
    return this.tokenize(text).length;
  }

  encode(text: string): number[] {
    const { prefix, suffix } = this.#options.frame;
    return [...prefix, ...this.tokenize(text), ...suffix];
  }

  #word(piece: string, into: number[]): void {
    if (piece === '') return;
    let mapped = '';
    for (const byte of encoder.encode(piece)) mapped += BYTE_CHARACTERS[byte];
    const { vocab, ignoreMerges, unknown, fuseUnknown } = this.#options;
    if (ignoreMerges) {
      const whole = vocab.get(mapped);
      if (whole !== undefined) {
        into.push(whole);
        return;
      }
    }

    // Symbols in a doubly linked list; the best adjacent pair is taken from a heap. Merging is
    // O(n log n) in the word's length, which matters for a minified line with no spaces in it.
    const symbols: string[] = [...mapped];
    const count = symbols.length;
    const prev = new Int32Array(count);
    const next = new Int32Array(count);
    const alive = new Uint8Array(count).fill(1);
    for (let i = 0; i < count; i += 1) {
      prev[i] = i - 1;
      next[i] = i + 1 < count ? i + 1 : -1;
    }
    const heap: Pair[] = [];
    const push = (left: number, right: number): void => {
      const rank = this.#ranks.get(`${symbols[left]} ${symbols[right]}`);
      if (rank === undefined) return;
      heap.push([rank, left, right, symbols[left] as string, symbols[right] as string]);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this.#before(heap[parent] as Pair, heap[i] as Pair)) break;
        [heap[parent], heap[i]] = [heap[i] as Pair, heap[parent] as Pair];
        i = parent;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0 && last) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let least = i;
          if (l < heap.length && this.#before(heap[l] as Pair, heap[least] as Pair)) least = l;
          if (r < heap.length && this.#before(heap[r] as Pair, heap[least] as Pair)) least = r;
          if (least === i) break;
          [heap[least], heap[i]] = [heap[i] as Pair, heap[least] as Pair];
          i = least;
        }
      }
      return top;
    };
    for (let i = 0; i + 1 < count; i += 1) push(i, i + 1);
    while (heap.length > 0) {
      const top = pop();
      if (!top) break;
      const [, left, right, leftText, rightText] = top;
      // A pair is stale once either side has been merged into something else.
      if (
        !alive[left] ||
        !alive[right] ||
        symbols[left] !== leftText ||
        symbols[right] !== rightText
      ) {
        continue;
      }
      symbols[left] = leftText + rightText;
      alive[right] = 0;
      next[left] = next[right] as number;
      if (next[right] !== -1) prev[next[right] as number] = left;
      if (prev[left] !== -1) push(prev[left] as number, left);
      if (next[left] !== -1) push(left, next[left] as number);
    }

    let previousUnknown = false;
    for (let i = 0; i !== -1; i = next[i] as number) {
      const id = vocab.get(symbols[i] as string);
      if (id !== undefined) {
        into.push(id);
        previousUnknown = false;
      } else if (unknown !== undefined) {
        if (!(fuseUnknown && previousUnknown)) into.push(unknown);
        previousUnknown = true;
      }
    }
  }

  /** Lower rank first; among equal ranks, the pair further left. */
  #before(a: Pair, b: Pair): boolean {
    return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
  }
}

function splitIsolated(regex: RegExp): (text: string) => readonly string[] {
  return (text) => {
    const pieces: string[] = [];
    let last = 0;
    for (const match of text.matchAll(regex)) {
      const at = match.index ?? 0;
      if (match[0] === '') continue;
      if (at > last) pieces.push(text.slice(last, at));
      pieces.push(match[0]);
      last = at + match[0].length;
    }
    if (last < text.length) pieces.push(text.slice(last));
    return pieces;
  };
}

interface ByteLevelSpec {
  readonly add_prefix_space?: boolean;
  readonly use_regex?: boolean;
}

/** The byte-level BPE tokenizer a `tokenizer.json` describes, or the part that is unsupported. */
export function bpeFromJson(json: HfTokenizerJson, source: string): ByteLevelBpeTokenizer {
  const model = json.model as HfComponent;
  refuseTextAddedTokens(json, source);
  for (const field of ['continuing_subword_prefix', 'end_of_word_suffix'] as const) {
    if (typeof model[field] === 'string' && model[field] !== '') {
      throw new TokenizerInvalidError(
        source,
        `model.${field}`,
        'a BPE with word prefixes or suffixes is not supported',
      );
    }
  }
  if (model.byte_fallback === true && model.type === 'BPE') {
    // Byte-level tables already cover every byte; a fallback that adds <0xNN> tokens is another scheme.
    const pre = json.pre_tokenizer?.type;
    if (pre !== 'ByteLevel' && pre !== 'Sequence') {
      throw new TokenizerInvalidError(source, 'model.byte_fallback', 'it is not supported');
    }
  }

  // Pre-tokenizer: `ByteLevel` on its own, or a `Sequence` of a regex `Split` and `ByteLevel`.
  const pre = json.pre_tokenizer;
  let addPrefixSpace = false;
  let pattern: string | undefined;
  const parts: readonly HfComponent[] =
    pre?.type === 'Sequence' ? ((pre.pretokenizers as HfComponent[]) ?? []) : pre ? [pre] : [];
  let sawByteLevel = false;
  for (const part of parts) {
    if (part.type === 'ByteLevel') {
      const spec = part as ByteLevelSpec;
      sawByteLevel = true;
      addPrefixSpace = spec.add_prefix_space === true;
      if (spec.use_regex !== false && pattern === undefined) pattern = GPT2_PATTERN;
    } else if (part.type === 'Split') {
      const spec = part.pattern as { Regex?: string; String?: string } | undefined;
      if (part.behavior !== 'Isolated' || part.invert === true || spec?.Regex === undefined) {
        throw new TokenizerInvalidError(
          source,
          'pre_tokenizer',
          'only a Split on a regex, isolating what matches, is supported',
        );
      }
      pattern = spec.Regex;
    } else {
      throw new TokenizerInvalidError(
        source,
        'pre_tokenizer.type',
        `the pre-tokenizer ${part.type ?? '(unnamed)'} is not supported for BPE`,
      );
    }
  }
  if (!sawByteLevel) {
    throw new TokenizerInvalidError(
      source,
      'pre_tokenizer',
      'only byte-level BPE is supported: the pre-tokenizer must include ByteLevel',
    );
  }
  const split =
    pattern === undefined
      ? (text: string): readonly string[] => [text]
      : splitIsolated(compileRegex(pattern, 'gu', source, 'pre_tokenizer'));

  const vocabRecord = model.vocab as Record<string, number> | undefined;
  const rawMerges = model.merges as readonly (string | readonly [string, string])[] | undefined;
  if (!vocabRecord || !rawMerges) {
    throw new TokenizerInvalidError(source, 'model', 'a BPE needs a vocabulary and merges');
  }
  const reserved = specialTokenIds(json);
  const everything = new Map(Object.entries(vocabRecord));
  // Special tokens stay out of what text can reach, so a text that spells one gets ordinary pieces.
  const vocab = new Map([...everything].filter(([, id]) => !reserved.has(id)));
  const merges = rawMerges.map((merge): readonly [string, string] => {
    if (typeof merge === 'string') {
      const at = merge.indexOf(' ');
      return [merge.slice(0, at), merge.slice(at + 1)];
    }
    return [merge[0], merge[1]];
  });
  const unknownName = model.unk_token as string | null | undefined;
  const idOf = (token: string) => everything.get(token);
  return new ByteLevelBpeTokenizer({
    vocab,
    vocabSize: everything.size,
    merges,
    normalize: buildNormalizer(json.normalizer, source),
    split,
    addPrefixSpace,
    ignoreMerges: model.ignore_merges === true,
    unknown: unknownName ? idOf(unknownName) : undefined,
    fuseUnknown: model.fuse_unk === true,
    frame: buildFrame(json.post_processor, idOf, source),
    padId: padIdOf(json, idOf, source),
    source,
  });
}
