/**
 * The command registry: every module under `commands/` declares one command, and everything that
 * lists commands (dispatch, help, the usage record, the drift tests) reads it from here.
 *
 * A compiled binary has no folder to scan, so `commands.generated.ts` imports the modules; it is
 * written by `cli/scripts/gen-command-index.ts`, and a test fails when it and the folder disagree.
 */

import { CommandRegistryError } from '../errors.ts';
import { COMMAND_MODULES } from './commands.generated.ts';
import {
  type Command,
  type HelpEntry,
  SECTIONS,
  type Section,
  type Services,
} from './shared/command.ts';
import { modelCache, openSession, withProject } from './shared/context.ts';

export { SECTIONS, type Section };

/** One line of the help: a command, or the commands that share an entry, and the words that run it. */
export interface CommandHelp {
  readonly section: Section;
  /** The first words on the command line that run it: what `anvesa <key> --help` looks up. */
  readonly keys: readonly string[];
  readonly name: string;
  readonly summary: string;
  readonly details: string;
}

/** The services a command runs with, outside a test. */
export const SERVICES: Services = {
  openSession,
  withProject,
  modelCache,
  prompt: async (ctx, question) => ctx.environment.prompt?.(question),
  now: () => performance.now(),
};

export interface Registry {
  readonly commands: readonly Command[];
  /** By id: `graph:callers`. */
  byId(id: string): Command | undefined;
  /** By the word a person types: `callers`, `--version`. */
  byWord(word: string): Command | undefined;
  /** The help, one entry per line of the overview, in the overview's order. */
  readonly help: readonly CommandHelp[];
}

/** Build the registry, and refuse one that does not hold together. */
export function buildRegistry(commands: readonly Command[]): Registry {
  const ids = new Map<string, Command>();
  const words = new Map<string, Command>();
  for (const command of commands) {
    if (ids.has(command.id)) throw new CommandRegistryError(command.id, 'the id is declared twice');
    ids.set(command.id, command);
    for (const word of command.words) {
      const other = words.get(word);
      if (other) throw new CommandRegistryError(command.id, `"${word}" already runs ${other.id}`);
      words.set(word, command);
    }
  }
  // Commands that share a help entry share its line; the words of all of them look it up.
  const entries = new Map<HelpEntry, string[]>();
  for (const command of commands) {
    entries.set(command.help, [...(entries.get(command.help) ?? []), ...command.words]);
  }
  const help = [...entries]
    .sort(([a], [b]) => a.rank - b.rank)
    .map(([entry, keys]) => ({
      section: entry.section,
      keys,
      name: entry.name,
      summary: entry.summary,
      details: entry.details,
    }));
  for (const section of SECTIONS) {
    if (!help.some((entry) => entry.section === section)) {
      throw new CommandRegistryError(section, 'no command is in this help section');
    }
  }
  return {
    commands,
    byId: (id) => ids.get(id),
    byWord: (word) => words.get(word),
    help,
  };
}

export const REGISTRY: Registry = buildRegistry(COMMAND_MODULES);

/** The help, as the overview and `anvesa <command> --help` read it. */
export const COMMAND_HELP: readonly CommandHelp[] = REGISTRY.help;
