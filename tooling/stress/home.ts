/**
 * Where the stress test keeps things: the manifest, the clones and the record of every run. Outside
 * any repository (`CODE_LENS_STRESS_HOME`, default `~/.code-lens/stress`), so none of it is ever
 * committed and clones do not sit inside the project being developed.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest, type Manifest, parseManifest, StressError } from './manifest.ts';
import type { RunRecord } from './measure.ts';

export interface StressHome {
  readonly root: string;
  readonly manifest: string;
  readonly repos: string;
  readonly runs: string;
}

export function stressHome(env: NodeJS.ProcessEnv = process.env): StressHome {
  const root = env.CODE_LENS_STRESS_HOME ?? join(homedir(), '.code-lens', 'stress');
  return {
    root,
    manifest: join(root, 'manifest.json'),
    repos: join(root, 'repos'),
    runs: join(root, 'runs'),
  };
}

/** Write a file so that a reader never sees half of it. */
function writeAtomically(path: string, text: string): void {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, text);
  renameSync(staging, path);
}

export function readManifest(home: StressHome): Manifest {
  if (!existsSync(home.manifest)) return emptyManifest();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(home.manifest, 'utf8'));
  } catch (failure) {
    throw new StressError(`${home.manifest} is not valid JSON`, { cause: failure });
  }
  return parseManifest(raw, home.manifest);
}

export function writeManifest(home: StressHome, manifest: Manifest): void {
  mkdirSync(home.root, { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(manifest.repos).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeAtomically(home.manifest, `${JSON.stringify({ version: 1, repos: sorted }, null, 2)}\n`);
}

export function writeRun(home: StressHome, run: RunRecord): string {
  mkdirSync(home.runs, { recursive: true });
  const path = join(home.runs, `${run.id}.json`);
  writeAtomically(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

/** Every recorded run, oldest first. A run file that cannot be read is an error, not a gap. */
export function readRuns(home: StressHome): RunRecord[] {
  if (!existsSync(home.runs)) return [];
  return readdirSync(home.runs)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(home.runs, name);
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
      } catch (failure) {
        throw new StressError(`The run record ${path} is not valid JSON`, { cause: failure });
      }
    });
}
