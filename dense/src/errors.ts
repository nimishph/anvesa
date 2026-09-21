import { CodeLensError, type ErrorInit } from '@sutras/code-lens-core';

/** Every failure in this package. Codes are `DENSE_<REASON>`. */
export abstract class DenseSubsystemError extends CodeLensError {
  readonly subsystem = 'dense' as const;
}

/** A card, transformer or channel definition that breaks the contract. `field` names the culprit. */
export class DefinitionInvalidError extends DenseSubsystemError {
  readonly code = 'DENSE_DEFINITION_INVALID';

  constructor(what: string, field: string, problem: string, init: ErrorInit = {}) {
    super(`Invalid ${what}: ${field} ${problem}`, {
      ...init,
      context: { what, field, problem, ...init.context },
    });
  }
}

/** A transformer threw while turning a file into cards. */
export class TransformerFailedError extends DenseSubsystemError {
  readonly code = 'DENSE_TRANSFORMER_FAILED';

  constructor(transformer: string, path: string, init: ErrorInit = {}) {
    super(`Transformer "${transformer}" failed on ${path}`, {
      ...init,
      context: { transformer, path, ...init.context },
    });
  }
}

/** A channel name is already taken, or a transformer names a channel that does not exist. */
export class ChannelConflictError extends DenseSubsystemError {
  readonly code = 'DENSE_CHANNEL_CONFLICT';

  constructor(channel: string, problem: string, init: ErrorInit = {}) {
    super(`Channel "${channel}": ${problem}`, {
      ...init,
      context: { channel, problem, ...init.context },
    });
  }
}

export class ChannelNotFoundError extends DenseSubsystemError {
  readonly code = 'DENSE_CHANNEL_MISSING';

  constructor(channel: string, known: readonly string[], init: ErrorInit = {}) {
    super(`No channel named "${channel}"`, {
      hint:
        known.length > 0 ? `Known channels: ${known.join(', ')}.` : 'No channels are registered.',
      ...init,
      context: { channel, known, ...init.context },
    });
  }
}

/** Stored vectors and the model being used do not have the same dimensionality. */
export class DimensionMismatchError extends DenseSubsystemError {
  readonly code = 'DENSE_DIMENSION_MISMATCH';

  constructor(channel: string, model: string, stored: number, given: number, init: ErrorInit = {}) {
    super(
      `Channel "${channel}" holds ${stored}-dimensional vectors for model "${model}", but ${given} were given`,
      {
        hint: 'Re-embed the channel with the current model, or use the model that built it.',
        ...init,
        context: { channel, model, stored, given, ...init.context },
      },
    );
  }
}

/** The embedder failed, or returned something that is not a usable vector. */
export class EmbedFailedError extends DenseSubsystemError {
  readonly code = 'DENSE_EMBED_FAILED';

  constructor(model: string, problem: string, init: ErrorInit = {}) {
    super(`Embedding with "${model}" failed: ${problem}`, {
      ...init,
      context: { model, problem, ...init.context },
    });
  }
}

/** A card was refused by the red-team gate and the caller asked for that to be an error. */
export class CardRejectedError extends DenseSubsystemError {
  readonly code = 'DENSE_CARD_REJECTED';

  constructor(cardId: string, rules: readonly string[], init: ErrorInit = {}) {
    super(`Card ${cardId} was quarantined by the red-team gate (${rules.join(', ')})`, {
      ...init,
      context: { cardId, rules, ...init.context },
    });
  }
}

/** A store operation failed for a reason of its own, kept as the cause. */
export class VectorStoreError extends DenseSubsystemError {
  readonly code = 'DENSE_STORE_FAILED';

  constructor(operation: string, init: ErrorInit = {}) {
    super(`Vector store failed to ${operation}`, {
      ...init,
      context: { operation, ...init.context },
    });
  }
}
