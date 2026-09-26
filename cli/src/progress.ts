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
