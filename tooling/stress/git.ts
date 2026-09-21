/**
 * The bits of git and GitHub the stress test needs: get a repository at an exact commit, and read
 * what its history says about how it was written.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StressError } from './manifest.ts';

interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export async function spawnText(cmd: readonly string[], cwd?: string): Promise<Ran> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: [...cmd],
      stdout: 'pipe',
      stderr: 'pipe',
      ...(cwd ? { cwd } : {}),
    });
  } catch (failure) {
    throw new StressError(`${cmd[0]} would not start`, { cause: failure, context: { cmd } });
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const ran = await spawnText(['git', ...args], cwd);
  if (ran.code !== 0) {
    throw new StressError(`git ${args.join(' ')} failed in ${cwd}: ${ran.stderr.trim()}`, {
      context: { cwd, args, code: ran.code },
    });
  }
  return ran.stdout;
}

/** `gh api` for a path, parsed. */
export async function ghApi<T>(path: string): Promise<T> {
  const ran = await spawnText(['gh', 'api', path]);
  if (ran.code !== 0) {
    throw new StressError(`gh api ${path} failed: ${ran.stderr.trim()}`, {
      context: { path, code: ran.code },
    });
  }
  try {
    return JSON.parse(ran.stdout) as T;
  } catch (failure) {
    throw new StressError(`gh api ${path} did not answer with JSON`, { cause: failure });
  }
}

export const cloneDirectory = (reposRoot: string, id: string): string =>
  join(reposRoot, id.replace('/', '__'));

/**
 * The repository at `ref` (or its default branch tip), cloned without file contents first so the
 * whole history is there for measuring and only the checked-out files are downloaded. Returns the
 * commit that is checked out.
 */
export async function checkout(
  reposRoot: string,
  id: string,
  ref: string | undefined,
  scope?: string,
): Promise<{ readonly directory: string; readonly commit: string; readonly cloned: boolean }> {
  const directory = cloneDirectory(reposRoot, id);
  let cloned = false;
  if (!existsSync(join(directory, '.git'))) {
    mkdirSync(reposRoot, { recursive: true });
    const url = `https://github.com/${id}.git`;
    const ran = await spawnText([
      'git',
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--quiet',
      url,
      directory,
    ]);
    if (ran.code !== 0) {
      throw new StressError(`Could not clone ${url}: ${ran.stderr.trim()}`, { context: { id } });
    }
    cloned = true;
  }
  if (ref !== undefined) {
    const have = await spawnText(['git', 'cat-file', '-e', `${ref}^{commit}`], directory);
    if (have.code !== 0) await git(directory, 'fetch', '--quiet', 'origin', ref);
  } else {
    await git(directory, 'fetch', '--quiet', 'origin');
  }
  // A scoped repository is checked out only where it is tested: a huge one stays affordable.
  if (scope === undefined) await git(directory, 'sparse-checkout', 'disable');
  else await git(directory, 'sparse-checkout', 'set', '--cone', scope);
  const target = ref ?? (await git(directory, 'rev-parse', 'origin/HEAD')).trim();
  await git(directory, 'checkout', '--quiet', '--force', '--detach', target);
  const commit = (await git(directory, 'rev-parse', 'HEAD')).trim();
  return { directory, commit, cloned };
}

/** Files git tracks at the checked-out commit. */
export async function trackedFiles(directory: string): Promise<string[]> {
  const listing = await git(directory, 'ls-files', '-z');
  return listing.split('\0').filter((path) => path !== '');
}

const AI_TRAILER =
  /co-authored-by:[^\n]*(claude|copilot|cursor|codex|devin|aider|gemini|openai|windsurf)|generated (?:with|by)[^\n]*(claude|copilot|cursor|codex|gemini)|🤖 generated/i;

/** Files that say an assistant is (or was) part of how the repository is worked on. */
export const AGENT_MARKERS =
  /(^|\/)(CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|copilot-instructions\.md|\.claude\/|\.cursor\/rules\/)/;

export interface History {
  readonly firstCommit: string;
  readonly lastCommit: string;
  readonly commits: number;
  /** Commits since `since`, and how many of those carry an assistant's mark. */
  readonly recent: number;
  readonly recentAssisted: number;
  readonly since: string;
}

/**
 * What history says about the age of the code and the part assistants have played, over the
 * commits since `since` (an ISO date the caller chooses).
 */
export async function history(directory: string, since: string): Promise<History> {
  const count = Number((await git(directory, 'rev-list', '--count', 'HEAD')).trim());
  const roots = (await git(directory, 'log', '--max-parents=0', '--format=%aI')).trim().split('\n');
  const last = (await git(directory, 'log', '-1', '--format=%aI')).trim();
  const messages = await git(directory, 'log', `--since=${since}`, '--format=%B%x00');
  const recent = messages.split('\0').filter((message) => message.trim() !== '');
  return {
    firstCommit: [...roots].sort()[0] ?? last,
    lastCommit: last,
    commits: count,
    recent: recent.length,
    recentAssisted: recent.filter((message) => AI_TRAILER.test(message)).length,
    since,
  };
}
