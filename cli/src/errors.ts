import { CodeLensError, type ErrorInit } from '@cntxt-labs/anvesa-core';

/**
 * A command ran and found a problem it was asked to look for: a mapping that does not match its
 * record, a check that differs, a mapping learned that does not hold. The command line itself was
 * fine, which is what tells it apart from `InvalidArgumentError` (exit 2).
 */
export class CommandFailedError extends CodeLensError {
  readonly code = 'CLI_COMMAND_FAILED';
  readonly subsystem = 'cli' as const;

  constructor(command: string, problem: string, init: ErrorInit = {}) {
    super(`${command} failed: ${problem}`, {
      ...init,
      context: { command, problem, ...init.context },
    });
  }
}

/**
 * The command registry does not hold together: a malformed id, a word two commands claim, or an
 * index that no longer matches the command modules. A bug in anvesa, found on load.
 */
export class CommandRegistryError extends CodeLensError {
  readonly code = 'CLI_COMMAND_REGISTRY';
  readonly subsystem = 'cli' as const;

  constructor(command: string, problem: string, init: ErrorInit = {}) {
    super(`command ${command}: ${problem}`, {
      ...init,
      context: { command, problem, ...init.context },
    });
  }
}

/**
 * A command line that names no command anvesa has. The CLI answers it with the problem and the
 * overview, exit 2, and does not count it as a run.
 */
export class UnknownCommandError extends CodeLensError {
  readonly code = 'CLI_UNKNOWN_COMMAND';
  readonly subsystem = 'cli' as const;

  constructor(problem: string, init: ErrorInit = {}) {
    super(problem, { ...init, context: { problem, ...init.context } });
  }
}
