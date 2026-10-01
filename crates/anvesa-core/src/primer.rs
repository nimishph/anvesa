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
        title: "Incremental Indexing & Grammar Management",
        description: "How changes are detected, caching, and --no-dense fast passes.",
        content: r#"# Incremental Indexing

Anvesa tracks file modification times and content hashes in SQLite.

### Indexing Modes
- `anvesa index` — Full structural outline and neural embedding pass.
- `anvesa index --no-dense` — Fast AST-only index (skips embeddings, <2 seconds).
- `anvesa index --force` — Rebuilds all cards and hashes from scratch."#,
    },
    PrimerTopicInfo {
        name: "grammars",
        title: "Tree-Sitter Grammars & Tier-1 Language Support",
        description: "Built-in Tier-1 languages and custom grammar management.",
        content: r#"# Grammars & Supported Languages

### Built-in Tier-1 Languages (Native Rust Tree-Sitter)
- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
- Python (`.py`)
- Rust (`.rs`)
- Go (`.go`)

### Grammar Discovery & Lockfiles
Grammars are verified with SHA-256 integrity checksums stored in `.anvesa/grammars.lock`."#,
    },
];

pub fn get_primer_topic(name: &str) -> Option<&'static PrimerTopicInfo> {
    PRIMER_TOPICS.iter().find(|t| t.name.eq_ignore_ascii_case(name))
}

pub fn list_primer_topics() -> Vec<(&'static str, &'static str)> {
    PRIMER_TOPICS.iter().map(|t| (t.name, t.title)).collect()
}
