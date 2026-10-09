/**
 * The command line's help, as data: each command's section, a one-line summary for the overview,
 * and its full text for `anvesa <command> --help`. The overview lists the sections in a fixed
 * order, after the commands this user ran most lately (see usage.ts).
 */

export const SECTIONS = [
  'Get started',
  'Index',
  'Search',
  'Code graph',
  'Extend',
  'Safety',
  'Agents and help',
] as const;

export type Section = (typeof SECTIONS)[number];

export interface CommandHelp {
  readonly section: Section;
  /** The first word on the command line that runs it: what `anvesa <key> --help` looks up. */
  readonly keys: readonly string[];
  /** As the overview names it: `search <question>`, `channel <subcommand>`. */
  readonly name: string;
  readonly summary: string;
  /** Everything about it: what `anvesa <command> --help` prints. */
  readonly details: string;
}

export const COMMAND_HELP: readonly CommandHelp[] = [
  {
    section: 'Get started',
    keys: ['init'],
    name: 'init',
    summary: 'set up a project: config files, an encoder and parsers',
    details:
      '  init                      scaffold .anvesaignore, .anvesa/workspace.json, .anvesa/config.json\n                            (--force to overwrite files that already exist), then looks at this machine and\n                            project: proposes an encoder that suits the hardware and offers a parser for each\n                            language that lacks one, with a progress bar per download. Asks on a terminal;\n                            --yes accepts the proposals; --model <id> picks the encoder; --no-download only\n                            reports what it would fetch. Nothing downloads without a yes. Also keeps an\n                            anvesa section in AGENTS.md / CLAUDE.md (created as AGENTS.md if neither\n                            exists; --agents-file <path> names another file, --no-agents-file skips it).\n                            Re-run after an upgrade: kept files stay, the section is refreshed.',
  },
  {
    section: 'Get started',
    keys: ['status'],
    name: 'status',
    summary: 'what is indexed, and by which channels and model',
    details: '  status                    what is indexed, and by which channels and model',
  },
  {
    section: 'Get started',
    keys: ['where'],
    name: 'where [root|config|index|models]',
    summary: 'the project in use, and its config, index and models paths',
    details:
      '  where [root|config|index|models]   the project in use, how it was found, and its config, index and\n                            models paths; name one to print just that path (for scripts)',
  },
  {
    section: 'Index',
    keys: ['index'],
    name: 'index',
    summary: 'bring the index up to date',
    details:
      '  index                     bring the index up to date (--force, --retry-quarantined, --scope <path>,\n                            --no-embed or --no-dense: structure and graph only, no embedding pass,\n                            --show-walk: print each path the walk offers, with its outcome, on stderr)',
  },
  {
    section: 'Index',
    keys: ['fragments'],
    name: 'fragments <subcommand>',
    summary: 'keep the index in one database per fragment',
    details:
      '  fragments status|propose|enable|disable|settle   keep the index in one database per fragment\n                            propose [--tier path|clusters] [--write]; the manifest is committed',
  },
  {
    section: 'Search',
    keys: ['search'],
    name: 'search <question>',
    summary: 'fused search over every channel and, for WQL, the structure',
    details:
      "  search <question>         fused search over every channel and, for WQL, the structure; one row per\n                            result (--expand or --full: each result's card under its row)\n                            (--wql <wql>, --channel, --exclude <lane>, --weight <lane>=<n>,\n                            --scope <path>: only results from that path or under it, relative to\n                            the project root; every lane, documentation included; also on retrieve, query)\n                            (supports conjunction: 'save user && //function', 'save user where //class')",
  },
  {
    section: 'Search',
    keys: ['retrieve'],
    name: 'retrieve <channel> <q>',
    summary: 'one channel on its own',
    details: '  retrieve <channel> <q>    one channel on its own',
  },
  {
    section: 'Search',
    keys: ['query'],
    name: "query '<wql>'",
    summary: 'structural query in WQL, e.g. \'//function[@name="parse"]\'',
    details:
      "  query '<wql>'             structural query, e.g. '//function[@name=\"parse\"]'\n                            (--semantic <q>, or conjunction: '//function && save user')",
  },
  {
    section: 'Search',
    keys: ['diagnose'],
    name: 'diagnose <q> --expect <path>',
    summary: 'why a file did not come up',
    details: '  diagnose <question> --expect <path>   why a file did not come up',
  },
  {
    section: 'Search',
    keys: ['pattern'],
    name: 'pattern list|run <name>',
    summary: 'declarative structural patterns',
    details: '  pattern list|run <name> [param=val...]  declarative structural patterns',
  },
  {
    section: 'Code graph',
    keys: ['callers', 'callees', 'neighbors'],
    name: 'callers|callees|neighbors <symbol>',
    summary: 'who calls a symbol, what it calls, or both',
    details: '  callers|callees|neighbors <symbol>   symbol id, name, or path:line',
  },
  {
    section: 'Code graph',
    keys: ['dependents'],
    name: 'dependents <path>',
    summary: 'files that import a file',
    details: '  dependents <path>         files that import it (--depth N, --limit N, --types)',
  },
  {
    section: 'Code graph',
    keys: ['explain'],
    name: 'explain',
    summary: 'what the project is made of',
    details: '  explain                   what the project is made of',
  },
  {
    section: 'Code graph',
    keys: ['map'],
    name: 'map [dir]',
    summary: 'graph-weighted architectural repomap',
    details:
      '  map [dir]                 graph-weighted architectural repomap (--depth N, --budget N)',
  },
  {
    section: 'Code graph',
    keys: ['routes'],
    name: 'routes [method] [path]',
    summary: 'HTTP routes across Laravel, Express, Next.js, FastAPI',
    details:
      '  routes [method] [path]    discover HTTP routes across Laravel, Express, Next.js, FastAPI',
  },
  {
    section: 'Extend',
    keys: ['channel'],
    name: 'channel <subcommand>',
    summary: 'custom dense channels',
    details:
      '  channel add|list|show|test|index|pin|remove   custom dense channels (make/create = add)\n                            pin <name> holds a channel\'s module to its checksum; "security": {"requireChecksums": true}\n                            in .anvesa/config.json refuses any module that is not pinned',
  },
  {
    section: 'Extend',
    keys: ['grammar'],
    name: 'grammar <subcommand>',
    summary: 'parsers',
    details:
      '  grammar list|install <language>        parsers (--from <file|dir|tarball>, --user, --force, --download)',
  },
  {
    section: 'Extend',
    keys: ['mapping'],
    name: 'mapping <subcommand>',
    summary: "how a language's syntax becomes an outline",
    details:
      "  mapping list|show|train|audit|refine|fork|lock|remove|verify|check   how a language's syntax becomes an outline;\n                            audit/refine <language> finds and adds unmapped syntax nodes from code;\n                            train <language> --samples <dir|file> [more...] learns from code and extends the\n                            mapping in effect (--replace learns from scratch; --min-samples N, default 10;\n                            --min-files N a new node type must occur in, default 3; --assist asks a\n                            language model about what is left, from OPENROUTER_API_KEY, checked before use;\n                            --tags <tags.scm> starts from the grammar's own definitions and calls)",
  },
  {
    section: 'Extend',
    keys: ['model'],
    name: 'model <subcommand>',
    summary: 'local embedding models',
    details:
      '  model list|install|verify|doctor       local embedding models; install <new-name> --from <dir|file.onnx>\n                                         brings your own (--pooling, --max-tokens, --force)',
  },
  {
    section: 'Safety',
    keys: ['redteam'],
    name: 'redteam <subcommand>',
    summary: 'the screen every card passes',
    details:
      "  redteam list|verify|scan  the screen every card passes; .anvesa/redteam.json adds rules and\n                            changes what each trust level does (scan: would this project's own text be quarantined?)",
  },
  {
    section: 'Agents and help',
    keys: ['primer'],
    name: 'primer [topic]',
    summary: 'token-frugal guidance on Anvesa architecture and concepts',
    details:
      '  primer [topic]            token-frugal guidance on Anvesa architecture and concepts (--compact)',
  },
  {
    section: 'Agents and help',
    keys: ['issue'],
    name: 'issue [title]',
    summary: 'raise an issue on GitHub with sanitized diagnostics',
    details: '  issue [title]             raise an issue on GitHub with sanitized diagnostics',
  },
  {
    section: 'Agents and help',
    keys: ['mcp'],
    name: 'mcp serve',
    summary: 'run as an MCP server on stdio',
    details:
      '  mcp serve                 run as an MCP server on stdio, for the project (see --root below)',
  },
  {
    section: 'Agents and help',
    keys: ['--version', 'version', '-v'],
    name: '--version',
    summary: 'print the version',
    details: '  --version                 print the version',
  },
];

/** What follows the commands: how the project is found, and the options every command takes. */
export const GLOBAL_HELP =
  'project: the nearest directory, here or above, with a .anvesa/ project in it (config.json,\n         workspace.json or an index), the way git finds .git; none found, the current directory.\n         --root <dir> names it instead. init always scaffolds in the current directory (or --root).\n\noptions: --root <dir>  --json  --limit N  --cursor <token>  --channel <name>  --no-embed (or --no-dense)\n         --no-network (or ANVESA_NO_NETWORK=1)  audit mode: block every outbound connection, report attempts\n         --wql <wql>  --semantic <q>  --models <dir>  --model <id>  --from <dir>  --help';
