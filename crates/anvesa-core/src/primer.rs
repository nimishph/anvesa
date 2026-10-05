use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrimerTopicInfo {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub content: &'static str,
}

pub const PRIMER_TOPICS: &[PrimerTopicInfo] = &[
    PrimerTopicInfo {
        name: "overview",
        title: "Anvesa: Hybrid Code Intelligence Overview",
        description: "Core philosophy, command cheatsheet, and decision heuristic table.",
        content: r#"# Anvesa: Hybrid Code Intelligence

Anvesa combines dense semantic search (ONNX embeddings) with structural AST analysis (Tree-sitter & WQL), fused via Reciprocal Rank Fusion (RRF).

### Decision Heuristic Table
| Task / Goal | Recommended Tool / Command |
| :--- | :--- |
| Search by concept/behavior | `anvesa search <concept>` (fused dense + structure) |
| Find exact symbol definition | `anvesa query '//function[@name="foo"]'` |
| Trace call hierarchy | `anvesa callers <symbol>` / `callees <symbol>` |
| Trace blast radius (who imports) | `anvesa dependents <file>` |
| Discover HTTP endpoints | `anvesa routes [method] [path]` |
| Exact string / regex search | Standard ripgrep / grep |

### Essential Commands
- `anvesa init` — Scaffold ignore and configs, download models & parsers.
- `anvesa index` — Incrementally parse AST outlines and embed cards.
- `anvesa search <question>` — Fused semantic & structural search.
- `anvesa retrieve <channel> <q>` — Search a single dense channel on its own.
- `anvesa query '<wql>'` — Structural AST query.
- `anvesa callers|callees|neighbors <symbol>` — Call and locality graphs.
- `anvesa dependents <path>` — Import dependency blast radius.
- `anvesa map [dir]` — PageRank-weighted architectural repomap.
- `anvesa explain` — High-level repository structural summary.
- `anvesa status` — Check index freshness, models, and channels.
- `anvesa where [config]` — Which project is in use, how it was found, and its config, index and models paths.
- `anvesa primer [topic]` — Token-frugal concept guidance for agents.
- `anvesa mcp serve` — Zero-runtime Model Context Protocol server."#,
    },
    PrimerTopicInfo {
        name: "wql",
        title: "Wildcard Query Language (WQL) Cheatsheet",
        description: "Structural query syntax, axes, predicates, regex matching, and conjunctions.",
        content: r#"# Wildcard Query Language (WQL)

WQL queries the structural AST outline of the repository without regex guesswork.

### Axes & Tags
- `//` — Descendant axis (any depth): `//class//method`
- `/` — Direct child axis: `//class/method`
- Normalized tags: `//callable`, `//function`, `//method`, `//class`, `//interface`

### Predicates & Filters
- Name match: `//function[@name="parseConfig"]`
- Name regex: `//function[@name=~"^validate[A-Z]"]`
- Declaration vs call: `//callable[@declaration]`
- Visibility: `//method[@visibility="public"]`
- Signature prefix: `//function[@signature^="(path: string)"]`

### Conjunction Queries (Semantic + Structural)
Combine natural language meaning with strict AST constraints:
- CLI: `anvesa search "parse config && //function"`
- CLI: `anvesa query '//function && parse config'`
- MCP: `search({ query: "handle auth", wql: "//class//method" })`"#,
    },
    PrimerTopicInfo {
        name: "fusion",
        title: "Reciprocal Rank Fusion (RRF) Mechanics",
        description: "How dense and structural lanes are blended, scoring, and lane filtering.",
        content: r#"# Reciprocal Rank Fusion (RRF)

Anvesa blends search results from multiple independent channels using RRF:

```text
score = sum( lane_weight / (k + rank) )
```

- **Default Constant:** `k = 60` (balances top ranks against consistent presence across lanes).
- **Lanes:**
  - `dense` — Local neural embeddings (e.g. MiniLM, BGE).
  - `structural` — AST nodes matching WQL queries.
  - `docs` & custom channels — Project-specific extractions.

### Score Interpretation
- **Fused `score`**: Relative rank position across lanes for *this query only*. Never compare scores between different queries.
- **`bestScore`**: True cosine similarity from the strongest semantic lane (0.0 to 1.0). Absent when matched only by structure.

### Lane Filtering Best Practice
To omit docs or noise, prefer boolean exclusion over small weights:
- `anvesa search "auth" --exclude docs`
- In config: `"search": { "excludeLanes": ["docs"] }`"#,
    },
    PrimerTopicInfo {
        name: "graph",
        title: "Code Graph: Blast Radius, Call Trees, and Locality",
        description: "Navigating callers, callees, dependents, and neighbors in the symbol graph.",
        content: r#"# Code Graph Navigation

Anvesa maintains an incremental symbol dependency graph in SQLite.

### Commands
1. **Call Hierarchy:**
   - `anvesa callers <symbol>` — Find who invokes this function/method.
   - `anvesa callees <symbol>` — Find symbols this function calls.
2. **Blast Radius (File Dependencies):**
   - `anvesa dependents <path>` — Files that import or depend on this file.
   - Essential before refactoring or removing exports.
3. **Locality & Neighbors:**
   - `anvesa neighbors <symbol>` — Symbols declared in the same scope or file."#,
    },
    PrimerTopicInfo {
        name: "indexing",
        title: "Incremental Indexing & Storage Architecture",
        description: "AST caching, sharded fragment databases, and offline indexing.",
        content: r#"# Indexing & Storage Architecture

Anvesa stores index data in `.anvesa/index.db` (or fragmented databases for large repositories).

### Indexing Options
- `anvesa index` — Incremental run; only processes modified or added files.
- `anvesa index --force` — Rebuilds AST outlines and cards from scratch.
- `anvesa index --scope <path>` — Limit indexing to a specific subdirectory.
- `anvesa index --no-embed` (alias `--no-dense`) — Structural AST and graph only (no embedding pass).
- `anvesa index --retry-quarantined` — Re-evaluates previously quarantined files.
- `anvesa index --show-walk` — Prints each path walked, with its outcome, on stderr.

### Fragment Sharding (`anvesa fragments`)
- `anvesa fragments status|propose|enable|disable|settle` — one database per fragment."#,
    },
    PrimerTopicInfo {
        name: "grammars",
        title: "Grammars & Mappings",
        description: "Tree-sitter grammars, mappings, and supported languages.",
        content: r#"# Grammars & Mappings

### Tree-sitter Grammars (`anvesa grammar`)
- `grammar list` — Inspect status and SHA-256 hashes of installed parsers.
- `grammar install <lang>` — Install from prebuilt WASM or local directory.
- `mapping list|show|train|audit|refine|fork|lock|remove|verify|check` — Manage syntax-to-card mappings.
- `mapping train <lang> --samples <dir>` — Learn a mapping from code; `--tags <tags.scm>` starts from the
  grammar's own definitions and calls, `--assist` asks a language model (OPENROUTER_API_KEY) about the rest.

### Bundled Mappings
- TypeScript, JavaScript (and Vue, through TypeScript), Python, PHP, Go, Rust, Java, Ruby.
- C/C++ partial: functions come out unnamed; use `//function`, not `[@name=...]`.
- C# none: train one with `anvesa mapping train csharp --samples <dir>`."#,
    },
];

pub fn get_primer_topic(name: &str) -> Option<&'static PrimerTopicInfo> {
    PRIMER_TOPICS.iter().find(|t| t.name.eq_ignore_ascii_case(name))
}

pub fn list_primer_topics() -> Vec<(&'static str, &'static str)> {
    PRIMER_TOPICS.iter().map(|t| (t.name, t.title)).collect()
}
