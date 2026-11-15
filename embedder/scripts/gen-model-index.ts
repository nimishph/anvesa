/**
 * Writes `embedder/src/models.generated.ts`: one JSON import per file in `embedder/models/`. A
 * compiled binary cannot read that folder at run time, so the files are compiled in through these
 * imports. Run after adding or changing a model: `bun run embedder/scripts/gen-model-index.ts`.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MODELS_DIRECTORY = join(import.meta.dir, '..', 'models');
export const GENERATED_FILE = join(import.meta.dir, '..', 'src', 'models.generated.ts');

/** The config files, in a stable order. */
export function modelFiles(directory: string = MODELS_DIRECTORY): string[] {
  return (
    readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      // Numbers compared as numbers (1b before 150m), the order biome keeps imports in.
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  );
}

function identifier(file: string): string {
  const words = file
    .replace(/\.json$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return `model_${words.join('_')}`;
}

/** The text of the generated index for these files. */
export function renderModelIndex(files: readonly string[]): string {
  const imports = files.map(
    (file) => `import ${identifier(file)} from '../models/${file}' with { type: 'json' };`,
  );
  const entries = files.map(
    (file) => `  { source: 'embedder/models/${file}', config: ${identifier(file)} },`,
  );
  return [
    '// Written by embedder/scripts/gen-model-index.ts from embedder/models/. Do not edit by hand.',
    '',
    ...imports,
    '',
    '/** Every built-in model config, as `buildRegistry` takes them. */',
    'export const MODEL_CONFIGS: readonly { readonly source: string; readonly config: unknown }[] = [',
    ...entries,
    '];',
    '',
  ].join('\n');
}

if (import.meta.main) {
  const files = modelFiles();
  writeFileSync(GENERATED_FILE, renderModelIndex(files));
  process.stdout.write(`wrote ${GENERATED_FILE} (${files.length} models)\n`);
}
