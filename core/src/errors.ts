/**
 * Typed errors for every code-lens subsystem.
 *
 * Nothing in the packages throws a bare `Error`. A failure is a `AnvesaError` subclass that says
 * what went wrong (`code`), where (`subsystem`), with what inputs (`context`) and because of what
 * (`cause`). Callers branch on `code`, never on message text, and the whole chain serialises to
 * JSON so CLI and MCP layers can report it without losing the reason.
 *
 * Code convention: `<SUBSYSTEM>_<REASON>` in upper snake case, e.g. `SYNTAX_GRAMMAR_MISSING`.
 */

export type Subsystem =
  | 'core'
  | 'syntax'
  | 'structural'
  | 'dense'
  | 'indexer'
  | 'embedder'
  | 'retriever'
  | 'cli';

/** Structured facts about the failure. Values are serialised defensively by `toJSON`. */
export type ErrorContext = Readonly<Record<string, unknown>>;

export interface ErrorInit {
  readonly context?: ErrorContext;
  /** The underlying failure. Preserved on the native `cause` chain. */
  readonly cause?: unknown;
  /** What the caller can do about it, when there is something concrete to say. */
  readonly hint?: string;
}

export interface SerializedError {
  readonly name: string;
  readonly code: string;
  readonly subsystem: Subsystem;
  readonly message: string;
  readonly context: Readonly<Record<string, JsonValue>>;
  readonly hint?: string;
  readonly cause?: SerializedCause;
}

export type SerializedCause = SerializedError | { readonly name: string; readonly message: string };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Format every error code must follow. Enforced by tests over each package's error classes. */
export const ERROR_CODE_FORMAT = /^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+$/;

export abstract class AnvesaError extends Error {
  abstract readonly code: string;
  abstract readonly subsystem: Subsystem;
  readonly context: ErrorContext;
  readonly hint: string | undefined;

  constructor(message: string, init: ErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.context = init.context ?? {};
    this.hint = init.hint;
  }

  static is(value: unknown): value is AnvesaError {
    return value instanceof AnvesaError;
  }

  /** This error followed by each nested cause, outermost first. */
  causeChain(): readonly unknown[] {
    const chain: unknown[] = [];
    const seen = new Set<unknown>();
    let current: unknown = this;
    while (current !== undefined && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      current = current instanceof Error ? current.cause : undefined;
    }
    return chain;
  }

  toJSON(): SerializedError {
    return serializeError(this, new WeakSet()) as SerializedError;
  }
}

function serializeError(error: Error, seen: WeakSet<object>): SerializedCause {
  seen.add(error);
  const cause = serializeCause(error.cause, seen);
  if (!(error instanceof AnvesaError)) {
    return { name: error.name, message: error.message, ...(cause ? { cause } : {}) };
  }
  return {
    name: error.name,
    code: error.code,
    subsystem: error.subsystem,
    message: error.message,
    context: toJsonRecord(error.context, seen),
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(cause ? { cause } : {}),
  };
}

function serializeCause(cause: unknown, seen: WeakSet<object>): SerializedCause | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    if (seen.has(cause)) return { name: cause.name, message: '[circular cause]' };
    return serializeError(cause, seen);
  }
  return { name: 'NonErrorCause', message: describeThrowable(cause) };
}

/** JSON-safe copy of a context object. Cycles, bigints, functions and errors are all handled. */
function toJsonRecord(context: ErrorContext, seen: WeakSet<object>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(context)) out[key] = toJson(value, seen);
  return out;
}

function toJson(value: unknown, seen: WeakSet<object>): JsonValue {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
      return null;
    case 'function':
      return `[function ${value.name || 'anonymous'}]`;
    case 'symbol':
      return value.toString();
    case 'object': {
      if (value === null) return null;
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (value instanceof Error) return serializeError(value, seen) as JsonValue;
      if (Array.isArray(value)) return value.map((item) => toJson(item, seen));
      if (value instanceof Map || value instanceof Set)
        return [...value].map((i) => toJson(i, seen));
      const record: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(value)) record[k] = toJson(v, seen);
      return record;
    }
  }
}

/** Human-readable description of anything that can be thrown. */
export function describeThrowable(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  if (typeof thrown === 'string') return thrown;
  try {
    return JSON.stringify(thrown) ?? String(thrown);
  } catch (serializationFailure) {
    return `unserializable ${typeof thrown} (${describeThrowable(serializationFailure)})`;
  }
}

// ---------------------------------------------------------------------------------------------
// Generic errors owned by core. Subsystem-specific errors live in their own package.
// ---------------------------------------------------------------------------------------------

/** A caller passed a value that violates a function's documented contract. */
export class InvalidArgumentError extends AnvesaError {
  readonly code = 'CORE_INVALID_ARGUMENT';
  readonly subsystem = 'core';

  constructor(
    argument: string,
    expected: string,
    received: unknown,
    init: Omit<ErrorInit, 'context'> & { readonly context?: ErrorContext } = {},
  ) {
    super(`Invalid ${argument}: expected ${expected}, received ${describeThrowable(received)}`, {
      ...init,
      context: { argument, expected, received, ...init.context },
    });
  }
}

/** A deadline passed before the operation finished. */
export class DeadlineExceededError extends AnvesaError {
  readonly code = 'CORE_DEADLINE_EXCEEDED';
  readonly subsystem = 'core';

  constructor(operation: string, init: ErrorInit = {}) {
    super(`Deadline exceeded during ${operation}`, {
      ...init,
      context: { operation, ...init.context },
    });
  }
}

/** The caller cancelled the operation through its AbortSignal. */
export class OperationAbortedError extends AnvesaError {
  readonly code = 'CORE_OPERATION_ABORTED';
  readonly subsystem = 'core';

  constructor(operation: string, init: ErrorInit = {}) {
    super(`Operation aborted during ${operation}`, {
      ...init,
      context: { operation, ...init.context },
    });
  }
}

/** Code reached a state its author proved impossible. Always a bug in code-lens, not the input. */
export class InvariantViolationError extends AnvesaError {
  readonly code = 'CORE_INVARIANT_VIOLATED';
  readonly subsystem = 'core';

  constructor(message: string, init: ErrorInit = {}) {
    super(message, {
      hint: 'This is a code-lens defect; please report it with the context below.',
      ...init,
    });
  }
}

/** A fan-out finished with one or more failures. Every failure is kept, none is dropped. */
export class AggregateFailureError extends AnvesaError {
  readonly code = 'CORE_AGGREGATE_FAILURE';
  readonly subsystem = 'core';
  readonly failures: readonly AnvesaError[];

  constructor(operation: string, failures: readonly AnvesaError[], init: ErrorInit = {}) {
    super(`${failures.length} failure(s) during ${operation}`, {
      ...init,
      cause: failures[0],
      context: {
        operation,
        failures: failures.map((failure) => ({ code: failure.code, message: failure.message })),
        ...init.context,
      },
    });
    this.failures = failures;
  }
}

/** Something that is not a `AnvesaError` reached a boundary that requires one. */
export class UnexpectedFailureError extends AnvesaError {
  readonly code = 'CORE_UNEXPECTED_FAILURE';
  readonly subsystem = 'core';

  constructor(operation: string, thrown: unknown, init: Omit<ErrorInit, 'cause'> = {}) {
    super(`Unexpected failure during ${operation}: ${describeThrowable(thrown)}`, {
      ...init,
      cause: thrown,
      context: { operation, ...init.context },
    });
  }
}

/**
 * Turn whatever a `catch` received into a `AnvesaError` without losing it. Typed errors pass
 * through untouched; everything else is wrapped with the operation that was running, keeping the
 * original on the cause chain.
 */
export function toAnvesaError(
  thrown: unknown,
  operation: string,
  context?: ErrorContext,
): AnvesaError {
  if (thrown instanceof AnvesaError) return thrown;
  return new UnexpectedFailureError(operation, thrown, context ? { context } : {});
}

/** Exhaustiveness guard for `switch` over closed unions. */
export function assertNever(value: never, where: string): never {
  throw new InvariantViolationError(`Unhandled variant in ${where}`, { context: { value } });
}

// Backward-compatibility aliases during migration
export { AnvesaError as CodeLensError, toAnvesaError as toCodeLensError };
