/**
 * The medha the stress test runs: a local build, so what is measured is the program a person
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

const EXECUTABLE = process.platform === 'win32' ? 'anvesa.exe' : 'anvesa';
/** A build folder: `anvesa-<version>-<platform>-<arch>`, the version possibly a prerelease. */
const BUILD = new RegExp(
  `^anvesa-(\\d+(?:\\.\\d+)*(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)-${process.platform}-${process.arch}$`,
);

/** The version a build folder name carries, or `undefined` when it is not this platform's build. */
export function buildVersion(name: string): string | undefined {
  return BUILD.exec(name)?.[1];
}

/**
 * Semver order, newest first: release numbers compared as numbers, then a release before any of
 * its prereleases (0.8.0 is newer than 0.8.0-alpha.1), then prerelease identifiers in turn,
 * numeric ones as numbers and below any word.
 */
export function newerFirst(a: string, b: string): number {
  const [aCore = '', aPre] = splitVersion(a);
  const [bCore = '', bPre] = splitVersion(b);
  const [left, right] = [aCore.split('.').map(Number), bCore.split('.').map(Number)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (aPre === undefined || bPre === undefined) {
    return aPre === bPre ? 0 : aPre === undefined ? -1 : 1;
  }
  const [leftIds, rightIds] = [aPre.split('.'), bPre.split('.')];
  for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i += 1) {
    const [l, r] = [leftIds[i], rightIds[i]];
    if (l === r) continue;
    // A longer list of identifiers is newer when the shared ones are equal.
    if (l === undefined) return 1;
    if (r === undefined) return -1;
    const [ln, rn] = [/^\d+$/.test(l), /^\d+$/.test(r)];
    if (ln && rn) return Number(r) - Number(l);
    if (ln !== rn) return ln ? 1 : -1;
    return r < l ? -1 : 1;
  }
  return 0;
}

function splitVersion(version: string): [string, string | undefined] {
  const dash = version.indexOf('-');
  return dash === -1 ? [version, undefined] : [version.slice(0, dash), version.slice(dash + 1)];
}

/** The newest local build in this checkout's `dist/`. */
function newestBuild(): string | undefined {
  const dist = resolve(import.meta.dir, '..', '..', 'dist');
  if (!existsSync(dist)) return undefined;
  const builds = readdirSync(dist)
    .flatMap((name) => {
      const version = buildVersion(name);
      return version ? [{ name, version }] : [];
    })
    .sort((a, b) => newerFirst(a.version, b.version));
  return builds.map((build) => join(dist, build.name, EXECUTABLE)).find((path) => existsSync(path));
}

/** `--program`, else `ANVESA_BIN`, else the newest build here. */
export async function resolveProgram(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Program> {
  const path = explicit ?? (env.ANVESA_BIN || undefined) ?? newestBuild();
  if (path === undefined) {
    throw new StressError('There is no local anvesa build to test.', {
      hint: 'Build one with `bun run package` in the anvesa checkout, or pass --program <path>.',
    });
  }
  if (!existsSync(path)) {
    throw new StressError(`The anvesa program ${path} does not exist.`, { context: { path } });
  }
  const ran = await spawnText([path, '--version']);
  if (ran.code !== 0) {
    throw new StressError(`${path} --version exited with ${ran.code}: ${ran.stderr.trim()}`);
  }
  const stat = statSync(path);
  return {
    path: resolve(path),
    version: ran.stdout.trim().replace(/^anvesa\s+/, ''),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
