/**
 * Writes `cli/src/cmd/commands.generated.ts`: one import per module under `cli/src/cmd/commands/`.
 * A compiled binary cannot scan that folder at run time, so the modules are compiled in through
 * these imports. Run after adding or moving a command: `bun run cli/scripts/gen-command-index.ts`.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const COMMANDS_DIRECTORY = join(import.meta.dir, '..', 'src', 'cmd', 'commands');
export const GENERATED_FILE = join(import.meta.dir, '..', 'src', 'cmd', 'commands.generated.ts');

/** Every command module, as a path under `commands/` with forward slashes, in a stable order. */
export function commandFiles(directory: string = COMMANDS_DIRECTORY): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => relative(directory, join(directory, name)).split(sep).join('/'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function identifier(file: string): string {
  const words = file
    .replace(/\.ts$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return `command_${words.join('_')}`;
}

/** The text of the generated index for these modules. */
export function renderCommandIndex(files: readonly string[]): string {
  return [
    '// Written by cli/scripts/gen-command-index.ts from cli/src/cmd/commands/. Do not edit by hand.',
    '',
    ...files.map((file) => `import ${identifier(file)} from './commands/${file}';`),
    "import type { Command } from './shared/command.ts';",
    '',
    '/** Every command module, as `buildRegistry` takes them. */',
    'export const COMMAND_MODULES: readonly Command[] = [',
    ...files.map((file) => `  ${identifier(file)},`),
    '];',
    '',
  ].join('\n');
}

if (import.meta.main) {
  const files = commandFiles();
  writeFileSync(GENERATED_FILE, renderCommandIndex(files));
  process.stdout.write(`wrote ${GENERATED_FILE} (${files.length} commands)\n`);
}
