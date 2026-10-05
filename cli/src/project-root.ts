import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Files in `.anvesa/` that only a project has; any one of them marks its directory as a root. */
const PROJECT_MARKERS = ['config.json', 'workspace.json', 'index.db', 'fragments.json'] as const;

/** Whether `directory/.anvesa` holds a project (and is not the per-user state directory). */
export function isProjectRoot(
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const state = join(resolve(directory), '.anvesa');
  return (
    state !== userStateDirectory(env) &&
    PROJECT_MARKERS.some((marker) => existsSync(join(state, marker)))
  );
}

function userStateDirectory(env: Readonly<Record<string, string | undefined>>): string {
  return resolve(env.ANVESA_HOME ?? join(env.HOME ?? homedir(), '.anvesa'));
}

/**
 * The project a command run in `start` belongs to: the nearest directory, `start` or above, whose
 * `.anvesa/` holds a project file, the way git finds `.git`. None found, it is `start` itself.
 * The per-user `.anvesa` (`ANVESA_HOME`, else `~/.anvesa`) holds models and grammars, not a
 * project, so it never makes the home directory a root.
 */
export function findProjectRoot(
  start: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  let directory = resolve(start);
  for (;;) {
    if (isProjectRoot(directory, env)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(start);
    directory = parent;
  }
}
