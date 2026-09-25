import {
  type CodeLensError,
  Deadline,
  InvalidArgumentError,
  toCodeLensError,
} from '@cntxt-labs/anvesa-core';
import { budgetFor } from './budget.ts';
import {
  type Card,
  type CardDraft,
  type InputFile,
  type InputSource,
  inputFile,
  makeCards,
  type Transformer,
  type TransformServices,
} from './card.ts';
import type { ChannelRegistry } from './channel.ts';
import { budgetSourceOf, type Embedder, embedAll } from './embedder.ts';
import { TransformerFailedError } from './errors.ts';
import { type Finding, type QuarantinedCard, RedTeamGate } from './redteam/index.ts';
import type { StoredCard, VectorStore } from './store.ts';

export interface IngesterOptions {
  readonly registry: ChannelRegistry;
  readonly embedder: Embedder;
  readonly store: VectorStore;
  readonly services: TransformServices;
  /** Defaults to a gate with the built-in rules and profiles. */
  readonly gate?: RedTeamGate;
}

export interface IngestOptions {
  readonly deadline?: Deadline;
  /** Rebuild even when the stored cards are up to date. */
  readonly force?: boolean;
}

export type IngestOutcome = 'indexed' | 'unchanged' | 'empty' | 'failed';

/** What bringing a channel in line with a source did. */
export interface SyncReport {
  readonly channel: string;
  readonly source: string;
  readonly reports: readonly IngestReport[];
  /** Files in the index that the source no longer holds, now removed. */
  readonly removed: readonly string[];
}

/** What happened to one file in one channel. */
export interface IngestReport {
  readonly channel: string;
  readonly path: string;
  readonly transformer: string;
  readonly outcome: IngestOutcome;
  /** Cards the transformer produced. */
  readonly produced: number;
  /** Cards now in the index for this file. */
  readonly indexed: number;
  readonly sanitized: number;
  readonly duplicates: number;
  readonly quarantined: readonly QuarantinedCard[];
  readonly findings: readonly Finding[];
  /** Present when `outcome` is `failed`. The previous cards for this file were left in place. */
  readonly failure?: CodeLensError;
}

/**
 * Turns files into indexed cards: transform, validate, red-team, embed, screen the vectors, store.
 *
 * A file's cards are replaced as a unit. If anything fails part way, the previous cards stay and
 * the report says why, so a bad file never empties the index. Cancellation is different: a
 * cancelled or expired `Deadline` stops the whole call with its own error.
 */
export class Ingester {
  readonly #registry: ChannelRegistry;
  readonly #embedder: Embedder;
  readonly #store: VectorStore;
  readonly #services: TransformServices;
  readonly #gate: RedTeamGate;

  constructor(options: IngesterOptions) {
    this.#registry = options.registry;
    this.#embedder = options.embedder;
    this.#store = options.store;
    this.#services = options.services;
    this.#gate = options.gate ?? new RedTeamGate();
  }

  /**
   * What the stored cards were built with: every transformer's name and version, and the model.
   * When it changes, cards built earlier are out of date even for files that have not changed.
   */
  get signature(): string {
    const transformers = this.#registry
      .channels()
      .flatMap((channel) => this.#registry.require(channel))
      .map((transformer) => `${transformer.name}@${transformer.version}`)
      .sort();
    return [this.#embedder.info.id, ...transformers, `redteam@${this.#gate.fingerprint}`].join('|');
  }

  /**
   * Whether any channel would want a file at this path. Decided from the path alone (the file is
   * probed with no content), so a run can leave unclaimed files unread.
   */
  claims(path: string, language?: string): boolean {
    return this.#registry.claimants(inputFile(path, '', language ? { language } : {})).length > 0;
  }

  /** Ingest one file into every channel that claims it. */
  async ingest(file: InputFile, options: IngestOptions = {}): Promise<readonly IngestReport[]> {
    file = withHash(file, 'ingest');
    const reports: IngestReport[] = [];
    for (const transformer of this.#registry.claimants(file)) {
      reports.push(await this.#ingestInto(transformer, file, options));
    }
    return reports;
  }

  /**
   * Make one channel equal what `source` holds now: ingest every file it offers into that
   * channel, and remove the cards of files the channel has indexed that it no longer offers.
   * Only files the channel's own transformers claim count as offered, so a source can hold
   * records the channel does not care about.
   */
  async syncChannel(
    channel: string,
    source: InputSource,
    options: IngestOptions = {},
  ): Promise<SyncReport> {
    const transformers = this.#registry.require(channel);
    const reports: IngestReport[] = [];
    const offered = new Set<string>();
    for await (const offeredFile of source.files()) {
      options.deadline?.throwIfExpired(`sync ${channel} from ${source.name}`);
      const file = withHash(offeredFile, source.name);
      for (const transformer of transformers) {
        if (!transformer.claim(file)) continue;
        offered.add(file.path);
        reports.push(await this.#ingestInto(transformer, file, options));
      }
    }
    const removed: string[] = [];
    for (const path of await this.#store.sourcePaths(channel)) {
      if (offered.has(path)) continue;
      options.deadline?.throwIfExpired(`sync ${channel} from ${source.name}`);
      await this.#store.removeSource(channel, path);
      removed.push(path);
    }
    return { channel, source: source.name, reports, removed };
  }

  /** Ingest many files one after another. Reports come back in order; failures are in them. */
  async ingestMany(
    files: Iterable<InputFile>,
    options: IngestOptions = {},
  ): Promise<readonly IngestReport[]> {
    const reports: IngestReport[] = [];
    for (const file of files) reports.push(...(await this.ingest(file, options)));
    return reports;
  }

  /** Remove a file's cards from every channel. */
  async remove(path: string): Promise<number> {
    let removed = 0;
    for (const channel of this.#registry.channels()) {
      if (await this.#store.removeSource(channel, path)) removed += 1;
    }
    return removed;
  }

  async #ingestInto(
    transformer: Transformer,
    file: InputFile,
    options: IngestOptions,
  ): Promise<IngestReport> {
    const deadline = options.deadline ?? Deadline.unbounded();
    const { channel } = transformer;
    const model = this.#embedder.info.id;
    const blank = {
      channel,
      path: file.path,
      transformer: transformer.name,
      sanitized: 0,
      duplicates: 0,
      quarantined: [],
      findings: [],
    } as const;

    deadline.throwIfExpired(`ingest ${file.path} into ${channel}`);
    const previous = await this.#store.sourceState(channel, file.path);
    if (
      !options.force &&
      previous &&
      previous.contentHash === file.hash &&
      previous.transformerVersion === transformer.version &&
      previous.model === model
    ) {
      return { ...blank, outcome: 'unchanged', produced: previous.cards, indexed: previous.cards };
    }

    try {
      const cards = await this.#transform(transformer, file, deadline);
      const stats = await this.#store.stats(channel);
      const batch = this.#gate.screenBatch(cards, {
        ...(stats.sources > 0 ? { baseline: { cardsPerSource: stats.medianCardsPerSource } } : {}),
      });

      const vectors = await embedAll(
        this.#embedder,
        batch.accepted.map((card) => card.text),
        { deadline },
      );
      const screened = this.#gate.screenVectors(batch.accepted, vectors);
      const stored: StoredCard[] = [];
      batch.accepted.forEach((card, index) => {
        if (screened.kept[index]) stored.push({ card, vector: vectors[index] as Float32Array });
      });
      const quarantined = [...batch.quarantined, ...screened.quarantined];

      await this.#store.replaceSource({
        channel,
        path: file.path,
        model,
        contentHash: file.hash,
        transformerVersion: transformer.version,
        cards: stored,
        quarantined,
      });
      return {
        ...blank,
        outcome: stored.length === 0 && quarantined.length === 0 ? 'empty' : 'indexed',
        produced: cards.length,
        indexed: stored.length,
        sanitized: batch.sanitized,
        duplicates: batch.duplicates.length,
        quarantined,
        findings: [...batch.findings, ...screened.findings],
      };
    } catch (failure) {
      deadline.throwIfExpired(`ingest ${file.path} into ${channel}`);
      const typed = toCodeLensError(failure, `ingest ${file.path} into ${channel}`);
      return {
        ...blank,
        outcome: 'failed',
        produced: 0,
        indexed: previous?.cards ?? 0,
        failure: typed,
      };
    }
  }

  async #transform(transformer: Transformer, file: InputFile, deadline: Deadline): Promise<Card[]> {
    let drafts: readonly CardDraft[];
    try {
      drafts = await transformer.transform(file, {
        budget: budgetFor(budgetSourceOf(this.#embedder)),
        services: this.#services,
        deadline,
      });
    } catch (failure) {
      deadline.throwIfExpired(`transform ${file.path}`);
      throw new TransformerFailedError(transformer.name, file.path, { cause: failure });
    }
    return makeCards(transformer, file, drafts);
  }
}

/** A source may leave `hash` out; it is then derived from `content`. Anything else is rejected. */
function withHash(file: InputFile, source: string): InputFile {
  if (typeof file.hash === 'string' && file.hash !== '') return file;
  if (typeof file.path !== 'string' || typeof file.content !== 'string') {
    throw new InvalidArgumentError(
      `record from source ${source}`,
      'an object with string "path" and "content"',
      file,
    );
  }
  return inputFile(file.path, file.content, file.language ? { language: file.language } : {});
}
