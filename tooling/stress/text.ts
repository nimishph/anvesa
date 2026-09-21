/** Small text helpers, so the few places that cut a string to a display width say why. */

/** A commit hash as people write it: a display width, not a limit on any data. */
export function short(hash: string): string {
  // biome-ignore lint/plugin: the short form of a hash is a display width; the full hash is kept everywhere it matters
  return hash.slice(0, 10);
}

/** Every element but the last. */
export function withoutLast<T>(items: readonly T[]): T[] {
  return items.slice(0, items.length - 1);
}

/** The last `count` of a list (all of it when there are fewer). */
export function lastOf<T>(items: readonly T[], count: number): T[] {
  return items.slice(Math.max(0, items.length - count));
}

/** The last `count` lines of some output, for an error message that says where it stopped. */
export function tailLines(text: string, count: number): string {
  return lastOf(text.split('\n'), count).join(' | ');
}

/** `2026-09-21` from an ISO timestamp. */
export function dayOf(iso: string): string {
  return iso.split('T')[0] ?? iso;
}
