/**
 * The model registry: built-in encoders are described one JSON file each, in `embedder/models/`
 * (format: `schemas/model.v1.json`), and everything else (the catalog, the tiers, the open models)
 * is a view of those files.
 *
 * A compiled binary has no source folder to read at run time, so the files are imported by
 * `models.generated.ts`, which `embedder/scripts/gen-model-index.ts` writes. Adding a model is: add
 * a file, run the script. A test fails when the folder and the generated index disagree.
 */

import { ModelConfigError } from './errors.ts';
import type { CardForm, ModelFileSpec, ModelSpec, Pooling, Tier } from './model-spec.ts';

/** Where a built-in model comes from: anvesa's own encoders, or an open one used when named. */
export type BuiltinFamily = 'anvesa-code' | 'open';

/** One `embedder/models/<id>.json`: a model spec, the family it belongs to, and the ids it replaces. */
export interface ModelConfig {
  readonly family: BuiltinFamily;
  readonly spec: ModelSpec;
}

/** The views every caller uses, built once from the configs. */
export interface ModelRegistry {
  readonly configs: readonly ModelConfig[];
  /** anvesa's own encoders, one per tier. */
  readonly byTier: Readonly<Record<Tier, ModelSpec>>;
  readonly anvesaCode: readonly ModelSpec[];
  readonly open: readonly ModelSpec[];
}

const TIER_VALUES: readonly Tier[] = ['low', 'medium', 'high'];
const POOLING_VALUES: readonly Pooling[] = ['mean', 'cls'];
const CARD_FORM_VALUES: readonly CardForm[] = ['nopath'];
const FAMILY_VALUES: readonly BuiltinFamily[] = ['anvesa-code', 'open'];

const CONFIG_KEYS = new Set([
  '$schema',
  'id',
  'family',
  'tier',
  'repo',
  'revision',
  'model',
  'modelData',
  'tokenizer',
  'ranker',
  'dimensions',
  'maxTokens',
  'pooling',
  'cardForm',
  'paramsM',
  'license',
  'summary',
  'notes',
]);

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the fields of one config, and says which file and which field when one is wrong. */
class Reader {
  constructor(
    private readonly source: string,
    private readonly fields: Fields,
  ) {}

  fail(problem: string): never {
    throw new ModelConfigError(this.source, problem);
  }

  string(key: string): string {
    const value = this.fields[key];
    if (typeof value !== 'string' || value.length === 0) this.fail(`${key} must be a string`);
    return value;
  }

  optionalString(key: string): string | undefined {
    return this.fields[key] === undefined ? undefined : this.string(key);
  }

  integer(key: string): number {
    const value = this.fields[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.fail(`${key} must be a positive integer`);
    }
    return value;
  }

  optionalNumber(key: string): number | undefined {
    const value = this.fields[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !(value > 0)) this.fail(`${key} must be a positive number`);
    return value;
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const value = this.fields[key];
    const found = values.find((candidate) => candidate === value);
    if (found === undefined) this.fail(`${key} must be one of ${values.join(', ')}`);
    return found;
  }

  optionalOneOf<T extends string>(key: string, values: readonly T[]): T | undefined {
    return this.fields[key] === undefined ? undefined : this.oneOf(key, values);
  }

  file(key: string): ModelFileSpec {
    const value = this.fields[key];
    if (!isFields(value)) this.fail(`${key} must be an object with path, bytes and sha256`);
    const file = new Reader(`${this.source} ${key}`, value);
    for (const name of Object.keys(value)) {
      if (name !== 'path' && name !== 'bytes' && name !== 'sha256')
        file.fail(`unknown field ${name}`);
    }
    const sha256 = file.string('sha256');
    if (!/^[0-9a-f]{64}$/.test(sha256)) file.fail('sha256 must be 64 lowercase hex digits');
    return { path: file.string('path'), bytes: file.integer('bytes'), sha256 };
  }

  optionalFile(key: string): ModelFileSpec | undefined {
    return this.fields[key] === undefined ? undefined : this.file(key);
  }
}

/**
 * Check one model's configuration and give its spec. `source` names it in errors (a file name).
 * Built-in configs and a custom model's record both pass through here, so they share one set of
 * checks.
 */
export function parseModelSpec(raw: unknown, source: string): ModelSpec {
  if (!isFields(raw)) throw new ModelConfigError(source, 'it must be a JSON object');
  const read = new Reader(source, raw);
  const tier = read.optionalOneOf('tier', TIER_VALUES);
  const revision = read.optionalString('revision');
  const modelData = read.optionalFile('modelData');
  const ranker = read.optionalFile('ranker');
  const cardForm = read.optionalOneOf('cardForm', CARD_FORM_VALUES);
  const summary = read.optionalString('summary');
  return {
    id: read.string('id'),
    tier,
    repo: read.string('repo'),
    ...(revision === undefined ? {} : { revision }),
    model: read.file('model'),
    ...(modelData === undefined ? {} : { modelData }),
    tokenizer: read.file('tokenizer'),
    ...(ranker === undefined ? {} : { ranker }),
    dimensions: read.integer('dimensions'),
    maxTokens: read.integer('maxTokens'),
    pooling: read.oneOf('pooling', POOLING_VALUES),
    ...(cardForm === undefined ? {} : { cardForm }),
    paramsM: read.optionalNumber('paramsM'),
    license: read.string('license'),
    notes: read.string('notes'),
    ...(summary === undefined ? {} : { summary }),
  };
}

/** Check one `embedder/models/<id>.json`: its spec, plus what only a built-in model carries. */
export function parseModelConfig(raw: unknown, source: string): ModelConfig {
  const spec = parseModelSpec(raw, source);
  if (!isFields(raw)) throw new ModelConfigError(source, 'it must be a JSON object');
  const read = new Reader(source, raw);
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) read.fail(`unknown field ${key}`);
  }
  const family = read.oneOf('family', FAMILY_VALUES);
  if (family === 'anvesa-code' && spec.tier === undefined)
    read.fail('an anvesa-code model needs a tier');
  if (family === 'open' && spec.tier !== undefined) read.fail('an open model has no tier');
  if (spec.summary === undefined) read.fail('a built-in model needs a summary');
  return { family, spec };
}

/** The id a model config file may have: also its file name, so nothing that reaches a path. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Check a model config a person wrote: `~/.anvesa/models/<id>.json` or a project's
 * `.anvesa/models/<id>.json`. The same format and checks as a built-in one, less what only anvesa's
 * own catalog decides (`family`, `tier`), and its id must be the file's name.
 */
export function parseLocalModelConfig(raw: unknown, source: string, fileId: string): ModelSpec {
  const spec = parseModelSpec(raw, source);
  if (!isFields(raw)) throw new ModelConfigError(source, 'it must be a JSON object');
  const read = new Reader(source, raw);
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) read.fail(`unknown field ${key}`);
  }
  if (raw.family !== undefined) read.fail('family is for built-in models only');
  if (raw.tier !== undefined) read.fail('tier is for built-in models only');
  if (!MODEL_ID.test(spec.id)) read.fail('id must be letters, digits, ".", "_" or "-"');
  if (spec.id !== fileId) read.fail(`id ${spec.id} must match the file name (${fileId}.json)`);
  return spec;
}

/** Build the registry from the configs, and refuse a catalog that does not hold together. */
export function buildRegistry(
  entries: readonly { readonly source: string; readonly config: unknown }[],
): ModelRegistry {
  const configs = entries.map((entry) => parseModelConfig(entry.config, entry.source));
  const ids = new Set<string>();
  const byTier: Partial<Record<Tier, ModelSpec>> = {};
  for (const [index, config] of configs.entries()) {
    const source = entries[index]?.source ?? config.spec.id;
    if (ids.has(config.spec.id))
      throw new ModelConfigError(source, `id ${config.spec.id} is used twice`);
    ids.add(config.spec.id);
    const tier = config.spec.tier;
    if (config.family === 'anvesa-code' && tier !== undefined) {
      if (byTier[tier])
        throw new ModelConfigError(source, `tier ${tier} already has ${byTier[tier].id}`);
      byTier[tier] = config.spec;
    }
  }
  const low = byTier.low;
  const medium = byTier.medium;
  const high = byTier.high;
  if (!low || !medium || !high) {
    const missing = TIER_VALUES.filter((tier) => !byTier[tier]);
    throw new ModelConfigError(
      'embedder/models',
      `no anvesa-code model for tier ${missing.join(', ')}`,
    );
  }
  return {
    configs,
    byTier: { low, medium, high },
    anvesaCode: configs.filter((c) => c.family === 'anvesa-code').map((c) => c.spec),
    open: configs.filter((c) => c.family === 'open').map((c) => c.spec),
  };
}
