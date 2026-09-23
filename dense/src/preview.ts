import { Deadline } from '@cntxt-labs/anvesa-core';
import type { TokenBudget } from './budget.ts';
import {
  type Card,
  type CardDraft,
  type InputFile,
  makeCards,
  type Transformer,
  type TransformServices,
} from './card.ts';
import { type BatchBaseline, type BatchResult, RedTeamGate } from './redteam/index.ts';

export interface PreviewOptions {
  readonly budget: TokenBudget;
  readonly services: TransformServices;
  readonly gate?: RedTeamGate;
  readonly baseline?: BatchBaseline;
  readonly deadline?: Deadline;
}

export interface Preview {
  /** Cards exactly as the transformer made them. */
  readonly cards: readonly Card[];
  /** What the red-team gate would do with them. */
  readonly screened: BatchResult;
}

/**
 * Run a transformer on one file and screen the result, changing nothing: no embedding, no store.
 * This is what `channel test` shows an author before a channel is indexed for real.
 */
export async function previewCards(
  transformer: Transformer,
  file: InputFile,
  options: PreviewOptions,
): Promise<Preview> {
  const drafts: readonly CardDraft[] = await transformer.transform(file, {
    budget: options.budget,
    services: options.services,
    deadline: options.deadline ?? Deadline.unbounded(),
  });
  const cards = makeCards(transformer, file, drafts);
  const gate = options.gate ?? new RedTeamGate();
  return {
    cards,
    screened: gate.screenBatch(cards, options.baseline ? { baseline: options.baseline } : {}),
  };
}
