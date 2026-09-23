import { createHash } from 'node:crypto';
import type { Deadline } from '@cntxt-labs/anvesa-core';
import type { EncodedFile } from '@cntxt-labs/anvesa-structural';
import type { SyntaxTree } from '@cntxt-labs/anvesa-syntax';
import type { TokenBudget } from './budget.ts';
import { DefinitionInvalidError } from './errors.ts';

/** How far the content behind a card is trusted. It sets how strictly the red-team gate reads it. */
export type Trust = 'first-party' | 'third-party' | 'untrusted';

/** A file, or anything shaped like one. Adapters can feed a transformer from any source. */
export interface InputFile {
  readonly path: string;
  readonly content: string;
  /** SHA-256 of `content`, hex. Identifies the version of the content a card came from. */
  readonly hash: string;
  readonly language?: string;
}

/**
 * Where a channel's input comes from when it is not a directory of files: a database, an API,
 * another program's records. It hands out virtual files; the channel's transformer turns them
 * into cards, and `Ingester.syncChannel` keeps the index equal to what the source holds now.
 */
export interface InputSource {
  readonly name: string;
  /** Every file the source holds at this moment. */
  files(): AsyncIterable<InputFile> | Iterable<InputFile>;
}

export function inputFile(
  path: string,
  content: string,
  options: { readonly language?: string } = {},
): InputFile {
  return {
    path,
    content,
    hash: createHash('sha256').update(content).digest('hex'),
    ...(options.language === undefined ? {} : { language: options.language }),
  };
}

export interface SourceSpan {
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface CardSource {
  readonly path: string;
  readonly span?: SourceSpan;
  readonly contentHash: string;
}

export interface CardProvenance {
  readonly transformer: string;
  readonly transformerVersion: string;
  readonly trust: Trust;
}

/** What the red-team gate did to a card that came out of it. */
export interface ScreenRecord {
  readonly verdict: 'pass' | 'sanitize';
  /** Ids of every rule that fired, including ones that only flagged. */
  readonly findings: readonly string[];
}

/**
 * One retrievable unit of a channel: the text that gets embedded, and what is needed to show and
 * trace it. Cards are immutable; the gate returns a new card when it changes one.
 */
export interface Card {
  /** Unique within its channel and stable across re-indexing of unchanged content. */
  readonly id: string;
  readonly channel: string;
  /** Content category, e.g. `code.symbol`. Stable identifier for filtering and policy. */
  readonly categoryId: string;
  readonly categoryLabel: string;
  /** The text that is embedded. */
  readonly text: string;
  /** Filterable metadata returned with hits. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly source: CardSource;
  readonly provenance: CardProvenance;
  readonly screen?: ScreenRecord;
}

/** What a transformer produces. The pipeline completes it into a `Card`. */
export interface CardDraft {
  /** Identifies the card within its file, e.g. a qualified symbol name. */
  readonly key: string;
  readonly text: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly span?: SourceSpan;
  /**
   * Cards that belong together (the parts of one symbol) share a group, so a search can show only
   * the best part. Defaults to the key.
   */
  readonly group?: string;
  /** Set when one item was split over several cards because it did not fit the budget. */
  readonly part?: { readonly index: number; readonly of: number };
}

/** Capabilities a transformer may use, supplied by the pipeline so transformers stay testable. */
export interface TransformServices {
  /** Parse a file and run `work` on the tree, disposing it afterwards. */
  withTree<T>(file: InputFile, work: (tree: SyntaxTree) => T | Promise<T>): Promise<T>;
  /** Parse and encode a file into a W-expression outline. */
  encode(file: InputFile, options?: { readonly docs?: boolean }): Promise<EncodedFile>;
}

export interface TransformContext {
  /** How much text one card may hold. Use `packCards` to honour it. */
  readonly budget: TokenBudget;
  readonly services: TransformServices;
  readonly deadline: Deadline;
}

/**
 * Turns files into cards for one channel. This is the extension point of the dense framework: a
 * custom channel is a `Transformer` and nothing else.
 */
export interface Transformer {
  readonly name: string;
  /** Bump when the cards it makes would change, so stored cards are rebuilt. */
  readonly version: string;
  readonly channel: string;
  readonly categoryId: string;
  readonly categoryLabel: string;
  readonly trust: Trust;
  /** Does this transformer want this file? */
  claim(file: InputFile): boolean;
  transform(
    file: InputFile,
    context: TransformContext,
  ): Promise<readonly CardDraft[]> | readonly CardDraft[];
}

const NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const CATEGORY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$|^[a-z][a-z0-9]*$/;
const TRUSTS: ReadonlySet<string> = new Set(['first-party', 'third-party', 'untrusted']);

/** Check a transformer definition once, when it is made, instead of when a file fails later. */
export function defineTransformer<T extends Transformer>(transformer: T): T {
  const bad = (field: string, problem: string): never => {
    throw new DefinitionInvalidError(`transformer "${String(transformer.name)}"`, field, problem);
  };
  if (!NAME.test(transformer.name)) bad('name', 'must be lowercase words joined by "-" or "."');
  if (!NAME.test(transformer.channel))
    bad('channel', 'must be lowercase words joined by "-" or "."');
  if (!CATEGORY.test(transformer.categoryId)) bad('categoryId', 'must look like "code.symbol"');
  if (transformer.categoryLabel.trim() === '') bad('categoryLabel', 'must not be empty');
  if (transformer.version.trim() === '') bad('version', 'must not be empty');
  if (!TRUSTS.has(transformer.trust)) bad('trust', 'must be first-party, third-party or untrusted');
  if (typeof transformer.claim !== 'function') bad('claim', 'must be a function');
  if (typeof transformer.transform !== 'function') bad('transform', 'must be a function');
  return transformer;
}

/** The identity of a card within its channel. Stable for unchanged content. */
export function cardId(path: string, draft: CardDraft): string {
  const base = `${path}#${draft.key}`;
  return draft.part ? `${base}~${draft.part.index}` : base;
}

/** Complete a draft into a card, checking it on the way. */
export function makeCard(transformer: Transformer, file: InputFile, draft: CardDraft): Card {
  const attrs: Record<string, string> = { ...draft.attrs, group: draft.group ?? draft.key };
  if (draft.part) {
    attrs.part = String(draft.part.index);
    attrs.parts = String(draft.part.of);
  }
  const card: Card = {
    id: cardId(file.path, draft),
    channel: transformer.channel,
    categoryId: transformer.categoryId,
    categoryLabel: transformer.categoryLabel,
    text: draft.text,
    attrs,
    source: {
      path: file.path,
      contentHash: file.hash,
      ...(draft.span ? { span: draft.span } : {}),
    },
    provenance: {
      transformer: transformer.name,
      transformerVersion: transformer.version,
      trust: transformer.trust,
    },
  };
  return validateCard(card);
}

/**
 * Complete every draft of one file, and refuse a transformer that gives two drafts the same
 * identity: the second would silently replace the first in the index.
 */
export function makeCards(
  transformer: Transformer,
  file: InputFile,
  drafts: readonly CardDraft[],
): Card[] {
  const cards = drafts.map((draft) => makeCard(transformer, file, draft));
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.id)) {
      throw new DefinitionInvalidError(
        `transformer "${transformer.name}"`,
        `card id "${card.id}"`,
        'is produced twice for one file',
        { hint: 'Give each draft a distinct key.', context: { path: file.path } },
      );
    }
    seen.add(card.id);
  }
  return cards;
}

/** A card the rest of the pipeline can rely on: real text, sane span, string attributes. */
export function validateCard(card: Card): Card {
  const bad = (field: string, problem: string): never => {
    throw new DefinitionInvalidError(`card "${card.id}"`, field, problem, {
      context: { cardId: card.id, channel: card.channel, path: card.source.path },
    });
  };
  if (card.id.trim() === '') bad('id', 'must not be empty');
  if (card.text.trim() === '') bad('text', 'must not be empty or only whitespace');
  const span = card.source.span;
  if (
    span &&
    !(Number.isInteger(span.startLine) && span.startLine >= 1 && span.endLine >= span.startLine)
  ) {
    bad('source.span', 'must be 1-based with endLine >= startLine');
  }
  for (const [key, value] of Object.entries(card.attrs)) {
    if (typeof value !== 'string') bad(`attrs.${key}`, 'must be a string');
  }
  return card;
}
