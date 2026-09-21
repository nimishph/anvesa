import { CodeLensError, type ErrorInit } from '@sutras/code-lens-core';

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
