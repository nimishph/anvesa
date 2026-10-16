import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';

/**
 * Open-source repositories the real-world benchmark runs on, each pinned to a commit so every run
 * sees the same code. They are fetched into `eval/fixtures/` (ignored by git) by `bun run
 * eval:fixtures`, never committed.
 */
export interface Fixture {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly commit: string;
  readonly license: string;
}

const EVAL_ROOT = resolve(import.meta.dir, '..');
export const FIXTURES_DIRECTORY = join(EVAL_ROOT, 'fixtures');

export function loadFixtures(): readonly Fixture[] {
  const manifest = JSON.parse(readFileSync(join(EVAL_ROOT, 'fixtures.json'), 'utf8')) as {
    readonly repositories: readonly Fixture[];
  };
  return manifest.repositories;
}

export function fixturePath(fixture: Fixture): string {
  return join(FIXTURES_DIRECTORY, fixture.name);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new InvalidArgumentError(`git ${args.join(' ')}`, 'to succeed', err.trim() || code);
  }
  return out.trim();
}

/** The commit a fixture's checkout is at, or undefined when it is not there. */
export async function fixtureCommit(fixture: Fixture): Promise<string | undefined> {
  const path = fixturePath(fixture);
  if (!existsSync(join(path, '.git'))) return undefined;
  return git(path, 'rev-parse', 'HEAD');
}

/** Whether a fixture is checked out at its pinned commit. */
export async function fixtureReady(fixture: Fixture): Promise<boolean> {
  return (await fixtureCommit(fixture)) === fixture.commit;
}

/** Fetch only the pinned commit and check it out. A checkout already there is moved to it. */
export async function fetchFixture(fixture: Fixture): Promise<void> {
  const path = fixturePath(fixture);
  mkdirSync(path, { recursive: true });
  if (!existsSync(join(path, '.git'))) {
    await git(path, 'init', '--quiet');
    await git(path, 'remote', 'add', 'origin', fixture.url);
  }
  await git(path, 'fetch', '--quiet', '--depth', '1', 'origin', fixture.commit);
  await git(path, 'checkout', '--quiet', '--detach', fixture.commit);
}

if (import.meta.main) {
  for (const fixture of loadFixtures()) {
    if (await fixtureReady(fixture)) {
      process.stdout.write(`${fixture.name}: already at ${fixture.commit}\n`);
      continue;
    }
    process.stdout.write(`${fixture.name}: fetching ${fixture.url} @ ${fixture.commit}\n`);
    await fetchFixture(fixture);
  }
}
