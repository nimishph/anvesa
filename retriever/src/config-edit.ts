import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lockFile } from '@cntxt-labs/anvesa-core';
import {
  CONFIG_SCHEMA_URL,
  PROJECT_CONFIG_PATH,
  type ProjectConfig,
  validateProjectConfig,
} from './config.ts';
import { ProjectConfigError } from './errors.ts';
import { isBuiltinChannel } from './retriever.ts';

/**
 * Editing `.anvesa/config.json` in place, for the dashboard's Settings view. The file is changed
 * key by key, not rewritten from the parsed config: whatever the editor does not touch (other
 * sections, key order, indentation, line endings) stays as the person wrote it. Every edit is
 * checked by the same validator `anvesa` loads the file with, under the file's lock, and against
 * the revision the editor read, so two editors cannot silently undo each other.
 */

/** The settings the editor changes. Absent: leave it. `null`: back to the default. */
export interface ConfigEdits {
  readonly model?: string | null;
  readonly fusionK?: number | null;
  /** Per channel. Only channels the project already has (built in, or added with `channel add`). */
  readonly channels?: Readonly<
    Record<string, { readonly enabled?: boolean; readonly weight?: number }>
  >;
  /** `indexing.ignore`: extra globs to skip. An empty list removes the key. */
  readonly ignore?: readonly string[];
  readonly telemetry?: { readonly enabled?: boolean; readonly show_notice?: boolean };
}

export interface ConfigFile {
  readonly path: string;
  readonly exists: boolean;
  /** The file as JSON, `{}` when there is none. */
  readonly raw: Record<string, unknown>;
  /** What an edit must name to be applied: a hash of the text that was read. */
  readonly revision: string;
  readonly config: ProjectConfig;
}

export interface ConfigEditResult extends ConfigFile {
  /** The settings that changed, by their place in the file (`model`, `channels.docs.weight`). */
  readonly changed: readonly string[];
  /** Of those, the ones the index does not reflect until `anvesa index` runs again. */
  readonly reindex: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const revisionOf = (text: string): string => createHash('sha256').update(text).digest('hex');

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (failure) {
    if ((failure as { readonly code?: unknown }).code === 'ENOENT') return undefined;
    throw new ProjectConfigError(path, '$', 'it could not be read', { cause: failure });
  }
}

function parse(path: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (failure) {
    throw new ProjectConfigError(path, '$', 'it is not valid JSON', { cause: failure });
  }
  if (!isObject(raw)) throw new ProjectConfigError(path, '$', 'it must be an object');
  return raw;
}

/** The project's config file as it is, with the revision an edit must name. */
export function readConfigFile(root: string): ConfigFile {
  const path = join(root, PROJECT_CONFIG_PATH);
  const text = readText(path);
  const raw = parse(path, text);
  return {
    path,
    exists: text !== undefined,
    raw,
    revision: revisionOf(text ?? ''),
    config: validateProjectConfig(raw, path),
  };
}

/** Set `key` in `object`, in place when it is there, else at the end. `undefined` removes it. */
function put(object: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete object[key];
  else object[key] = value;
}

/** `object[key]` as an object of its own (a copy), `{}` when absent. */
function section(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = object[key];
  return isObject(value) ? { ...value } : {};
}

/** Put `value` back as `object[key]`, or remove the key when it is empty. */
function putSection(
  object: Record<string, unknown>,
  key: string,
  value: Record<string, unknown>,
): void {
  put(object, key, Object.keys(value).length > 0 ? value : undefined);
}

function applyEdits(
  raw: Record<string, unknown>,
  edits: ConfigEdits,
  path: string,
): Record<string, unknown> {
  // $schema first, as `init` writes it, so an editor finds the schema.
  const next: Record<string, unknown> =
    '$schema' in raw ? { ...raw } : { $schema: CONFIG_SCHEMA_URL, ...raw };

  if (edits.model !== undefined) put(next, 'model', edits.model ?? undefined);

  if (edits.fusionK !== undefined) {
    const fusion = section(next, 'fusion');
    put(fusion, 'k', edits.fusionK ?? undefined);
    putSection(next, 'fusion', fusion);
  }

  if (edits.channels !== undefined) {
    const channels = section(next, 'channels');
    for (const [name, change] of Object.entries(edits.channels)) {
      if (!(name in channels) && !isBuiltinChannel(name)) {
        // A new channel needs its module and checksum: that is `anvesa channel add`.
        throw new ProjectConfigError(
          path,
          `channels.${name}`,
          'no such channel in this project (add one with anvesa channel add)',
        );
      }
      const channel = section(channels, name);
      // Defaults are left out, as `anvesa channel` writes them.
      if (change.enabled !== undefined) put(channel, 'enabled', change.enabled ? undefined : false);
      if (change.weight !== undefined)
        put(channel, 'weight', change.weight === 1 ? undefined : change.weight);
      channels[name] = channel;
    }
    put(next, 'channels', channels);
  }

  if (edits.ignore !== undefined) {
    const indexing = section(next, 'indexing');
    const globs = edits.ignore.map((glob) => glob.trim()).filter(Boolean);
    put(indexing, 'ignore', globs.length > 0 ? globs : undefined);
    putSection(next, 'indexing', indexing);
  }

  if (edits.telemetry !== undefined) {
    const current = next.telemetry;
    const telemetry: Record<string, unknown> =
      typeof current === 'boolean' ? { enabled: current } : section(next, 'telemetry');
    const { enabled, show_notice } = edits.telemetry;
    if (enabled !== undefined) put(telemetry, 'enabled', enabled ? undefined : false);
    if (show_notice !== undefined) put(telemetry, 'show_notice', show_notice ? undefined : false);
    putSection(next, 'telemetry', telemetry);
  }
  return next;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every leaf that differs between two JSON objects, by its dotted path. */
function differences(before: unknown, after: unknown, at = ''): string[] {
  // A section that appears or goes away is the leaves in it, not the section.
  if (before === undefined && isObject(after)) return differences({}, after, at);
  if (after === undefined && isObject(before)) return differences(before, {}, at);
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) => differences(before[key], after[key], at ? `${at}.${key}` : key));
  }
  return same(before, after) ? [] : [at];
}

/** Which changes the index does not reflect until it is built again. */
function needsReindex(change: string): boolean {
  return (
    change === 'model' || change === 'indexing.ignore' || /^channels\.[^.]+\.enabled$/.test(change)
  );
}

/** Keep the file's own indentation and line endings. */
function serialize(next: Record<string, unknown>, previous: string | undefined): string {
  const indent = previous ? (/^\{\r?\n([ \t]+)/.exec(previous)?.[1] ?? 2) : 2;
  const eol = previous?.includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(next, null, indent).replace(/\n/g, eol)}${eol}`;
}

/**
 * Apply `edits` to the project's config file, if it is still at `revision`. Nothing is written when
 * the result would not load, when another process holds the file's lock, or when the file changed
 * since it was read.
 */
export function editConfigFile(
  root: string,
  revision: string,
  edits: ConfigEdits,
): ConfigEditResult {
  const path = join(root, PROJECT_CONFIG_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const unlock = lockFile(`${path}.lock`);
  if (!unlock) {
    throw new ProjectConfigError(path, '$', 'another anvesa process is writing it; try again');
  }
  try {
    const text = readText(path);
    if (revisionOf(text ?? '') !== revision) {
      throw new ProjectConfigError(
        path,
        '$',
        'it changed since it was read; reload the settings and make the change again',
      );
    }
    const raw = parse(path, text);
    const next = applyEdits(raw, edits, path);
    const config = validateProjectConfig(next, path);
    const changed = differences(raw, next).filter((key) => key !== '$schema');
    const output = serialize(next, text);
    if (output !== text) {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, output, 'utf8');
      renameSync(temporary, path);
    }
    return {
      path,
      exists: true,
      raw: next,
      revision: revisionOf(output),
      config,
      changed,
      reindex: changed.filter(needsReindex),
    };
  } finally {
    unlock();
  }
}
