import { CodeLensError, type ErrorInit } from '@cntxt-labs/anvesa-core';

/** Every failure in this package. Codes are `RETRIEVER_<REASON>`. */
export abstract class RetrieverSubsystemError extends CodeLensError {
  readonly subsystem = 'retriever' as const;
}

/** `.anvesa/config.json` is unreadable or does not fit its schema. `location` is the field. */
export class ProjectConfigError extends RetrieverSubsystemError {
  readonly code = 'RETRIEVER_CONFIG';

  constructor(path: string, location: string, problem: string, init: ErrorInit = {}) {
    super(`Project config ${path} is invalid at ${location}: ${problem}`, {
      ...init,
      context: { path, location, problem, ...init.context },
    });
  }
}

/** A channel's module could not be loaded or does not export what a channel must. */
export class ChannelModuleError extends RetrieverSubsystemError {
  readonly code = 'RETRIEVER_CHANNEL_MODULE';

  constructor(channel: string, module: string, problem: string, init: ErrorInit = {}) {
    super(`Channel "${channel}" (${module}) cannot be used: ${problem}`, {
      ...init,
      context: { channel, module, problem, ...init.context },
    });
  }
}

/** Dense retrieval needs an embedder and none is available. */
export class EmbedderUnavailableError extends RetrieverSubsystemError {
  readonly code = 'RETRIEVER_EMBEDDER_UNAVAILABLE';

  constructor(problem: string, init: ErrorInit = {}) {
    super(`No embedder is available: ${problem}`, {
      hint: 'Install a model (anvesa model install <id> --from <dir>) or run structural queries only.',
      ...init,
      context: { problem, ...init.context },
    });
  }
}

/** A name given to look up matches several things, or nothing. */
export class TargetError extends RetrieverSubsystemError {
  readonly code = 'RETRIEVER_TARGET';

  constructor(
    target: string,
    problem: string,
    candidates: readonly string[],
    init: ErrorInit = {},
  ) {
    super(`"${target}" ${problem}`, {
      hint: candidates.length > 0 ? `Use one of: ${candidates.join(', ')}.` : undefined,
      ...init,
      context: { target, problem, candidates, ...init.context },
    } as ErrorInit);
  }
}

/** The index has not been built (or is empty), so there is nothing to search. */
export class NotIndexedError extends RetrieverSubsystemError {
  readonly code = 'RETRIEVER_NOT_INDEXED';

  constructor(root: string, init: ErrorInit = {}) {
    super(`${root} has no index yet`, {
      hint: 'Run: anvesa index',
      ...init,
      context: { root, ...init.context },
    });
  }
}
