import type { Environment } from './environment.ts';

const BAR_WIDTH = 24;

/** `12.3 MB`, `840 KB`: sizes as a person reads them. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * One line of a download: `label [██████░░░░░░]  45%  12.3 / 27.3 MB  3.2 MB/s`. With no known
 * total (a server that does not say) it shows what has arrived instead of a bar.
 */
export function renderBar(
  label: string,
  received: number,
  expected: number,
  bytesPerSecond?: number,
): string {
  const rate =
    bytesPerSecond && Number.isFinite(bytesPerSecond) ? `  ${formatBytes(bytesPerSecond)}/s` : '';
  if (expected <= 0) return `${label}  ${formatBytes(received)}${rate}`;
  const share = Math.min(1, received / expected);
  const filled = Math.round(share * BAR_WIDTH);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
  return `${label} [${bar}] ${String(Math.floor(share * 100)).padStart(3)}%  ${formatBytes(received)} / ${formatBytes(expected)}${rate}`;
}

/**
 * Progress of one or more downloads, on stderr so it never mixes with `--json`. On a terminal one
 * line is rewritten in place; otherwise (piped, logged, tests) a plain line is appended as each
 * quarter completes, since redrawing a line only makes sense on a screen.
 */
export class DownloadProgress {
  readonly #environment: Environment;
  readonly #interactive: boolean;
  #label = '';
  #startedAt = 0;
  #lastDraw = 0;
  #lastQuarter = -1;
  #drawn = false;

  constructor(environment: Environment) {
    this.#environment = environment;
    this.#interactive = environment.isTTY === true;
  }

  /** Begin a download. Call `update` as bytes arrive, then `done`. */
  start(label: string): void {
    this.#label = label;
    this.#startedAt = Date.now();
    this.#lastDraw = 0;
    this.#lastQuarter = -1;
    this.#drawn = false;
  }

  update(received: number, expected: number): void {
    const now = Date.now();
    const rate = received / Math.max(0.001, (now - this.#startedAt) / 1000);
    if (this.#interactive) {
      // Redrawing on every chunk floods the terminal; ten times a second is smooth enough.
      if (now - this.#lastDraw < 100 && received < expected) return;
      this.#lastDraw = now;
      this.#environment.stderr(`\r${renderBar(this.#label, received, expected, rate)}\u001b[K`);
      this.#drawn = true;
      return;
    }
    const quarter = expected > 0 ? Math.floor((received / expected) * 4) : 0;
    if (quarter === this.#lastQuarter) return;
    this.#lastQuarter = quarter;
    this.#environment.stderr(`${renderBar(this.#label, received, expected)}\n`);
  }

  /** End the download, leaving its last line on the screen. */
  done(): void {
    if (this.#interactive && this.#drawn) this.#environment.stderr('\n');
    this.#drawn = false;
  }
}

/** `42 s`, `3 m 05 s`, `1 h 12 m`: a duration as a person reads it. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
}

export interface IndexProgressState {
  /** Files handled so far, and how many the run has (unknown until the walk is listed). */
  readonly done: number;
  readonly total: number | undefined;
  readonly embedded: number;
  readonly cards: number;
  readonly quarantined: number;
  /** Since the walk was listed: what the rate and the time left are measured over. */
  readonly elapsedMs: number;
  /** The file being embedded and for how long, when it is taking a while. */
  readonly embedding?: { readonly path: string; readonly forMs: number } | undefined;
}

/**
 * One line of an index run:
 * `indexing [████████░░░░]  34%  1,234/3,600 files · 210 embedded (1,820 cards) · 41/s · ~58 s left`.
 * Cut to `width` from the right, the file being embedded first, so it never wraps.
 */
export function renderIndexBar(state: IndexProgressState, width?: number): string {
  const n = (value: number) => value.toLocaleString('en-US');
  const parts: string[] = [];
  if (state.total === undefined) {
    parts.push(`indexing: listing files…`);
  } else {
    const share = state.total === 0 ? 1 : Math.min(1, state.done / state.total);
    const filled = Math.round(share * BAR_WIDTH);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
    parts.push(
      `indexing: [${bar}] ${String(Math.floor(share * 100)).padStart(3)}%  ${n(state.done)}/${n(state.total)} files`,
    );
  }
  if (state.embedded > 0) parts.push(`${n(state.embedded)} embedded (${n(state.cards)} cards)`);
  if (state.quarantined > 0) parts.push(`${n(state.quarantined)} quarantined`);
  const seconds = state.elapsedMs / 1000;
  // Too early, and the rate is noise.
  if (state.total !== undefined && seconds >= 2 && state.done > 0) {
    const rate = state.done / seconds;
    parts.push(`${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} files/s`);
    if (state.done < state.total) {
      parts.push(`~${formatDuration(((state.total - state.done) / rate) * 1000)} left`);
    }
  }
  const line = parts.join(' · ');
  const current = state.embedding
    ? ` · embedding ${state.embedding.path} (${formatDuration(state.embedding.forMs)})`
    : '';
  if (width === undefined || width <= 0) return `${line}${current}`;
  // One column spare: writing into the last one wraps on some terminals.
  const room = width - 1;
  if (line.length + current.length <= room) return `${line}${current}`;
  if (line.length <= room) return line;
  return `${line.slice(0, Math.max(0, room - 1))}…`;
}
