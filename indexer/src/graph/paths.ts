import { posix } from 'node:path';

/**
 * Path helpers for workspace-relative, `/`-separated paths. `''` is the workspace root. A path
 * that would leave the workspace (`../x` from the root) comes back as `undefined` from `join`,
 * because nothing outside the workspace is indexed.
 */

export function dirname(path: string): string {
  const parent = posix.dirname(path);
  return parent === '.' ? '' : parent;
}

/** Join and normalise. `undefined` when the result would be above the workspace root. */
export function join(...parts: string[]): string | undefined {
  const joined = posix.normalize(posix.join(...parts));
  if (joined === '.' || joined === './') return '';
  if (joined === '..' || joined.startsWith('../')) return undefined;
  return joined.endsWith('/') ? joined.slice(0, joined.length - 1) : joined;
}

export function extension(path: string): string {
  const name = posix.basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

export function withoutExtension(path: string): string {
  const ext = extension(path);
  return ext === '' ? path : path.slice(0, path.length - ext.length);
}

/** Whether `path` is `directory` or somewhere under it. */
export function isWithin(path: string, directory: string): boolean {
  return directory === '' || path === directory || path.startsWith(`${directory}/`);
}
