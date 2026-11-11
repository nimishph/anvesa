import { closeSync, openSync, rmSync, statSync } from 'node:fs';

/**
 * Take the lock file `path` (created exclusively), waiting up to `waitMs`; a lock older than
 * `staleMs` was left by a run that died and is taken over. Returns its release, or `undefined` if
 * another run still holds it. Used for the small per-user files several anvesa processes (agents
 * run commands side by side) read, change and write back.
 */
export function lockFile(path: string, waitMs = 250, staleMs = 5_000): (() => void) | undefined {
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'));
      return () => rmSync(path, { force: true });
    } catch (failure) {
      if ((failure as { readonly code?: unknown }).code !== 'EEXIST') throw failure;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true });
    } catch {
      // Released between the two calls: try again at once.
      continue;
    }
    if (Date.now() >= deadline) return undefined;
    Atomics.wait(pause, 0, 0, 5);
  }
}
