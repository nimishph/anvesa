import { InvalidArgumentError } from '@cntxt-labs/code-lens-core';
import { splitSentences } from './text.ts';

/**
 * How much text one card may hold, taken from the encoder that will read it.
 *
 * A card that overflows the encoder's window is silently truncated by the encoder, losing whatever
 * comes last. So nothing here cuts text to fit: what does not fit is carried into further cards.
 */
export interface TokenBudget {
  /** Largest number of tokens a card's text may occupy. */
  readonly maxTokens: number;
  /** Tokens `text` occupies, by the same tokenizer the encoder uses. */
  count(text: string): number;
}

export interface BudgetSource {
  /** The encoder's input window. */
  readonly maxTokens: number;
  /** Tokens the encoder adds around the text itself (`[CLS]`, `[SEP]`). Defaults to 2. */
  readonly specialTokens?: number;
  count(text: string): number;
}

const DEFAULT_SPECIAL_TOKENS = 2;

/** The budget for cards read by `encoder`: its window less the tokens it adds itself. */
export function budgetFor(encoder: BudgetSource): TokenBudget {
  const special = encoder.specialTokens ?? DEFAULT_SPECIAL_TOKENS;
  const maxTokens = encoder.maxTokens - special;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new InvalidArgumentError(
      'encoder.maxTokens',
      `a window larger than its ${special} special tokens`,
      encoder.maxTokens,
    );
  }
  return { maxTokens, count: (text) => encoder.count(text) };
}

/**
 * Split `text` into pieces that each fit `maxTokens`, breaking at the largest natural boundary
 * that works: paragraphs, then sentences, then words, and only for a single word that is itself
 * too long, characters. The pieces, read in order, contain all of the text.
 */
export function splitToFit(
  text: string,
  budget: TokenBudget,
  maxTokens = budget.maxTokens,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (budget.count(trimmed) <= maxTokens) return [trimmed];

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length > 1) return pack(paragraphs, budget, maxTokens, '\n\n', splitSentencesFit);

  const sentences = splitSentences(trimmed);
  if (sentences.length > 1) return pack(sentences, budget, maxTokens, ' ', splitWordsFit);

  return splitWordsFit(trimmed, budget, maxTokens);
}

function splitSentencesFit(text: string, budget: TokenBudget, maxTokens: number): string[] {
  const sentences = splitSentences(text);
  if (sentences.length > 1) return pack(sentences, budget, maxTokens, ' ', splitWordsFit);
  return splitWordsFit(text, budget, maxTokens);
}

function splitWordsFit(text: string, budget: TokenBudget, maxTokens: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length > 1) return pack(words, budget, maxTokens, ' ', splitCharactersFit);
  return splitCharactersFit(text, budget, maxTokens);
}

/** A single unbroken token longer than the window: split it by characters, by binary search. */
function splitCharactersFit(text: string, budget: TokenBudget, maxTokens: number): string[] {
  const characters = [...text];
  const pieces: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let low = 1;
    let high = characters.length - start;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (budget.count(characters.slice(start, start + middle).join('')) <= maxTokens) low = middle;
      else high = middle - 1;
    }
    pieces.push(characters.slice(start, start + low).join(''));
    start += low;
  }
  return pieces;
}

type Splitter = (text: string, budget: TokenBudget, maxTokens: number) => string[];

/** Greedily join `units` with `separator` while they fit; an oversize unit is split by `deeper`. */
function pack(
  units: readonly string[],
  budget: TokenBudget,
  maxTokens: number,
  separator: string,
  deeper: Splitter,
): string[] {
  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length > 0) pieces.push(current);
    current = '';
  };
  for (const unit of units) {
    if (budget.count(unit) > maxTokens) {
      flush();
      pieces.push(...deeper(unit, budget, maxTokens));
      continue;
    }
    const joined = current.length === 0 ? unit : `${current}${separator}${unit}`;
    if (current.length > 0 && budget.count(joined) > maxTokens) {
      flush();
      current = unit;
    } else {
      current = joined;
    }
  }
  flush();
  return pieces;
}

/** One block of a card body, such as a doc paragraph or a signature. */
export interface Block {
  readonly text: string;
}

export interface Packed {
  /** Card texts, each within budget and each starting with the head. */
  readonly texts: readonly string[];
  /** True when the head alone was too large and had to be split. */
  readonly headSplit: boolean;
}

/**
 * Lay a head and a list of blocks out over as many cards as it takes. Every card begins with the
 * head, so a continuation stays findable by name. Blocks keep their order. A block moves to a
 * new card rather than being cut when it does not fit the current one, and is split only when it
 * cannot fit a card even on its own.
 */
export function packCards(head: string, blocks: readonly Block[], budget: TokenBudget): Packed {
  const headTokens = budget.count(head);
  if (headTokens >= budget.maxTokens) {
    const pieces = splitToFit(head, budget);
    return { texts: pieces, headSplit: true };
  }

  const room = budget.maxTokens - headTokens - 1;
  const texts: string[] = [];
  let body: string[] = [];
  const flush = () => {
    if (body.length > 0) texts.push(`${head}\n${body.join('\n')}`);
    body = [];
  };

  for (const block of blocks) {
    // A block that fits moves to a fresh card whole; one that cannot fit even alone is split.
    for (const piece of splitToFit(block.text, budget, room)) {
      const candidate = [...body, piece].join('\n');
      if (body.length > 0 && budget.count(candidate) > room) flush();
      body.push(piece);
    }
  }
  flush();
  if (texts.length === 0) texts.push(head);
  return { texts: verify(texts, budget), headSplit: false };
}

/**
 * Token counts of joined text can differ slightly from the sum of their parts. Any card that
 * overshoots on the real count is re-split rather than trusted.
 */
function verify(texts: readonly string[], budget: TokenBudget): string[] {
  return texts.flatMap((text) =>
    budget.count(text) <= budget.maxTokens ? [text] : splitToFit(text, budget),
  );
}
