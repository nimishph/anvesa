import { CodeLensError, type ErrorInit } from '@cntxt-labs/anvesa-core';

/** Every failure in this package. Codes are `EMBEDDER_<REASON>`. */
export abstract class EmbedderSubsystemError extends CodeLensError {
  readonly subsystem = 'embedder' as const;
}

/** A model that is not installed, and cannot be fetched. `searched` says where it looked. */
export class ModelUnavailableError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_MODEL_UNAVAILABLE';

  constructor(model: string, problem: string, init: ErrorInit = {}) {
    super(`Model "${model}" is not available: ${problem}`, {
      hint: `Install it: anvesa model install ${model} --from <dir> (or allow the network).`,
      ...init,
      context: { model, problem, ...init.context },
    });
  }
}

/** A model file's SHA-256 is not the one that was expected. Nothing is kept. */
export class ModelIntegrityError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_MODEL_INTEGRITY';

  constructor(model: string, file: string, expected: string, actual: string, init: ErrorInit = {}) {
    super(`${file} of model "${model}" does not match its expected SHA-256`, {
      hint: 'The file is corrupt, incomplete or not the one this version pins. Fetch it again.',
      ...init,
      context: { model, file, expected, actual, ...init.context },
    });
  }
}

/** Installing or fetching a model failed for a reason other than integrity. */
export class ModelInstallError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_MODEL_INSTALL';

  constructor(model: string, problem: string, init: ErrorInit = {}) {
    super(`Cannot install model "${model}": ${problem}`, {
      ...init,
      context: { model, problem, ...init.context },
    });
  }
}

/** Network access is needed and was not allowed. */
export class NetworkForbiddenError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_NETWORK_FORBIDDEN';

  constructor(model: string, url: string, init: ErrorInit = {}) {
    super(`Model "${model}" would need to be fetched from ${url}, and the network is not allowed`, {
      hint: 'Install it from a local directory instead.',
      ...init,
      context: { model, url, ...init.context },
    });
  }
}

/** A tokenizer file is not one this package can use. `location` names the part that is wrong. */
export class TokenizerInvalidError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_TOKENIZER_INVALID';

  constructor(source: string, location: string, problem: string, init: ErrorInit = {}) {
    super(`Tokenizer ${source} is not usable at ${location}: ${problem}`, {
      ...init,
      context: { source, location, problem, ...init.context },
    });
  }
}

/** A text is longer than the model's window. It is refused, never silently cut. */
export class InputTooLongError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_INPUT_TOO_LONG';

  constructor(model: string, tokens: number, window: number, init: ErrorInit = {}) {
    super(`A text is ${tokens} tokens for "${model}", whose window is ${window}`, {
      hint: 'Split the text into cards that fit (see dense packCards) instead of truncating it.',
      ...init,
      context: { model, tokens, window, ...init.context },
    });
  }
}

/** The ONNX runtime could not be loaded or failed while running. */
export class InferenceError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_INFERENCE';

  constructor(model: string, problem: string, init: ErrorInit = {}) {
    super(`Inference with "${model}" failed: ${problem}`, {
      ...init,
      context: { model, problem, ...init.context },
    });
  }
}

/** The model's inputs or outputs are not what the encoder needs. */
export class ModelShapeError extends EmbedderSubsystemError {
  readonly code = 'EMBEDDER_MODEL_SHAPE';

  constructor(model: string, problem: string, init: ErrorInit = {}) {
    super(`Model "${model}" has an unexpected shape: ${problem}`, {
      ...init,
      context: { model, problem, ...init.context },
    });
  }
}
