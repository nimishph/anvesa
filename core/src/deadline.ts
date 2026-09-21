import {
  CodeLensError,
  DeadlineExceededError,
  InvalidArgumentError,
  OperationAbortedError,
  toCodeLensError,
} from './errors.ts';

export interface DeadlineOptions {
  /** Time budget for the whole operation. Omit for no time limit. */
  readonly timeoutMs?: number;
  /** Caller cancellation. Combined with the time budget when both are given. */
  readonly signal?: AbortSignal;
}

/**
 * A caller-owned time budget and cancellation handle. Nothing in code-lens picks a timeout on the
 * caller's behalf: an operation with no `Deadline` runs until it finishes or fails.
 *
 * The timer behind the budget is unref'd, as with `AbortSignal.timeout`: it never keeps a process
 * alive on its own. That is right for a budget that outlives its work, and it means a wait that
 * involves no other pending I/O will not be woken by it.
 */
export class Deadline {
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
  private readonly startedAt = performance.now();

  private constructor(signal: AbortSignal, timeoutMs: number | undefined) {
    this.signal = signal;
    this.timeoutMs = timeoutMs;
  }

  static of(options: DeadlineOptions = {}): Deadline {
    const { timeoutMs, signal } = options;
    if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      throw new InvalidArgumentError(
        'timeoutMs',
        'a positive finite number of milliseconds',
        timeoutMs,
      );
    }
    const signals: AbortSignal[] = [];
    if (signal) signals.push(signal);
    if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
    const combined = signals.length > 0 ? AbortSignal.any(signals) : new AbortController().signal;
    return new Deadline(combined, timeoutMs);
  }

  static unbounded(): Deadline {
    return Deadline.of();
  }

  /**
   * True once the caller cancelled or the time budget is spent. The clock is read directly as well
   * as through the signal: a timer cannot fire while synchronous work (a parse, a tight loop) holds
   * the event loop, so `signal.aborted` alone would miss a budget that ran out mid-work.
   */
  get expired(): boolean {
    return this.signal.aborted || this.remainingMs() === 0;
  }

  /** Milliseconds left of the time budget, or `null` when there is none. */
  remainingMs(): number | null {
    if (this.timeoutMs === undefined) return null;
    return Math.max(0, this.timeoutMs - (performance.now() - this.startedAt));
  }

  /** Call between units of work so a long operation stops promptly and says why. */
  throwIfExpired(operation: string): void {
    if (this.expired) throw this.expiryError(operation, this.signal.reason);
  }

  /**
   * Run `work` under this deadline. A failure that happens because the deadline fired is reported
   * as that, with the original failure kept as the cause; any other failure keeps its own type.
   */
  async run<T>(operation: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.throwIfExpired(operation);
    try {
      return await work(this.signal);
    } catch (failure) {
      if (this.expired && !(failure instanceof CodeLensError)) {
        throw this.expiryError(operation, failure);
      }
      throw toCodeLensError(failure, operation);
    }
  }

  private expiryError(operation: string, reason: unknown): CodeLensError {
    const timedOut = reason instanceof DOMException && reason.name === 'TimeoutError';
    if (timedOut || (!this.signal.aborted && this.remainingMs() === 0)) {
      return new DeadlineExceededError(operation, {
        cause: reason,
        context: { timeoutMs: this.timeoutMs },
        hint: 'Raise the time budget, or narrow the scope of the operation.',
      });
    }
    return new OperationAbortedError(operation, { cause: reason });
  }
}
