import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONFIG_SCHEMA_URL,
  loadProjectConfig,
  type ProjectConfig,
  validateProjectConfig,
  writeProjectConfig,
} from './config.ts';
import { ProjectConfigError } from './errors.ts';

const rootDir = resolve(import.meta.dir, '../..');
const schemaPath = join(rootDir, 'schemas', 'config.v1.json');

describe('config.v1.json Schema & IDE Autocomplete', () => {
  it('schema file exists and is valid JSON Schema Draft 2020-12', async () => {
    const raw = await readFile(schemaPath, 'utf8');
    const schema = JSON.parse(raw);

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
    expect(schema.title).toContain('Anvesa Project Configuration Schema');
    expect(schema.properties.$schema).toBeDefined();
    expect(schema.properties.model).toBeDefined();
    expect(schema.properties.channels).toBeDefined();
    expect(schema.properties.fusion).toBeDefined();
    expect(schema.properties.indexing).toBeDefined();
    expect(schema.properties.security).toBeDefined();
    expect(schema.properties.search).toBeDefined();
    expect(schema.properties.syntax).toBeDefined();
    expect(schema.properties.redteam).toBeDefined();
  });

  it('allows $schema in config without unknown key error', () => {
    const parsed = validateProjectConfig({
      $schema: CONFIG_SCHEMA_URL,
      model: 'test-model',
    });
    expect(parsed.$schema).toBe(CONFIG_SCHEMA_URL);
    expect(parsed.model).toBe('test-model');
  });

  it('validates search tuning block', () => {
    const parsed = validateProjectConfig({
      search: {
        defaultLimit: 50,
        excludeLanes: ['docs', 'structural'],
        minScore: 0.75,
        collapse: true,
      },
    });
    expect(parsed.search).toEqual({
      defaultLimit: 50,
      excludeLanes: ['docs', 'structural'],
      minScore: 0.75,
      collapse: true,
    });

    expect(() => validateProjectConfig({ search: { defaultLimit: 0 } })).toThrow(
      ProjectConfigError,
    );
    expect(() => validateProjectConfig({ search: { minScore: 1.5 } })).toThrow(ProjectConfigError);
    expect(() => validateProjectConfig({ search: { collapse: 'yes' } })).toThrow(
      ProjectConfigError,
    );
  });

  it('validates expanded indexing tuning block', () => {
    const parsed = validateProjectConfig({
      indexing: {
        fragments: 'on',
        ignore: ['**/dist/**', '**/*.generated.*'],
        maxFileSizeBytes: 1048576,
        concurrency: 4,
        embeddingBatchSize: 64,
      },
    });
    expect(parsed.fragments).toBe(true);
    expect(parsed.indexing).toEqual({
      fragments: 'on',
      ignore: ['**/dist/**', '**/*.generated.*'],
      maxFileSizeBytes: 1048576,
      concurrency: 4,
      embeddingBatchSize: 64,
    });

    expect(() => validateProjectConfig({ indexing: { maxFileSizeBytes: -1 } })).toThrow(
      ProjectConfigError,
    );
    expect(() => validateProjectConfig({ indexing: { concurrency: 0 } })).toThrow(
      ProjectConfigError,
    );
  });

  it('validates syntax chunking tuning block', () => {
    const parsed = validateProjectConfig({
      syntax: {
        stripComments: true,
        maxChunkLines: 150,
        minChunkLines: 5,
      },
    });
    expect(parsed.syntax).toEqual({
      stripComments: true,
      maxChunkLines: 150,
      minChunkLines: 5,
    });

    expect(() =>
      validateProjectConfig({ syntax: { minChunkLines: 200, maxChunkLines: 100 } }),
    ).toThrow(ProjectConfigError);
  });

  it('validates redteam tuning block', () => {
    const parsed = validateProjectConfig({
      redteam: {
        maxCardsPerSource: 300,
        quarantineOnSuspect: true,
      },
    });
    expect(parsed.redteam).toEqual({
      maxCardsPerSource: 300,
      quarantineOnSuspect: true,
    });

    expect(() => validateProjectConfig({ redteam: { maxCardsPerSource: 0 } })).toThrow(
      ProjectConfigError,
    );
    expect(() => validateProjectConfig({ redteam: { quarantineOnSuspect: 'strict' } })).toThrow(
      ProjectConfigError,
    );
  });

  it('writeProjectConfig writes and preserves $schema', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'anvesa-schema-test-'));
    try {
      const config: ProjectConfig = {
        $schema: CONFIG_SCHEMA_URL,
        model: 'custom-model',
        channels: {},
        fusionK: 45,
        fragments: false,
        search: { defaultLimit: 25 },
      };

      await writeProjectConfig(tempDir, config);
      const loaded = await loadProjectConfig(tempDir);
      expect(loaded.$schema).toBe(CONFIG_SCHEMA_URL);
      expect(loaded.model).toBe('custom-model');
      expect(loaded.fusionK).toBe(45);
      expect(loaded.search?.defaultLimit).toBe(25);

      // Custom schema preservation
      const customSchema = 'https://custom.example.com/schema.json';
      await writeProjectConfig(tempDir, { ...config, $schema: customSchema });
      const loadedCustom = await loadProjectConfig(tempDir);
      expect(loadedCustom.$schema).toBe(customSchema);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
