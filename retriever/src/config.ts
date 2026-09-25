import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProjectConfigError } from './errors.ts';

/** Where a project's configuration lives, relative to its root. */
export const PROJECT_CONFIG_PATH = '.anvesa/config.json';

export interface ChannelConfig {
  /** Off, the channel is neither indexed nor searched. Default on. */
  readonly enabled: boolean;
  /** How much the channel counts in a fused search. Default 1. */
  readonly weight: number;
  /**
   * A module, relative to the project root, that exports the channel's transformer as its default
   * export and may export a `source` for records that are not files. Built-in channels have none.
   */
  readonly module: string | undefined;
  /**
   * SHA-256 (hex) of the module file. When set, the module is loaded only if its bytes still hash
   * to this. `anvesa channel pin <name>` writes it.
   */
  readonly sha256?: string | undefined;
}

export interface ProjectConfig {
  /** A built-in model id. Unset means the tier the machine suits, among those installed. */
  readonly model: string | undefined;
  readonly channels: Readonly<Record<string, ChannelConfig>>;
  /** The rank constant of fusion. Unset uses the standard one. */
  readonly fusionK: number | undefined;
  /**
   * Keep the index in one database per fragment of `.anvesa/fragments.json`, instead of one
   * database. For repositories big enough that one file is a burden; off by default.
   */
  readonly fragments: boolean;
  /** Refuse to load a channel module that is not pinned by `sha256`. */
  readonly requireChecksums?: true;
}

export function defaultProjectConfig(): ProjectConfig {
  return { model: undefined, channels: {}, fusionK: undefined, fragments: false };
}

/** Read `.anvesa/config.json`. A project without one uses the defaults. */
export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const path = join(root, PROJECT_CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (failure) {
    if ((failure as { code?: unknown } | null)?.code === 'ENOENT') return defaultProjectConfig();
    throw new ProjectConfigError(path, 'file', 'it cannot be read', { cause: failure });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (failure) {
    throw new ProjectConfigError(path, 'file', 'it is not JSON', { cause: failure });
  }
  return validateProjectConfig(raw, path);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const CHANNEL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Check a parsed config, naming the field of the first thing that is wrong. */
export function validateProjectConfig(raw: unknown, path = PROJECT_CONFIG_PATH): ProjectConfig {
  const fail = (location: string, problem: string): never => {
    throw new ProjectConfigError(path, location, problem);
  };
  if (!isRecord(raw)) return fail('$', 'it must be an object');
  for (const key of Object.keys(raw)) {
    if (!['model', 'channels', 'fusion', 'indexing', 'security'].includes(key))
      fail(key, 'is not a known setting');
  }

  const model = raw.model;
  if (model !== undefined && typeof model !== 'string') fail('model', 'must be a model id');

  const channels: Record<string, ChannelConfig> = {};
  if (raw.channels !== undefined) {
    if (!isRecord(raw.channels)) fail('channels', 'must be an object of channel settings');
    for (const [name, value] of Object.entries(raw.channels as Record<string, unknown>)) {
      const at = `channels.${name}`;
      if (!CHANNEL_NAME.test(name)) fail(at, 'a channel name is lowercase words joined by "-"');
      if (!isRecord(value)) {
        fail(at, 'must be an object');
        continue;
      }
      for (const key of Object.keys(value)) {
        if (!['enabled', 'weight', 'module', 'sha256'].includes(key))
          fail(`${at}.${key}`, 'is not a known setting');
      }
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
        fail(`${at}.enabled`, 'must be true or false');
      }
      if (
        value.weight !== undefined &&
        (typeof value.weight !== 'number' || !Number.isFinite(value.weight) || value.weight < 0)
      ) {
        fail(`${at}.weight`, 'must be a number of at least 0');
      }
      if (value.module !== undefined && typeof value.module !== 'string') {
        fail(`${at}.module`, 'must be a path');
      }
      if (
        value.sha256 !== undefined &&
        (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256))
      ) {
        fail(`${at}.sha256`, 'must be 64 lowercase hex digits (a SHA-256)');
      }
      channels[name] = {
        enabled: (value.enabled as boolean | undefined) ?? true,
        weight: (value.weight as number | undefined) ?? 1,
        module: value.module as string | undefined,
        ...(value.sha256 === undefined ? {} : { sha256: value.sha256 as string }),
      };
    }
  }

  let fusionK: number | undefined;
  if (raw.fusion !== undefined) {
    if (!isRecord(raw.fusion)) fail('fusion', 'must be an object');
    const k = (raw.fusion as Record<string, unknown>).k;
    if (k !== undefined && (typeof k !== 'number' || !Number.isFinite(k) || k <= 0)) {
      fail('fusion.k', 'must be a positive number');
    }
    fusionK = k as number | undefined;
  }
  let fragments = false;
  if (raw.indexing !== undefined) {
    if (!isRecord(raw.indexing)) fail('indexing', 'must be an object');
    const indexing = raw.indexing as Record<string, unknown>;
    for (const key of Object.keys(indexing)) {
      if (key !== 'fragments') fail(`indexing.${key}`, 'is not a known setting');
    }
    if (
      indexing.fragments !== undefined &&
      indexing.fragments !== 'on' &&
      indexing.fragments !== 'off'
    ) {
      fail('indexing.fragments', 'must be "on" or "off"');
    }
    fragments = indexing.fragments === 'on';
  }
  let requireChecksums = false;
  if (raw.security !== undefined) {
    if (!isRecord(raw.security)) fail('security', 'must be an object');
    const security = raw.security as Record<string, unknown>;
    for (const key of Object.keys(security)) {
      if (key !== 'requireChecksums') fail(`security.${key}`, 'is not a known setting');
    }
    if (security.requireChecksums !== undefined && typeof security.requireChecksums !== 'boolean') {
      fail('security.requireChecksums', 'must be true or false');
    }
    requireChecksums = security.requireChecksums === true;
  }
  return {
    model: model as string | undefined,
    channels,
    fusionK,
    fragments,
    ...(requireChecksums ? { requireChecksums: true as const } : {}),
  };
}

/** Write `.anvesa/config.json`, leaving out whatever is the default. */
export async function writeProjectConfig(root: string, config: ProjectConfig): Promise<void> {
  const path = join(root, PROJECT_CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  const raw = {
    ...(config.model === undefined ? {} : { model: config.model }),
    channels: Object.fromEntries(
      Object.entries(config.channels).map(([name, channel]) => [
        name,
        {
          ...(channel.enabled ? {} : { enabled: false }),
          ...(channel.weight === 1 ? {} : { weight: channel.weight }),
          ...(channel.module === undefined ? {} : { module: channel.module }),
          ...(channel.sha256 === undefined ? {} : { sha256: channel.sha256 }),
        },
      ]),
    ),
    ...(config.fusionK === undefined ? {} : { fusion: { k: config.fusionK } }),
    ...(config.fragments ? { indexing: { fragments: 'on' } } : {}),
    ...(config.requireChecksums ? { security: { requireChecksums: true } } : {}),
  };
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}
