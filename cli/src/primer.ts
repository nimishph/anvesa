/**
 * Token-frugal primer for agents and developers (§anv-35b).
 * Provides focused, 25-50 line explanations of Anvesa concepts to prevent context bloat.
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

Anvesa combines dense semantic search (ONNX embeddings) with structural AST analysis (Tree-sitter & WQL), fused via Reciprocal Rank Fusion (RRF).

### Decision Heuristic Table
| Task / Goal | Recommended Tool / Command |
| :--- | :--- |
| Search by concept/behavior | \`anvesa search <concept>\` (fused dense + structure) |
| Find exact symbol definition | \`anvesa query '//function[@name="foo"]'\` |
| Trace call hierarchy | \`anvesa callers <symbol>\` / \`callees <symbol>\` |
| Trace blast radius (who imports) | \`anvesa dependents <file>\` |
| Discover HTTP endpoints | \`anvesa routes [method] [path]\` |
| Exact string / regex search | Standard ripgrep / grep |

### Essential Commands
- \`anvesa init\` — Scaffold ignore and configs, download models & parsers.
- \`anvesa index\` — Incrementally parse AST outlines and embed cards.
- \`anvesa search <question>\` — Fused semantic & structural search.
- \`anvesa retrieve <channel> <q>\` — Search a single dense channel on its own.
- \`anvesa query '<wql>'\` — Structural AST query.
- \`anvesa callers|callees|neighbors <symbol>\` — Call and locality graphs.
- \`anvesa dependents <path>\` — Import dependency blast radius.
- \`anvesa map [dir]\` — PageRank-weighted architectural repomap.
- \`anvesa explain\` — High-level repository structural summary.
- \`anvesa status\` — Check index freshness, models, and channels.
- \`anvesa primer [topic]\` — Token-frugal concept guidance for agents.
- \`anvesa mcp serve\` — Zero-runtime Model Context Protocol server.`,
  },

  wql: {
    name: 'wql',
    title: 'Wildcard Query Language (WQL) Cheatsheet',
    description: 'Structural query syntax, axes, predicates, regex matching, and conjunctions.',
    content: `# Wildcard Query Language (WQL)

WQL queries the structural AST outline of the repository without regex guesswork.

### Axes & Tags
- \`//\` — Descendant axis (any depth): \`//class//method\`
- \`/\` — Direct child axis: \`//class/method\`
- Normalized tags: \`//callable\`, \`//function\`, \`//method\`, \`//class\`, \`//interface\`

### Predicates & Filters
- Name match: \`//function[@name="parseConfig"]\`
- Name regex: \`//function[@name=~"^validate[A-Z]"]\`
- Declaration vs call: \`//callable[@declaration]\`
- Visibility: \`//method[@visibility="public"]\`
- Signature prefix: \`//function[@signature^="(path: string)"]\`

### Conjunction Queries (Semantic + Structural)
Combine natural language meaning with strict AST constraints:
- CLI: \`anvesa search "parse config && //function"\`
- CLI: \`anvesa query '//function && parse config'\`
- MCP: \`search({ query: "handle auth", wql: "//class//method" })\``,
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
  - \`dense\` — Local neural embeddings (e.g. MiniLM, BGE).
  - \`structural\` — AST nodes matching WQL queries.
  - \`docs\` & custom channels — Project-specific extractions.

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
- \`neighbors <symbol>\`: Locality cluster (symbols defined in the same scope or file).
- \`dependents <path>\`: Blast radius of a file (which files import it directly or transitively).
  - Options: \`--depth <N>\`, \`--limit <N>\`, \`--types\` (include type-only imports).
- \`map [dir]\`: PageRank architectural repomap fitting into a token budget.
  - Options: \`--budget <tokens>\`, \`--depth <N>\`.
- \`routes [method] [path]\`: Auto-discovers HTTP endpoints across Express, Next.js, FastAPI, Laravel.

### Targeting Symbols
Specify targets by symbol name, ID, or file location:
- Name: \`anvesa callers parseConfig\`
- Location: \`anvesa callers src/config.ts:45\``,
  },

  indexing: {
    name: 'indexing',
    title: 'Incremental Indexing & Storage Architecture',
    description: 'AST caching, sharded fragment databases, and offline indexing.',
    content: `# Indexing & Storage Architecture

Anvesa stores index data in \`.anvesa/index.db\` (or fragmented databases for large repositories).

### Indexing Options
- \`anvesa index\` — Incremental run; only processes modified or added files.
- \`anvesa index --force\` — Rebuilds AST outlines and cards from scratch.
- \`anvesa index --scope <path>\` — Limit indexing to a specific subdirectory.
- \`anvesa index --no-embed\` (alias \`--no-dense\`) — Structural AST and graph only (no embedding pass).
- \`anvesa index --retry-quarantined\` — Re-evaluates previously quarantined files.

### Fragment Sharding (\`anvesa fragments\`)
For large codebases where a single \`index.db\` exceeds 500MB:
- \`anvesa fragments status\` — Check sharding state.
- \`anvesa fragments propose\` — Compute optimal path/cluster boundaries.
- \`anvesa fragments enable\` — Split index into per-fragment databases.
- \`anvesa fragments disable\` — Merge back into a single monolith database.
- \`anvesa fragments settle\` — Clean up orphaned shards after file moves.`,
  },

  grammars: {
    name: 'grammars',
    title: 'Grammars, Models, Red-Team & Patterns',
    description:
      'Tree-sitter grammars, local embedding models, red-team policies, and diagnostics.',
    content: `# Grammars, Models & Security Tooling

### Tree-sitter Grammars (\`anvesa grammar\`)
- \`grammar list\` — Inspect status and SHA-256 hashes of installed parsers.
- \`grammar install <lang>\` — Install from prebuilt WASM or local directory.
- \`mapping list|show|train|audit|refine|fork|lock|remove|verify|check\` — Manage syntax-to-card mappings.
- \`mapping train <lang> --samples <dir>\` — Learn a mapping from code; \`--tags <tags.scm>\` starts from the
  grammar's own definitions and calls, \`--assist\` asks a language model (OPENROUTER_API_KEY) about the rest.
- Bundled: TS/JS (Vue via TS), Python, PHP, Go, Rust, Java, Ruby. C/C++ partial (functions unnamed: use
  \`//function\`, not \`[@name=...]\`). C# none: train one.

### Local Embedding Models (\`anvesa model\`)
- \`model list\` — List installed hardware tiers and ONNX models.
- \`model install <id> --download\` — Download and pin a recommended model.
- \`model doctor\` — Diagnose hardware acceleration (CPU AVX2, CoreML, DirectML).

### Security & Diagnostics
- \`redteam list|verify|scan\` — Prompt-injection screening rules and card quarantine inspector.
- \`channel add|list|show|test|index|pin|remove\` — Custom dense documentation and domain channels.
- \`pattern list|run <name>\` — Run parameterized declarative AST patterns.
- \`diagnose <query> --expect <path>\` — Explain why a target file was missed.
- \`issue [title]\` — Export sanitized diagnostics bundle for bug reporting.`,
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
