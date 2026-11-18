import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILTER_OPS, PATTERN_FIELDS, TARGET_KINDS } from '@cntxt-labs/anvesa-structural';
import { PATTERN_NAME, PATTERN_SCHEMA_URL } from './loader.ts';

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', 'schemas', 'pattern.v1.json'), 'utf8'),
);
const keys = (node: { properties: object }) => Object.keys(node.properties).sort();

// The schema is for editors; the loader and the compiler are what run. These keep them equal.
describe('schemas/pattern.v1.json', () => {
  test('is named by the URL a pattern file gives as $schema', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(PATTERN_SCHEMA_URL);
  });

  test('has exactly the fields the compiler knows, in every part of a pattern', () => {
    expect(keys(schema)).toEqual([...PATTERN_FIELDS.spec].sort());
    expect(keys(schema.$defs.target)).toEqual([...PATTERN_FIELDS.target].sort());
    expect(keys(schema.$defs.scope)).toEqual([...PATTERN_FIELDS.scope].sort());
    expect(keys(schema.$defs.filter)).toEqual([...PATTERN_FIELDS.filter].sort());
    expect(keys(schema.$defs.param)).toEqual([...PATTERN_FIELDS.param].sort());
    for (const node of [schema, ...Object.values(schema.$defs)]) {
      expect((node as { additionalProperties: unknown }).additionalProperties).toBe(false);
    }
  });

  test('requires what the loader requires, and allows the kinds, operators and names it does', () => {
    expect(schema.required).toEqual(['name', 'description', 'target']);
    expect(schema.properties.name.pattern).toBe(PATTERN_NAME.source);
    expect(schema.$defs.target.properties.kind.enum).toEqual([...TARGET_KINDS]);
    expect(schema.$defs.filter.properties.op.enum).toEqual([...FILTER_OPS]);
  });
});
