import { CodeLensError, InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
import { pathScope } from '@cntxt-labs/anvesa-retriever';
import {
  COMMANDS,
  type Context,
  channelCommand,
  fragmentsCommand,
  grammarCommand,
  mappingCommand,
  modelCommand,
  patternCommand,
  redteamCommand,
} from './commands.ts';
import type { Environment } from './environment.ts';
import { COMMAND_HELP, type CommandHelp, GLOBAL_HELP, SECTIONS } from './help.ts';
import { blockNetwork, NetworkBlockedError, type NetworkGuard } from './network-guard.ts';
import { parseOptions } from './options.ts';
import { toJson } from './render.ts';
import { recentCommands, recordUse } from './usage.ts';
import { VERSION } from './version.ts';

const USAGE = `anvesa — dense and structural code retrieval

usage: anvesa <command> [arguments] [options]
       anvesa <command> --help    that command's arguments and options`;

/** Every first word that runs a command: what usage may record, and what help can look up. */
const KNOWN = new Set(COMMAND_HELP.flatMap((entry) => entry.keys));

/** Wide enough for the longest name and two spaces, so every summary starts in one column. */
const NAME_WIDTH = Math.max(...COMMAND_HELP.map((entry) => entry.name.length)) + 2;
const line = (entry: CommandHelp): string => `  ${entry.name.padEnd(NAME_WIDTH)}${entry.summary}`;

/**
 * The overview: the commands this user ran most lately, if any, then every command by section,
 * one line each, then how the project is found and the options every command takes. The sections
 * keep their order, so the help reads the same from one day to the next; only the first block moves.
 */
export function renderHelp(recent: readonly string[] = []): string {
  const recentEntries = [
    ...new Set(
      recent.flatMap((command) => COMMAND_HELP.filter((entry) => entry.keys.includes(command))),
    ),
  ];
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
  const [command, ...args] = argv;
  if (command === '--version' || command === '-v' || command === 'version') {
    environment.stdout(`anvesa ${VERSION}
`);
    return 0;
  }
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    environment.stdout(renderHelp(recentCommands(environment.env)));
    return command === undefined ? 2 : 0;
  }

  let json = false;
  let guard: NetworkGuard | undefined;
  try {
    const parsed = parseOptions(args);
    json = parsed.values.json === true;
    if (parsed.values.help) {
      environment.stdout(helpFor(command));
      return 0;
    }
    const audit = parsed.values['no-network'] === true || environment.env.ANVESA_NO_NETWORK === '1';
    if (audit && parsed.values.download) {
      throw new InvalidArgumentError('--download', 'absent when --no-network is set', 'present');
    }
    // Checked before anything is opened, so a scope that can never match fails at once, by name.
    pathScope(parsed.values.scope, '--scope');
    if (audit) guard = blockNetwork();
    const ctx: Context = { environment, parsed };

    if (command === 'channel') await channelCommand(ctx);
    else if (command === 'model') await modelCommand(ctx);
    else if (command === 'grammar') await grammarCommand(ctx);
    else if (command === 'mapping') await mappingCommand(ctx);
    else if (command === 'fragments') await fragmentsCommand(ctx);
    else if (command === 'redteam') await redteamCommand(ctx);
    else if (command === 'pattern') await patternCommand(ctx);
    else if (command === 'mcp') {
      const [sub, ...rest] = parsed.positionals;
      if (sub !== 'serve')
        return usage(environment, `unknown mcp command "${sub ?? ''}"; use: mcp serve`);
      const { serveMcp } = await import('./mcp.ts');
      // A server runs for as long as its client: counted once, when it starts.
      recordUse(environment.env, command, KNOWN);
      await serveMcp({ ...ctx, parsed: { ...parsed, positionals: rest } });
    } else {
      const handler = COMMANDS[command];
      if (!handler) return usage(environment, `unknown command "${command}"`);
      await handler(ctx);
    }
    if (guard) {
      // A blocked call throws, but code may have caught that. The record does not forget.
      if (guard.attempts.length > 0) throw new NetworkBlockedError(guard.attempts);
      if (!json) environment.stderr('network audit: no outbound connection was attempted\n');
    }
    if (command !== 'mcp') recordUse(environment.env, command, KNOWN);
    return 0;
  } catch (failure) {
    const error = toCodeLensError(failure, `run ${command}`);
    if (json) environment.stderr(toJson({ error }));
    else {
      environment.stderr(`error: ${error.message}\n`);
      if (error.hint) environment.stderr(`hint: ${error.hint}\n`);
      environment.stderr(`(${error.code})\n`);
    }
    return error.code === 'CORE_INVALID_ARGUMENT' ? 2 : 1;
  } finally {
    guard?.release();
  }
}

function usage(environment: Environment, problem: string): number {
  environment.stderr(`${problem}\n\n${renderHelp(recentCommands(environment.env))}`);
  return 2;
}

export { CodeLensError };
