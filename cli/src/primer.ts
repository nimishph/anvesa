/**
 * Token-frugal primer for agents and developers (§anv-35b).
 * Provides focused, 25-50 line explanations of Anvesa concepts to prevent context bloat.
 *
 * Every command in help.ts is named here or in skills/anvesa/SKILL.md, and every WQL example
 * parses: primer.test.ts checks both, so the guidance cannot drift from the code again (#49, #51).
 */

import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { DEFAULT_RRF_K } from '@cntxt-labs/anvesa-retriever';

export interface PrimerTopicInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly content: string;
}

export const PRIMER_TOPICS: Record<string, PrimerTopicInfo> = {
  overview: {
    name: 'overview',
    title: 'Anvesa: Hybrid Code Intelligence Overview',
    description: 'Core philosophy, command cheatsheet, and decision heuristic table.',
    content: `# Anvesa: Hybrid Code Intelligence

Anvesa combines dense semantic search (local ONNX embeddings) with structural AST analysis (Tree-sitter & WQL), fused via Reciprocal Rank Fusion (RRF).

### Decision Heuristic Table
| Task / Goal | Recommended Tool / Command |
| :--- | :--- |
| Search by concept/behavior | \`anvesa search <concept>\` (fused dense + structure) |
| Find exact symbol definition | \`anvesa query '//function[@name="foo"][@declaration]'\` |
| Trace call hierarchy | \`anvesa callers <symbol>\` / \`callees <symbol>\` |
| Trace blast radius (who imports) | \`anvesa dependents <file>\` |
| Discover HTTP endpoints | \`anvesa routes [method] [path]\` |
| Exact string / regex search | Standard ripgrep / grep |

### Essential Commands
- \`anvesa init\` — Scaffold ignore and configs, download a model & parsers.
- \`anvesa index\` — Incrementally parse AST outlines and embed cards.
- \`anvesa search <question>\` — Fused semantic & structural search.
- \`anvesa retrieve <channel> <q>\` — Search a single dense channel on its own.
- \`anvesa query '<wql>'\` — Structural AST query.
- \`anvesa callers|callees|neighbors <symbol>\` — Call and locality graphs.
- \`anvesa dependents <path>\` — Import dependency blast radius.
- \`anvesa map [dir]\` — PageRank-weighted architectural repomap (\`--budget\` fits it to tokens).
- \`anvesa explain\` — High-level repository structural summary.
- \`anvesa diagnose <q> --expect <path>\` — Why an expected file did not rank.
- \`anvesa status\` — Check index freshness, models, and channels.
- \`anvesa where [config]\` — Which project is in use, how it was found, and its config, index and models paths.
- \`anvesa ui\` — Interactive visual web dashboard (search, graph, repomap, health).
- \`anvesa primer [topic]\` — Token-frugal concept guidance for agents.
- \`anvesa mcp serve\` — Model Context Protocol server over stdio.

More topics: patterns, federation, channels, models, telemetry (\`anvesa primer <topic>\`).`,
  },

  wql: {
    name: 'wql',
    title: 'Wildcard Query Language (WQL) Cheatsheet',
    description: 'Structural query syntax, axes, predicates, attributes, and conjunctions.',
    content: `# Wildcard Query Language (WQL)

WQL queries the structural AST outline of the repository without regex guesswork.

### Axes & Tags
- \`//\` — Descendant axis (any depth): \`//class//method\`
- \`/\` or \`>\` — Direct child axis: \`//class/method\`, \`//class>method\`
- Normalized tags: \`//callable\` (any function, method, arrow, lambda), \`//function\`, \`//method\`, \`//class\`, \`//interface\`
- The tag is the normalized kind; \`@kind\` is the grammar's own node type (\`function_declaration\`), so \`[@kind="function"]\` matches nothing.

### Predicates
- Equals / starts / ends: \`//function[@name="parseConfig"]\`, \`[@name^="get"]\`, \`[@name$="Handler"]\`
- Contains: \`//function[contains(@name, "Config")]\`
- Regex (\`~=\`, or \`=~\`): \`//function[@name~="^validate[A-Z]"]\`
- Exists: \`//callable[@declaration]\` (declarations only, not calls or references)
- Boolean: \`//function[@name="find" or @name="findById"]\`, \`//method[not(@name^="test")]\`

### Attributes
name, declaration, kind, line, endLine, params, returns, signature, path, doc, callable, isMethod, baseName, assignedTo, aliasOf, hash, shape, bodyShape, bodyKind, bodyStmts, shapeNodes, startIndex, endIndex. Any other is an error naming these.

### Conjunction Queries (Semantic + Structural)
Combine natural language meaning with strict AST constraints:
- CLI: \`anvesa search "parse config && //function"\`
- CLI: \`anvesa query '//function && parse config'\`
- MCP: \`search({ query: "handle auth", wql: "//class//method" })\`

A query lists result files that changed or were deleted since indexing; run \`anvesa index\` to refresh.`,
  },

  fusion: {
    name: 'fusion',
    title: 'Reciprocal Rank Fusion (RRF) Mechanics',
    description: 'How dense and structural lanes are blended, scoring, and lane filtering.',
    content: `# Reciprocal Rank Fusion (RRF)

Anvesa blends search results from multiple independent channels using RRF:

\`\`\`text
score = sum( lane_weight / (k + rank) )
\`\`\`

- **Default Constant:** \`k = ${DEFAULT_RRF_K}\` (balances top ranks against consistent presence across lanes).
- **Lanes:**
  - \`symbols\` — Local neural embeddings of symbol cards (an anvesa-code model by default).
  - \`docs\` — Embedded documentation sections.
  - \`structural\` — AST nodes matching WQL queries.
  - custom channels — Project-specific extractions (see \`anvesa primer channels\`).

### Score Interpretation
- **Fused \`score\`**: Relative rank position across lanes for *this query only*. Never compare scores between different queries.
- **\`bestScore\`**: True cosine similarity from the strongest semantic lane (0.0 to 1.0). Absent when matched only by structure.

### Lane Filtering Best Practice
To omit docs or noise, **prefer boolean exclusion** over small weights:
- Use: \`anvesa search "auth" --exclude docs\`
- Avoid: \`--weight docs=0.01\` (still dilutes ranking denominator).`,
  },

  graph: {
    name: 'graph',
    title: 'Code Graph: Callers, Callees, Dependents & Repomap',
    description: 'Navigating relationships, blast radius analysis, and route discovery.',
    content: `# Code Graph Navigation

Anvesa maintains an incremental symbol and call graph stored in SQLite.

### Commands & Tools
- \`callers <symbol>\`: Who calls this function or method?
  - Options: \`--resolved-only\` (filters out ambiguous dynamic call sites).
- \`callees <symbol>\`: What functions does this symbol call?
- \`neighbors <symbol>\`: Callers and callees together.
- \`dependents <path>\`: Blast radius of a file (which files import it directly or transitively).
  - Options: \`--depth <N>\`, \`--limit <N>\`, \`--types\` (include type-only imports).
- \`map [dir]\`: PageRank architectural repomap.
  - Options: \`--budget <tokens>\` (keeps the highest-ranked files that fit, says how many it left out), \`--depth <N>\` (counted from \`dir\`).
- \`routes [method] [path]\`: HTTP endpoints across Express, Next.js, FastAPI, Flask, Laravel (group prefixes included), Lumen.
  - Option: \`--framework <name>\`.
- \`explain\`: Languages, packages, and the files and symbols most depended on.

### Targeting Symbols
Specify targets by symbol name, ID, or file location:
- Name: \`anvesa callers parseConfig\`
- Location: \`anvesa callers src/config.ts:45\`
A name that matches several symbols lists them; pick one by location.`,
  },

  indexing: {
    name: 'indexing',
    title: 'Incremental Indexing & Storage Architecture',
    description: 'AST caching, sharded fragment databases, and offline indexing.',
    content: `# Indexing & Storage Architecture

Anvesa stores index data in \`.anvesa/index.db\` (or one database per fragment for large repositories).

### Indexing Options
- \`anvesa index\` — Incremental run; only processes modified, added or removed files (moves included).
- \`anvesa index --force\` — Rebuilds AST outlines and cards from scratch.
- \`anvesa index --scope <path>\` — Limit indexing to a specific subdirectory.
- \`anvesa index --no-embed\` (alias \`--no-dense\`) — Structural AST and graph only (no embedding pass).
- \`anvesa index --retry-quarantined\` — Re-evaluates previously quarantined files.

### Fragment Sharding (\`anvesa fragments\`)
Worth it only past about 500 MB of \`index.db\`:
- \`anvesa fragments status\` — Sharding state, and files not where the manifest says.
- \`anvesa fragments propose [--tier path|clusters] [--write]\` — Compute fragment boundaries; the manifest (\`.anvesa/fragments.json\`) is committed.
- \`anvesa fragments enable\` — Split the index into per-fragment databases.
- \`anvesa fragments disable\` — Back to one database: removes the shard databases, keeps the manifest; then \`anvesa index --force\`.
- \`anvesa fragments settle\` — After a *manifest* change, forget what sits in the wrong shard so the next index puts it right. Moved files need \`anvesa index\`, not settle.`,
  },

  grammars: {
    name: 'grammars',
    title: 'Grammars, Mappings, Red-Team & Diagnostics',
    description: 'Tree-sitter grammars, language mappings, red-team policies, and diagnostics.',
    content: `# Grammars, Mappings & Security Tooling

### Tree-sitter Grammars (\`anvesa grammar\`)
- \`grammar list\` — Inspect status and SHA-256 hashes of installed parsers.
- \`grammar install <lang>\` — Install from prebuilt WASM or local directory.

### Mappings (\`anvesa mapping\`)
- \`mapping list|show|train|audit|refine|fork|lock|remove|verify|check\` — Manage syntax-to-outline mappings.
- \`mapping train <lang> --samples <dir>\` — Learn a mapping from code; \`--tags <tags.scm>\` starts from the
  grammar's own definitions and calls, \`--assist\` asks a language model (OPENROUTER_API_KEY) about the rest.
- \`mapping audit <lang> --samples <dir>\` — Report syntax node types the mapping does not cover.
- Bundled: TS/JS (Vue via TS), Python, PHP, Go, Rust, Java, Ruby, C#. C/C++ partial (functions unnamed: use
  \`//function\`, not \`[@name=...]\`).

### Security & Diagnostics
- \`redteam list|verify|scan\` — Prompt-injection screening rules and card quarantine inspector.
- \`diagnose <query> --expect <path>\` — Explain why a target file was missed.
- \`issue [title]\` — Export sanitized diagnostics bundle for bug reporting.

Models: \`anvesa primer models\`. Channels: \`anvesa primer channels\`. Patterns: \`anvesa primer patterns\`.`,
  },

  models: {
    name: 'models',
    title: 'Local Embedding Models',
    description: 'anvesa-code and open models: listing, choosing per project, installing.',
    content: `# Local Embedding Models (\`anvesa model\`)

Embedding runs locally (ONNX). Nothing downloads without \`--download\` or a yes.

### Families
- **anvesa-code** (MIT): anvesa-code-150m (default, CPU), -400m, -1b. Each comes with a learned ranker.
- **Open models**: open-licence encoders anvesa can fetch and pin to an upstream commit, e.g.
  gte-modernbert-base (Apache-2.0). Used only when named; not scored on code search.
- **Yours**: \`model install <name> --from <dir|file.onnx>\` (\`--pooling mean|cls\`, \`--max-tokens\`).

### Commands
- \`model list\` — All models, grouped by family, with size, licence and what is installed.
- \`model use [model]\` — The model this project searches with, recorded in \`.anvesa/config.json\`.
  Unnamed, it lists the models and asks; \`--download\` fetches a missing one first.
- \`model install <id> --download\` — Download and pin a catalog model.
- \`model verify <id>\` — Check every installed file against its checksum.
- \`model doctor\` — What this machine suits and what this project would use.

### Rules
- \`anvesa index\` records the model it embedded with; search uses it. A different model is an error
  (\`RETRIEVER_MODEL_MISMATCH\`) naming both: run \`anvesa index\` after \`model use\`.
- \`--model <id>\` on index, search or status overrides it for one run.`,
  },

  channels: {
    name: 'channels',
    title: 'Channels: Dense Lanes of Your Own',
    description: 'Built-in and project channels, transformer modules, pinning.',
    content: `# Channels (\`anvesa channel\`)

A channel is a dense lane: a transformer turns files (or records) into cards, which are embedded.

### Built-in
- \`symbols\` — Code symbols. \`docs\` — Documentation sections.
- Built-ins cannot be added again, shadowed or removed. To leave one out of a search: \`--exclude docs\`.

### Project Channels
- \`channel add <name> [--template file]\` (also \`make\`, \`create\`) — Scaffold \`.anvesa/channels/<name>/transformer.ts\` and register it.
- \`channel list\` / \`channel show <name>\` — What is registered, and what a channel claims.
- \`channel test <name> <file>\` — Whether a channel claims a file, and the cards it would make.
- \`channel index <name>\` — Index one channel now.
- \`channel pin <name>\` — Record the module's checksum; a changed module then refuses to load until re-pinned.
- \`channel remove <name>\` — Drop a project channel and its cards. An unknown name is an error.

### Module Rules
- \`export default\` a transformer (\`name\`, \`version\`, \`channel\`, \`claim(file)\`, \`transform(file)\`).
- Editing the module re-embeds its cards; no version bump is needed.
- \`anvesa retrieve <channel> "<query>"\` searches one channel; MCP: \`retrieve_<channel>\`.`,
  },

  patterns: {
    name: 'patterns',
    title: 'Declarative Query Patterns',
    description: 'Named, parameterized WQL patterns a team keeps in .anvesa/patterns/.',
    content: `# Patterns (\`anvesa pattern\`)

A pattern is a JSON file in \`.anvesa/patterns/\` that compiles to WQL.

\`\`\`json
{
  "name": "functions-by-prefix",
  "description": "Functions whose name starts with a prefix",
  "target": { "kind": "function", "nameStartsWith": "$prefix" },
  "params": [{ "name": "prefix", "required": true }]
}
\`\`\`

### Commands
- \`pattern list\` — Usable patterns with their parameters, and every file that was rejected and why.
- \`pattern run <name> key=value ...\` — e.g. \`anvesa pattern run functions-by-prefix prefix=get\`.
  Prints the WQL it ran.
- MCP: \`pattern_list()\`, \`pattern_run({ name, args: { prefix: "get" } })\`.

### Rules
- \`name\`, \`description\` and \`target\` are required; two files with one name are both rejected.
- Values are escaped as quoted WQL strings: a value is only ever matched against.
- An argument the pattern does not declare is an error listing the ones it does.
- \`target.kind\`: callable, function, method, class, interface, struct, type, or custom (\`customTag\`).`,
  },

  federation: {
    name: 'federation',
    title: 'Federation: Searching Several Repositories',
    description: 'workspace.json federation block, --federated and --repo.',
    content: `# Federation

Search this repository together with others that have their own anvesa index.

### Configure (\`.anvesa/workspace.json\`)
\`\`\`json
{
  "federation": {
    "repositories": [
      { "name": "payments", "path": "../payments", "weight": 1.0 }
    ]
  }
}
\`\`\`
- \`name\` is unique and is what \`--repo\` takes; \`path\` is relative to this project; \`weight\` (> 0) scales its rank.
- \`"enabled": false\` turns it off without deleting the list.

### Commands
- \`anvesa federation status\` — Each repository: ready, unindexed, missing or error.
- \`anvesa search "<q>" --federated\` — The host and every ready repository, fused by rank.
- \`anvesa search "<q>" --repo payments\` — Only the named repositories (the host's own name included).
- \`anvesa dependents <path> --federated\` — Importers of a file across repositories.

### Rules
- Results carry \`repo\`, and keep the similarity (\`bestScore\`) their repository gave them.
- An unknown \`--repo\` is an error; a configured one that is not ready is reported in \`degraded\`.
- Every repository must be indexed with the same model, or it is reported as degraded.
- Only search and dependents reach other repositories; query and retrieve refuse \`--federated\`.`,
  },

  telemetry: {
    name: 'telemetry',
    title: 'Telemetry',
    description: 'What anonymous usage telemetry sends, and turning it off.',
    content: `# Telemetry (\`anvesa telemetry\`)

Anonymous usage telemetry: which command or tool ran, how long it took, bucketed result counts, the
model, the language, error codes and the platform. Never code, queries or paths.

- \`anvesa telemetry status\` — Whether this run sends, and why.
- \`anvesa telemetry off\` / \`on\` — Your choice, kept in your user config.
- \`"telemetry": false\` in \`.anvesa/config.json\` — Off for everyone working in the project.
- \`DO_NOT_TRACK=1\` (or \`ANVESA_NO_TELEMETRY=1\`) — Off for any process that sees it.
- \`--no-network\` (or \`ANVESA_NO_NETWORK=1\`) — Blocks every outbound connection for a run.
- Off in CI (when \`CI\` is set). The MCP server never shows the notice, so it sends nothing until
  the notice has been seen once on a terminal.`,
  },
};

export const PRIMER_TOPIC_NAMES = Object.keys(PRIMER_TOPICS);

export interface PrimerResult {
  readonly topic: string;
  readonly title: string;
  readonly description?: string;
  readonly content: string;
  readonly lineCount: number;
  readonly availableTopics: readonly string[];
}

export function getPrimer(topic?: string): PrimerResult {
  const normalized = topic?.trim().toLowerCase();
  if (!normalized || normalized === 'help' || normalized === 'index' || normalized === 'toc') {
    const lines = [
      '# Anvesa Concept Primer',
      '',
      'Token-frugal guidance on Anvesa architecture and commands for agents and developers.',
      '',
      '### Available Topics',
      ...PRIMER_TOPIC_NAMES.map((name) => {
        const info = PRIMER_TOPICS[name] as PrimerTopicInfo;
        return `- **\`${name}\`**: ${info.description}`;
      }),
      '',
      '### Usage',
      '- CLI: `anvesa primer <topic>` (or `anvesa primer <topic> --compact`)',
      '- MCP: `primer({ topic: "<topic>" })`',
    ];
    const content = lines.join('\n');
    return {
      topic: 'index',
      title: 'Anvesa Concept Primer (Available Topics)',
      description: 'Index of all available primer topics.',
      content,
      lineCount: lines.length,
      availableTopics: PRIMER_TOPIC_NAMES,
    };
  }

  const found = PRIMER_TOPICS[normalized];
  if (!found) {
    throw new InvalidArgumentError('topic', `one of: ${PRIMER_TOPIC_NAMES.join(', ')}`, topic);
  }

  const lines = found.content.split('\n');
  return {
    topic: found.name,
    title: found.title,
    description: found.description,
    content: found.content,
    lineCount: lines.length,
    availableTopics: PRIMER_TOPIC_NAMES,
  };
}

export function renderPrimer(result: PrimerResult, compact = false): string {
  if (compact) {
    return result.content.endsWith('\n') ? result.content : `${result.content}\n`;
  }
  return `*Anvesa Primer (${result.topic})*\n\n${result.content}\n`;
}
