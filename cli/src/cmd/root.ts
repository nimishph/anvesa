/**
 * The command line: parse argv, find the command by the word it starts with, run it with its
 * services, and map what happens to an exit code (0 done, 1 the operation failed, 2 the command line
 * was wrong).
 */

import { CodeLensError, InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
import { pathScope } from '@cntxt-labs/anvesa-retriever';
import type { Environment } from '../environment.ts';
import { UnknownCommandError } from '../errors.ts';
import { blockNetwork, NetworkBlockedError, type NetworkGuard } from '../network-guard.ts';
import { parseOptions } from '../options.ts';
import { toJson } from '../render.ts';
import { recentCommands, recordUse } from '../usage.ts';
import { VERSION } from '../version.ts';
import { COMMAND_HELP, type CommandHelp, REGISTRY, SECTIONS, SERVICES } from './registry.ts';
import type { Context } from './shared/context.ts';

const USAGE = `anvesa — dense and structural code retrieval

usage: anvesa <command> [arguments] [options]
       anvesa <command> --help    that command's arguments and options`;

/** What follows the commands: how the project is found, and the options every command takes. */
const GLOBAL_HELP =
  'project: the nearest directory, here or above, with a .anvesa/ project in it (config.json,\n         workspace.json or an index), the way git finds .git; none found, the current directory.\n         --root <dir> names it instead. init always scaffolds in the current directory (or --root).\n\noptions: --root <dir>  --json  --limit N  --cursor <token>  --channel <name>  --no-embed (or --no-dense)\n         --no-network (or ANVESA_NO_NETWORK=1)  audit mode: block every outbound connection, report attempts\n         --wql <wql>  --semantic <q>  --models <dir>  --model <id>  --from <dir>  --help';

/** Every first word that runs a command: what usage may record, and what help can look up. */
const KNOWN = new Set(COMMAND_HELP.flatMap((entry) => entry.keys));

/** How many lines the "Recently used" block shows at most. */
const RECENT_LIMIT = 5;
/** Wide enough for the longest name and two spaces, so every summary starts in one column. */
const NAME_WIDTH = Math.max(...COMMAND_HELP.map((entry) => entry.name.length)) + 2;
const line = (entry: CommandHelp): string => `  ${entry.name.padEnd(NAME_WIDTH)}${entry.summary}`;

/**
 * The overview: the commands this user ran most lately, if any, then every command by section,
 * one line each, then how the project is found and the options every command takes. The sections
 * keep their order, so the help reads the same from one day to the next; only the first block moves.
 */
export function renderHelp(recent: readonly string[] = []): string {
  // Limited after merging, so names that share a line (callers|callees|neighbors) take one slot.
  const recentEntries = [
    ...new Set(
      recent.flatMap((command) => COMMAND_HELP.filter((entry) => entry.keys.includes(command))),
    ),
  ].slice(0, RECENT_LIMIT);
  const blocks = [
    USAGE,
    recentEntries.length > 0 ? ['Recently used', ...recentEntries.map(line)].join('\n') : undefined,
    ...SECTIONS.map((section) =>
      [section, ...COMMAND_HELP.filter((entry) => entry.section === section).map(line)].join('\n'),
    ),
    GLOBAL_HELP,
  ];
  return `${blocks.filter((block): block is string => block !== undefined).join('\n\n')}\n`;
}

/** The whole help with no recent block: what a library caller or a usage error shows. */
export const HELP = renderHelp();

/**
 * The help for one command: the usage line and everything about that command. A command with no
 * entry (or an unknown name) gets the whole help.
 */
export function helpFor(command: string): string {
  const entry = COMMAND_HELP.find((candidate) => candidate.keys.includes(command));
  if (!entry) return HELP;
  return `usage: anvesa <command> [arguments] [options]\n\n${entry.details}\n`;
}

/** Exit codes: 0 done, 1 the operation failed, 2 the command line was wrong. */
export async function runCli(argv: readonly string[], environment: Environment): Promise<number> {
  const [word, ...args] = argv;
  const command = word === undefined ? undefined : REGISTRY.byWord(word);
  // The version needs no project and no options: answered before anything is parsed.
  if (command?.id === 'agent:version') {
    await command.run({ environment, parsed: parseOptions([]) }, SERVICES);
    return 0;
  }
  if (word === undefined || word === 'help' || word === '--help' || word === '-h') {
    environment.stdout(renderHelp(recentCommands(environment.env)));
    return word === undefined ? 2 : 0;
  }

  let json = false;
  let guard: NetworkGuard | undefined;
  const startedAt = performance.now();
  let results: number | undefined;
  // Each run is counted once, even a server that started and then failed.
  let counted = false;
  const run = (exit: 0 | 1 | 2, timed = true): void => {
    if (counted) return;
    counted = true;
    recordUse(environment.env, word, KNOWN, {
      exit,
      ...(timed ? { ms: performance.now() - startedAt } : {}),
      ...(results === undefined ? {} : { results }),
      version: VERSION,
    });
  };
  try {
    const parsed = parseOptions(args);
    json = parsed.values.json === true;
    if (parsed.values.help) {
      environment.stdout(helpFor(word));
      return 0;
    }
    const audit = parsed.values['no-network'] === true || environment.env.ANVESA_NO_NETWORK === '1';
    if (audit && parsed.values.download) {
      throw new InvalidArgumentError('--download', 'absent when --no-network is set', 'present');
    }
    // Checked before anything is opened, so a scope that can never match fails at once, by name.
    pathScope(parsed.values.scope, '--scope');
    if (!command) return usage(environment, `unknown command "${word}"`);
    if (audit) guard = blockNetwork();
    const ctx: Context = {
      environment,
      parsed,
      onResults: (count) => {
        results = (results ?? 0) + count;
      },
      ...(command.countsItself ? { onServing: () => run(0, false) } : {}),
    };

    await command.run(ctx, SERVICES);
    if (guard) {
      // A blocked call throws, but code may have caught that. The record does not forget.
      if (guard.attempts.length > 0) throw new NetworkBlockedError(guard.attempts);
      if (!json) environment.stderr('network audit: no outbound connection was attempted\n');
    }
    if (!command.countsItself) run(0);
    return 0;
  } catch (failure) {
    if (failure instanceof UnknownCommandError) return usage(environment, failure.message);
    const error = toCodeLensError(failure, `run ${word}`);
    if (json) environment.stderr(toJson({ error }));
    else {
      environment.stderr(`error: ${error.message}\n`);
      if (error.hint) environment.stderr(`hint: ${error.hint}\n`);
      environment.stderr(`(${error.code})\n`);
    }
    const exit = error.code === 'CORE_INVALID_ARGUMENT' ? 2 : 1;
    run(exit);
    return exit;
  } finally {
    guard?.release();
  }
}

function usage(environment: Environment, problem: string): number {
  environment.stderr(`${problem}\n\n${renderHelp(recentCommands(environment.env))}`);
  return 2;
}

export { CodeLensError };
