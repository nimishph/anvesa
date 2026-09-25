import { CodeLensError, toCodeLensError } from '@cntxt-labs/anvesa-core';
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
import { parseOptions } from './options.ts';
import { toJson } from './render.ts';
import { VERSION } from './version.ts';

export const HELP = `anvesa — dense and structural code retrieval

usage: anvesa <command> [arguments] [options]

  init                      scaffold .anvesaignore, .anvesa/workspace.json, .anvesa/config.json
                            (--force to overwrite files that already exist)
  index                     bring the index up to date (--force, --retry-quarantined, --scope <path>)
  status                    what is indexed, and by which channels and model
  search <question>         fused search over every channel and, for WQL, the structure
                            (--channel, --exclude <lane>, --weight <lane>=<n>, e.g. --weight docs=0.25)
  retrieve <channel> <q>    one channel on its own
  query '<wql>'             structural query, e.g. '//function[@name="parse"]'
  callers|callees|neighbors <symbol>   symbol id, name, or path:line
  dependents <path>         files that import it (--depth N, --limit N, --types)
  explain                   what the project is made of
  map [dir]                 graph-weighted architectural repomap (--depth N, --budget N)
  routes [method] [path]    discover HTTP routes across Laravel, Express, Next.js, FastAPI
  diagnose <question> --expect <path>   why a file did not come up
  channel add|list|show|test|index|remove   custom dense channels (make/create = add)
  grammar list|install <language>        parsers (--from <file|dir|tarball>, --user, --force, --download)
  redteam list|verify|scan  the screen every card passes; .anvesa/redteam.json adds rules and
                            changes what each trust level does (scan: would this project's own text be quarantined?)
  fragments status|propose|enable|disable|settle   keep the index in one database per fragment
                            propose [--tier path|clusters] [--write]; the manifest is committed
  mapping list|show|train|audit|refine|fork|lock|remove|verify|check   how a language's syntax becomes an outline;
                            audit/refine <language> finds and adds unmapped syntax nodes from code;
                            train <language> --samples <dir|file> learns one from code
  model list|install|verify|doctor       local embedding models; install <new-name> --from <dir|file.onnx>
                                         brings your own (--pooling, --max-tokens, --force)
  pattern list|run <name> [param=val...]  declarative structural patterns
  issue [title]             raise an issue on GitHub with sanitized diagnostics
  mcp serve                 run as an MCP server on stdio
  --version                 print the version

options: --root <dir>  --json  --limit N  --cursor <token>  --channel <name>  --no-embed
         --models <dir>  --model <id>  --from <dir>  --download  --depth N  --help
`;

/**
 * The help entry for one command: its line in HELP plus the indented lines that continue it, under
 * the usage line. A command with no entry (or an unknown name) gets the whole HELP.
 */
export function helpFor(command: string): string {
  const lines = HELP.split('\n');
  const start = lines.findIndex((line) => {
    const name = /^ {2}(\S+)/.exec(line)?.[1];
    return name?.split('|').includes(command) === true;
  });
  if (start === -1) return HELP;
  let end = start + 1;
  while (end < lines.length && /^ {20,}\S/.test(lines[end] as string)) end += 1;
  return `${[...lines.filter((line) => line.startsWith('usage:')), '', ...lines.slice(start, end)].join('\n')}\n`;
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
    environment.stdout(HELP);
    return command === undefined ? 2 : 0;
  }

  let json = false;
  try {
    const parsed = parseOptions(args);
    json = parsed.values.json === true;
    if (parsed.values.help) {
      environment.stdout(helpFor(command));
      return 0;
    }
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
      await serveMcp({ ...ctx, parsed: { ...parsed, positionals: rest } });
    } else {
      const handler = COMMANDS[command];
      if (!handler) return usage(environment, `unknown command "${command}"`);
      await handler(ctx);
    }
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
  }
}

function usage(environment: Environment, problem: string): number {
  environment.stderr(`${problem}\n\n${HELP}`);
  return 2;
}

export { CodeLensError };
