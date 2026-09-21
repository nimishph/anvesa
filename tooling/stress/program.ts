/**
 * The code-lens the stress test runs: a local build, so what is measured is the program a person
 * would run, not a registry's copy of it. Its identity goes into every run record so a change in
 * the numbers can be tied to a change in the program.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnText } from './git.ts';
import { StressError } from './manifest.ts';

export interface Program {
  readonly path: string;
  readonly version: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly sha256: string;
}

const EXECUTABLE = process.platform === 'win32' ? 'code-lens.exe' : 'code-lens';
const BUILD = new RegExp(`^code-lens-(\\d+(?:\\.\\d+)*)-${process.platform}-${process.arch}$`);

const parts = (version: string): number[] => version.split('.').map(Number);
function newerFirst(a: string, b: string): number {
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The newest local build in this checkout's `dist/`. */
function newestBuild(): string | undefined {
  const dist = resolve(import.meta.dir, '..', '..', 'dist');
  if (!existsSync(dist)) return undefined;
  const builds = readdirSync(dist)
    .flatMap((name) => {
      const match = BUILD.exec(name);
      return match?.[1] ? [{ name, version: match[1] }] : [];
    })
    .sort((a, b) => newerFirst(a.version, b.version));
  return builds.map((build) => join(dist, build.name, EXECUTABLE)).find((path) => existsSync(path));
}

/** `--program`, else `CODE_LENS_BIN`, else the newest build here. */
export async function resolveProgram(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Program> {
  const path = explicit ?? (env.CODE_LENS_BIN || undefined) ?? newestBuild();
  if (path === undefined) {
    throw new StressError('There is no local code-lens build to test.', {
      hint: 'Build one with `bun run package` in the code-lens checkout, or pass --program <path>.',
    });
  }
  if (!existsSync(path)) {
    throw new StressError(`The code-lens program ${path} does not exist.`, { context: { path } });
  }
  const ran = await spawnText([path, '--version']);
  if (ran.code !== 0) {
    throw new StressError(`${path} --version exited with ${ran.code}: ${ran.stderr.trim()}`);
  }
  const stat = statSync(path);
  return {
    path: resolve(path),
    version: ran.stdout.trim().replace(/^code-lens\s+/, ''),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
