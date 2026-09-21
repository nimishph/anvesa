import { InvariantViolationError } from '@sutras/code-lens-core';

/** Something that occupies a span of the source, in the same units as a syntax node's indices. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Answers "which span is innermost around this position" for spans that nest properly (a symbol
 * inside a symbol), given positions in non-decreasing order. Walking a syntax tree depth-first
 * produces exactly that order, so the whole file costs one pass however many spans there are.
 */
export class NestingCursor<T extends Span> {
  readonly #spans: readonly T[];
  readonly #open: T[] = [];
  #next = 0;
  #last = Number.NEGATIVE_INFINITY;

  /** `spans` must be ordered by start, outer before inner where they start together. */
  constructor(spans: readonly T[]) {
    this.#spans = spans;
  }

  /** The innermost span containing `position`, or `undefined`. Positions must not go backwards. */
  at(position: number): T | undefined {
    if (position < this.#last) {
      throw new InvariantViolationError('NestingCursor positions must not go backwards', {
        context: { position, previous: this.#last },
      });
    }
    this.#last = position;
    while (this.#next < this.#spans.length) {
      const candidate = this.#spans[this.#next] as T;
      if (candidate.start > position) break;
      this.#next += 1;
      this.#closeBefore(candidate.start);
      if (candidate.end > position) this.#open.push(candidate);
    }
    this.#closeBefore(position);
    return this.#open.at(-1);
  }

  #closeBefore(position: number): void {
    while (this.#open.length > 0 && (this.#open.at(-1) as T).end <= position) this.#open.pop();
  }
}

/** Order spans for `NestingCursor`: by start, and where they start together, the longer first. */
export function bySpan<T extends Span>(a: T, b: T): number {
  return a.start - b.start || b.end - a.end;
}
