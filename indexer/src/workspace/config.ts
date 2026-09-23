import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceConfigError } from '../errors.ts';
import type { WorkspacePackage } from './discover.ts';

/** Where a project's workspace settings live, relative to the workspace root. */
export const CONFIG_PATH = '.anvesa/workspace.json';

export interface ConfiguredPackage {
  readonly name: string;
  readonly root: string;
  readonly dependsOn: readonly string[];
}

export interface WorkspaceConfig {
  /** Packages declared by hand. They win over anything discovery finds at the same directory. */
  readonly packages: readonly ConfiguredPackage[];
  /** Run the discovery adapters. Turn off to use only `packages`. */
  readonly discover: boolean;
  /** Restrict discovery to these adapters, in this order. `undefined` means all of them. */
  readonly adapters: readonly string[] | undefined;
  /** Extra ignore rules, outranking every ignore file. */
  readonly exclude: readonly string[];
  readonly nestedRepos: 'include' | 'skip';
  /** `undefined` means "match the platform's file system convention". */
  readonly caseInsensitive: boolean | undefined;
  readonly followSymlinks: boolean;
}

export function defaultConfig(): WorkspaceConfig {
  return {
    packages: [],
    discover: true,
    adapters: undefined,
    exclude: [],
    nestedRepos: 'include',
    caseInsensitive: undefined,
    followSymlinks: false,
  };
}

/** A configured package as the rest of the model sees it. */
export function toWorkspacePackage(configured: ConfiguredPackage): WorkspacePackage {
  return {
    name: configured.name,
    root: configured.root,
    kind: 'configured',
    manifest: undefined,
    dependsOn: configured.dependsOn,
  };
}

/** Load `.anvesa/workspace.json`. Absent is fine; present but wrong is an error naming the field. */
export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig | undefined> {
  const path = join(root, CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (failure) {
    if (
      typeof failure === 'object' &&
      failure !== null &&
      'code' in failure &&
      failure.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw new WorkspaceConfigError(CONFIG_PATH, '(file)', 'the file could not be read', {
      cause: failure,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (failure) {
    throw new WorkspaceConfigError(CONFIG_PATH, '(file)', 'the file is not valid JSON', {
      cause: failure,
    });
  }
  return validateWorkspaceConfig(raw, CONFIG_PATH);
}

const KNOWN_KEYS = new Set([
  'version',
  'packages',
  'discover',
  'adapters',
  'exclude',
  'nestedRepos',
  'caseInsensitive',
  'followSymlinks',
]);

export function validateWorkspaceConfig(raw: unknown, path = CONFIG_PATH): WorkspaceConfig {
  const bad = (location: string, problem: string): never => {
    throw new WorkspaceConfigError(path, location, problem);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return bad('(root)', 'expected an object');
  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) bad(key, `unknown setting (known: ${[...KNOWN_KEYS].join(', ')})`);
  }
  if (record.version !== undefined && record.version !== 1) bad('version', 'must be 1');

  const stringArray = (key: string, value: unknown): string[] => {
    if (!Array.isArray(value)) return bad(key, 'expected an array of strings');
    value.forEach((item, index) => {
      if (typeof item !== 'string' || item === '')
        bad(`${key}[${index}]`, 'expected a non-empty string');
    });
    return value as string[];
  };
  const boolean = (key: string, value: unknown): boolean => {
    if (typeof value !== 'boolean') return bad(key, 'expected true or false');
    return value;
  };

  const packages: ConfiguredPackage[] = [];
  if (record.packages !== undefined) {
    if (!Array.isArray(record.packages)) bad('packages', 'expected an array');
    for (const [index, entry] of (record.packages as unknown[]).entries()) {
      const where = `packages[${index}]`;
      if (typeof entry !== 'object' || entry === null) bad(where, 'expected an object');
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== 'string' || item.name === '') {
        bad(`${where}.name`, 'expected a non-empty string');
      }
      if (typeof item.root !== 'string') bad(`${where}.root`, 'expected a string');
      const root = (item.root as string)
        .replaceAll('\\', '/')
        .replace(/^\.?\//, '')
        .replace(/\/$/, '');
      if (root.split('/').includes('..')) bad(`${where}.root`, 'must stay inside the workspace');
      packages.push({
        name: item.name as string,
        root: root === '.' ? '' : root,
        dependsOn:
          item.dependsOn === undefined ? [] : stringArray(`${where}.dependsOn`, item.dependsOn),
      });
    }
  }

  let nestedRepos: 'include' | 'skip' = 'include';
  if (record.nestedRepos !== undefined) {
    if (record.nestedRepos !== 'include' && record.nestedRepos !== 'skip') {
      bad('nestedRepos', 'must be "include" or "skip"');
    }
    nestedRepos = record.nestedRepos as 'include' | 'skip';
  }

  return {
    packages,
    discover: record.discover === undefined ? true : boolean('discover', record.discover),
    adapters: record.adapters === undefined ? undefined : stringArray('adapters', record.adapters),
    exclude: record.exclude === undefined ? [] : stringArray('exclude', record.exclude),
    nestedRepos,
    caseInsensitive:
      record.caseInsensitive === undefined
        ? undefined
        : boolean('caseInsensitive', record.caseInsensitive),
    followSymlinks:
      record.followSymlinks === undefined
        ? false
        : boolean('followSymlinks', record.followSymlinks),
  };
}
