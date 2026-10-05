import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';

/**
 * A `--scope` as a test on indexed paths: the path itself, or anything under it as a whole
 * segment (`src` holds `src/a.ts`, not `src2/a.ts`). Paths are relative to the project root with
 * `/` between segments, as the index stores them; `\` is read as `/` and `./` and trailing `/` are
 * dropped. `undefined` for no scope, or for `.`, which is the whole project.
 *
 * It only filters what is already indexed, so it reads nothing from disk; but a scope that could
 * never match (absolute, `..`, a NUL) is refused rather than quietly returning nothing.
 */
export function pathScope(
  scope: string | undefined,
  name = 'scope',
): ((path: string) => boolean) | undefined {
  if (scope === undefined) return undefined;
  const segments = scope
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  if (
    scope.trim() === '' ||
    scope.includes('\0') ||
    /^([/\\]|[A-Za-z]:)/.test(scope) ||
    segments.includes('..')
  ) {
    throw new InvalidArgumentError(
      name,
      'a path relative to the project root, without ".." (e.g. src/api)',
      scope,
    );
  }
  if (segments.length === 0) return undefined;
  const prefix = segments.join('/');
  return (path) => path === prefix || path.startsWith(`${prefix}/`);
}

/** Both tests, where both are given. */
export function bothScopes(
  a: ((path: string) => boolean) | undefined,
  b: ((path: string) => boolean) | undefined,
): ((path: string) => boolean) | undefined {
  if (!a) return b;
  if (!b) return a;
  return (path) => a(path) && b(path);
}
