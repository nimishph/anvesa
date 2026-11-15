import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GENERATED_FILE,
  MODELS_DIRECTORY,
  modelFiles,
  renderModelIndex,
} from '../scripts/gen-model-index.ts';
import { ModelConfigError } from './errors.ts';
import { MODEL_CONFIGS } from './models.generated.ts';
import {
  BUILTIN_MODELS,
  MODEL_CATALOG,
  modelFamily,
  OPEN_MODELS,
  RETIRED_MODELS,
} from './models.ts';
import { buildRegistry, parseModelConfig, parseModelSpec } from './registry.ts';

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', 'schemas', 'model.v1.json'), 'utf8'),
) as { properties: Record<string, unknown>; required: string[] };

function config(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MODELS_DIRECTORY, file), 'utf8')) as Record<string, unknown>;
}

describe('model registry', () => {
  test('the generated index matches the models folder', () => {
    // Adding a model is: add a file, run bun run embedder/scripts/gen-model-index.ts.
    const onDisk = readFileSync(GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(renderModelIndex(modelFiles()));
  });

  test('every config is named after its id, and keeps to the schema', () => {
    for (const file of modelFiles()) {
      const raw = config(file);
      expect(`${raw.id}.json`).toBe(file);
      for (const key of Object.keys(raw)) expect(Object.keys(schema.properties)).toContain(key);
      for (const key of schema.required) expect(Object.keys(raw)).toContain(key);
    }
  });

  test('the catalog is built from the configs', () => {
    expect(MODEL_CATALOG.map((spec) => spec.id)).toEqual([
      'anvesa-code-150m',
      'anvesa-code-400m',
      'anvesa-code-1b',
      'gte-modernbert-base',
    ]);
    expect(BUILTIN_MODELS.low.id).toBe('anvesa-code-150m');
    expect(OPEN_MODELS.map((spec) => spec.id)).toEqual(['gte-modernbert-base']);
    expect(modelFamily('anvesa-code-400m')).toBe('anvesa-code');
    expect(modelFamily('gte-modernbert-base')).toBe('open');
    expect(modelFamily('my-model')).toBe('custom');
    expect(RETIRED_MODELS['all-MiniLM-L6-v2']).toBe('anvesa-code-150m');
    expect(RETIRED_MODELS['bge-large-en-v1.5']).toBe('anvesa-code-400m');
  });

  test('a config with a wrong field names the file and the field', () => {
    const raw = { ...config('anvesa-code-150m.json'), pooling: 'max' };
    expect(() => parseModelConfig(raw, 'x.json')).toThrow(ModelConfigError);
    expect(() => parseModelConfig(raw, 'x.json')).toThrow(/x\.json.*pooling must be one of/);
  });

  test('an unknown field or a bad checksum is refused', () => {
    const base = config('gte-modernbert-base.json');
    expect(() => parseModelConfig({ ...base, size: 1 }, 'g.json')).toThrow(/unknown field size/);
    const model = { ...(base.model as object), sha256: 'abc' };
    expect(() => parseModelSpec({ ...base, model }, 'g.json')).toThrow(/sha256 must be 64/);
  });

  test('an open model with a tier, or an anvesa-code model without one, is refused', () => {
    expect(() =>
      parseModelConfig({ ...config('gte-modernbert-base.json'), tier: 'low' }, 'g.json'),
    ).toThrow(/an open model has no tier/);
    const { tier: _tier, ...noTier } = config('anvesa-code-1b.json');
    expect(() => parseModelConfig(noTier, '1b.json')).toThrow(/needs a tier/);
  });

  test('a catalog with a duplicate id, a tier filled twice, or a tier missing is refused', () => {
    const entries = [...MODEL_CONFIGS];
    const first = entries[0];
    if (!first) throw new ModelConfigError('test', 'no configs');
    expect(() => buildRegistry([...entries, first])).toThrow(/is used twice/);
    const twice = { ...config('anvesa-code-400m.json'), id: 'other', retired: [] };
    expect(() => buildRegistry([...entries, { source: 'o.json', config: twice }])).toThrow(
      /tier medium already has/,
    );
    const noHigh = entries.filter((entry) => !entry.source.endsWith('anvesa-code-1b.json'));
    expect(() => buildRegistry(noHigh)).toThrow(/no anvesa-code model for tier high/);
  });
});
