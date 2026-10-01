import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProjectConfigError } from './errors.ts';

/** Where a project's configuration lives, relative to its root. */
export const PROJECT_CONFIG_PATH = '.anvesa/config.json';
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/nimishph/anvesa/main/schemas/config.v1.json';

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

export interface SearchTuningConfig {
  readonly defaultLimit?: number;
  readonly excludeLanes?: readonly string[];
  readonly minScore?: number;
  readonly collapse?: boolean;
}

export interface IndexingTuningConfig {
  readonly fragments?: 'on' | 'off';
  readonly ignore?: readonly string[];
  readonly maxFileSizeBytes?: number;
  readonly concurrency?: number;
  readonly embeddingBatchSize?: number;
}

export interface SyntaxTuningConfig {
  readonly stripComments?: boolean;
  readonly maxChunkLines?: number;
  readonly minChunkLines?: number;
}

export interface RedTeamTuningConfig {
  readonly maxCardsPerSource?: number;
  readonly quarantineOnSuspect?: boolean;
}

export interface ProjectConfig {
  readonly $schema?: string;
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
  readonly search?: SearchTuningConfig;
  readonly indexing?: IndexingTuningConfig;
  readonly syntax?: SyntaxTuningConfig;
  readonly redteam?: RedTeamTuningConfig;
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
    if (
      ![
        '$schema',
        'model',
        'channels',
        'fusion',
        'indexing',
        'security',
        'search',
        'syntax',
        'redteam',
      ].includes(key)
    )
      fail(key, 'is not a known setting');
  }

  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') {
    fail('$schema', 'must be a string URL');
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
    const fusion = raw.fusion as Record<string, unknown>;
    for (const key of Object.keys(fusion)) {
      if (key !== 'k') fail(`fusion.${key}`, 'is not a known setting');
    }
    const k = fusion.k;
    if (k !== undefined && (typeof k !== 'number' || !Number.isFinite(k) || k <= 0)) {
      fail('fusion.k', 'must be a positive number');
    }
    fusionK = k as number | undefined;
  }

  let fragments = false;
  let indexingConfig: IndexingTuningConfig | undefined;
  if (raw.indexing !== undefined) {
    if (!isRecord(raw.indexing)) fail('indexing', 'must be an object');
    const indexing = raw.indexing as Record<string, unknown>;
    for (const key of Object.keys(indexing)) {
      if (
        !['fragments', 'ignore', 'maxFileSizeBytes', 'concurrency', 'embeddingBatchSize'].includes(
          key,
        )
      ) {
        fail(`indexing.${key}`, 'is not a known setting');
      }
    }
    if (
      indexing.fragments !== undefined &&
      indexing.fragments !== 'on' &&
      indexing.fragments !== 'off'
    ) {
      fail('indexing.fragments', 'must be "on" or "off"');
    }
    fragments = indexing.fragments === 'on';

    if (indexing.ignore !== undefined) {
      if (!Array.isArray(indexing.ignore) || !indexing.ignore.every((g) => typeof g === 'string')) {
        fail('indexing.ignore', 'must be an array of glob strings');
      }
    }
    if (
      indexing.maxFileSizeBytes !== undefined &&
      (typeof indexing.maxFileSizeBytes !== 'number' ||
        !Number.isInteger(indexing.maxFileSizeBytes) ||
        indexing.maxFileSizeBytes <= 0)
    ) {
      fail('indexing.maxFileSizeBytes', 'must be a positive integer');
    }
    if (
      indexing.concurrency !== undefined &&
      (typeof indexing.concurrency !== 'number' ||
        !Number.isInteger(indexing.concurrency) ||
        indexing.concurrency <= 0)
    ) {
      fail('indexing.concurrency', 'must be a positive integer');
    }
    if (
      indexing.embeddingBatchSize !== undefined &&
      (typeof indexing.embeddingBatchSize !== 'number' ||
        !Number.isInteger(indexing.embeddingBatchSize) ||
        indexing.embeddingBatchSize <= 0)
    ) {
      fail('indexing.embeddingBatchSize', 'must be a positive integer');
    }
    indexingConfig = {
      ...(indexing.fragments !== undefined
        ? { fragments: indexing.fragments as 'on' | 'off' }
        : {}),
      ...(indexing.ignore !== undefined ? { ignore: indexing.ignore as string[] } : {}),
      ...(indexing.maxFileSizeBytes !== undefined
        ? { maxFileSizeBytes: indexing.maxFileSizeBytes as number }
        : {}),
      ...(indexing.concurrency !== undefined
        ? { concurrency: indexing.concurrency as number }
        : {}),
      ...(indexing.embeddingBatchSize !== undefined
        ? { embeddingBatchSize: indexing.embeddingBatchSize as number }
        : {}),
    };
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

  let search: SearchTuningConfig | undefined;
  if (raw.search !== undefined) {
    if (!isRecord(raw.search)) fail('search', 'must be an object');
    const s = raw.search as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!['defaultLimit', 'excludeLanes', 'minScore', 'collapse'].includes(key)) {
        fail(`search.${key}`, 'is not a known setting');
      }
    }
    if (
      s.defaultLimit !== undefined &&
      (typeof s.defaultLimit !== 'number' ||
        !Number.isInteger(s.defaultLimit) ||
        s.defaultLimit <= 0)
    ) {
      fail('search.defaultLimit', 'must be a positive integer');
    }
    if (s.excludeLanes !== undefined) {
      if (!Array.isArray(s.excludeLanes) || !s.excludeLanes.every((l) => typeof l === 'string')) {
        fail('search.excludeLanes', 'must be an array of lane names');
      }
    }
    if (
      s.minScore !== undefined &&
      (typeof s.minScore !== 'number' ||
        !Number.isFinite(s.minScore) ||
        s.minScore < 0 ||
        s.minScore > 1)
    ) {
      fail('search.minScore', 'must be a number between 0 and 1');
    }
    if (s.collapse !== undefined && typeof s.collapse !== 'boolean') {
      fail('search.collapse', 'must be a boolean');
    }
    search = {
      ...(s.defaultLimit !== undefined ? { defaultLimit: s.defaultLimit as number } : {}),
      ...(s.excludeLanes !== undefined
        ? { excludeLanes: s.excludeLanes as readonly string[] }
        : {}),
      ...(s.minScore !== undefined ? { minScore: s.minScore as number } : {}),
      ...(s.collapse !== undefined ? { collapse: s.collapse as boolean } : {}),
    };
  }

  let syntax: SyntaxTuningConfig | undefined;
  if (raw.syntax !== undefined) {
    if (!isRecord(raw.syntax)) fail('syntax', 'must be an object');
    const syn = raw.syntax as Record<string, unknown>;
    for (const key of Object.keys(syn)) {
      if (!['stripComments', 'maxChunkLines', 'minChunkLines'].includes(key)) {
        fail(`syntax.${key}`, 'is not a known setting');
      }
    }
    if (syn.stripComments !== undefined && typeof syn.stripComments !== 'boolean') {
      fail('syntax.stripComments', 'must be a boolean');
    }
    if (
      syn.maxChunkLines !== undefined &&
      (typeof syn.maxChunkLines !== 'number' ||
        !Number.isInteger(syn.maxChunkLines) ||
        syn.maxChunkLines <= 0)
    ) {
      fail('syntax.maxChunkLines', 'must be a positive integer');
    }
    if (
      syn.minChunkLines !== undefined &&
      (typeof syn.minChunkLines !== 'number' ||
        !Number.isInteger(syn.minChunkLines) ||
        syn.minChunkLines <= 0)
    ) {
      fail('syntax.minChunkLines', 'must be a positive integer');
    }
    if (
      syn.maxChunkLines !== undefined &&
      syn.minChunkLines !== undefined &&
      (syn.minChunkLines as number) > (syn.maxChunkLines as number)
    ) {
      fail('syntax.minChunkLines', 'cannot be greater than maxChunkLines');
    }
    syntax = {
      ...(syn.stripComments !== undefined ? { stripComments: syn.stripComments as boolean } : {}),
      ...(syn.maxChunkLines !== undefined ? { maxChunkLines: syn.maxChunkLines as number } : {}),
      ...(syn.minChunkLines !== undefined ? { minChunkLines: syn.minChunkLines as number } : {}),
    };
  }

  let redteam: RedTeamTuningConfig | undefined;
  if (raw.redteam !== undefined) {
    if (!isRecord(raw.redteam)) fail('redteam', 'must be an object');
    const rt = raw.redteam as Record<string, unknown>;
    for (const key of Object.keys(rt)) {
      if (!['maxCardsPerSource', 'quarantineOnSuspect'].includes(key)) {
        fail(`redteam.${key}`, 'is not a known setting');
      }
    }
    if (
      rt.maxCardsPerSource !== undefined &&
      (typeof rt.maxCardsPerSource !== 'number' ||
        !Number.isInteger(rt.maxCardsPerSource) ||
        rt.maxCardsPerSource <= 0)
    ) {
      fail('redteam.maxCardsPerSource', 'must be a positive integer');
    }
    if (rt.quarantineOnSuspect !== undefined && typeof rt.quarantineOnSuspect !== 'boolean') {
      fail('redteam.quarantineOnSuspect', 'must be a boolean');
    }
    redteam = {
      ...(rt.maxCardsPerSource !== undefined
        ? { maxCardsPerSource: rt.maxCardsPerSource as number }
        : {}),
      ...(rt.quarantineOnSuspect !== undefined
        ? { quarantineOnSuspect: rt.quarantineOnSuspect as boolean }
        : {}),
    };
  }

  return {
    ...(raw.$schema !== undefined ? { $schema: raw.$schema as string } : {}),
    model: model as string | undefined,
    channels,
    fusionK,
    fragments,
    ...(requireChecksums ? { requireChecksums: true as const } : {}),
    ...(search !== undefined && Object.keys(search).length > 0 ? { search } : {}),
    ...(indexingConfig !== undefined && Object.keys(indexingConfig).length > 0
      ? { indexing: indexingConfig }
      : {}),
    ...(syntax !== undefined && Object.keys(syntax).length > 0 ? { syntax } : {}),
    ...(redteam !== undefined && Object.keys(redteam).length > 0 ? { redteam } : {}),
  };
}

/** Write `.anvesa/config.json`, leaving out whatever is the default. */
export async function writeProjectConfig(root: string, config: ProjectConfig): Promise<void> {
  const path = join(root, PROJECT_CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  const raw: Record<string, unknown> = {
    ...(config.$schema !== undefined ? { $schema: config.$schema } : {}),
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
    ...(() => {
      const tuning = config.indexing
        ? Object.fromEntries(Object.entries(config.indexing).filter(([k]) => k !== 'fragments'))
        : {};
      const indexing = {
        ...(config.fragments ? { fragments: 'on' as const } : {}),
        ...tuning,
      };
      return Object.keys(indexing).length > 0 ? { indexing } : {};
    })(),
    ...(config.requireChecksums ? { security: { requireChecksums: true } } : {}),
    ...(config.search && Object.keys(config.search).length > 0 ? { search: config.search } : {}),
    ...(config.syntax && Object.keys(config.syntax).length > 0 ? { syntax: config.syntax } : {}),
    ...(config.redteam && Object.keys(config.redteam).length > 0
      ? { redteam: config.redteam }
      : {}),
  };
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}
