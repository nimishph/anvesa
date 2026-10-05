# CLI Command Reference

The `anvesa` CLI provides unified access to semantic retrieval, AST structural search, code graph traversal, and repository diagnostics.

---

## Global Options

The following flags can be passed to any Anvesa command:

| Option | Description |
| :--- | :--- |
| `--format <mode>` | Output presentation: `compact` (concise tokens), `pretty` (ANSI colors), `locations` (quickfix list), or `json` (machine readable). |
| `--json` | Shorthand for `--format json`. |
| `--root <dir>` | Path to repository root. Without it, the nearest directory at or above the current one whose `.anvesa/` holds a project (`config.json`, `workspace.json` or an index), the way git finds `.git`; none found, the current directory. `init` always scaffolds in the current directory. |
| `--limit <N>` | Maximum number of results or records to return. |
| `--cursor <token>` | Pagination cursor for subsequent result pages. |
| `--no-network` | Audit mode: strictly blocks outbound HTTP connections (`ANVESA_NO_NETWORK=1`). |
| `--help`, `-h` | Display usage and options for the given command. |
| `--version`, `-v` | Print current installed version. |

---

## Commands

### `init`
Scaffolds repository configuration and prepares local neural encoders and tree-sitter grammars.

```sh
anvesa init [options]
```

**Options:**
- `--yes`, `-y`: Non-interactive mode; automatically accept recommended encoders and parsers.
- `--force`: Overwrite existing `.anvesaignore` and `.anvesa/config.json`.
- `--model <id>`: Manually choose dense embedding model ID.
- `--no-download`: Report proposed models and parsers without downloading them.

---

### `index`
Incrementally parses source files into AST cards and dense embeddings stored in SQLite.

```sh
anvesa index [options]
```

**Options:**
- `--force`: Rebuild entire index from scratch (discards cached AST hashes).
- `--scope <path>`: Restrict indexing to a specific subdirectory.
- `--no-embed` (alias `--no-dense`): Structural AST indexing only (skips neural embedding generation).
- `--retry-quarantined`: Re-evaluate files previously flagged by red-team screens.
- `--show-walk`: Print each path the walk offers, with its outcome (`added`, `unchanged`, `quarantined`, ...), on stderr.

The summary names the model the run embedded with and its embedding size, e.g.
`model: bge-base-en-v1.5 (embedding size 768, 512 max tokens)`, or `model: none (...)` when there is no
embedder. With `--json` the same is under `embedder` (`null` when there is none).

---

### `search <query>`
Fused semantic and structural retrieval blending dense neural lanes with AST constraints.

```sh
# Natural language semantic query
anvesa search "validate session token"

# Conjunction query (combines natural language with WQL)
anvesa search "validate session token && //function"

# Output format options
anvesa search "jwt auth" --format compact
anvesa search "jwt auth" --format pretty
anvesa search "jwt auth" --format locations
anvesa search "jwt auth" --format json
```

**Options:**
- `--wql <expr>`: Filter semantic hits with a structural WQL expression.
- `--channel <name>`: Limit search to a specific channel (e.g. `code`, `docs`).
- `--exclude <lane>`: Exclude specific lanes from RRF fusion (e.g. `--exclude docs`).
- `--weight <lane>=<num>`: Custom lane multiplier in RRF fusion (e.g. `--weight docs=0.5`).
- `--scope <path>`: Only results from that path or under it, e.g. `--scope packages/api`. The path is relative
  to the project root and matches whole segments (`src` does not match `src2/`). Every lane applies it before
  ranking, documentation included, so a narrow scope still returns a full page. Records with no file under the
  path (an issue channel, say) are left out. A scope that could never match (absolute, or with `..`) is refused.
  `query` and `retrieve` take it too, and the MCP `search`, `query` and `retrieve_*` tools take a `scope` field.

---

### `query '<wql>'`
Pure structural search using Wildcard Query Language (WQL) against the indexed AST outline.

```sh
# Exact symbol definition lookup
anvesa query '//function[@name="parseConfig"]'

# Methods within classes
anvesa query '//class//method[@visibility="public"]'

# Hybrid structural + semantic ranking
anvesa query '//function && database connection pool'
```

**Options:**
- `--semantic <query>`: Natural language query used to rank structural AST hits.

---

### `callers <symbol>`
Find all call sites that invoke a target function, method, or symbol.

```sh
anvesa callers parseConfig
anvesa callers Store.get
anvesa callers src/config.ts:42
```

**Options:**
- `--resolved-only`: Filter out ambiguous dynamic call sites; return only verified bindings.

---

### `callees <symbol>`
Inspect outgoing function and method calls originating from a target symbol.

```sh
anvesa callees handleAuthRequest
```

---

### `neighbors <symbol>`
Display both callers and callees together to understand immediate locality context.

```sh
anvesa neighbors Database.connect
```

---

### `dependents <path>`
Evaluate the blast radius of a source file by listing all files that import it directly or transitively.

```sh
anvesa dependents src/types.ts
anvesa dependents src/types.ts --depth 3
anvesa dependents src/types.ts --types
```

**Options:**
- `--depth <N>`: Maximum import chain traversal depth (default: 1).
- `--types`: Include TypeScript type-only imports (`import type`).

---

### `map [dir]`
Generates an architectural repomap weighted by PageRank centrality.

```sh
anvesa map
anvesa map packages/core --depth 2 --budget 1500
```

**Options:**
- `--budget <N>`: Maximum token budget for the repomap.
- `--depth <N>`: Directory nesting depth.

---

### `routes [method] [path]`
Auto-discovers HTTP endpoints across Express, Next.js, FastAPI, and Laravel frameworks.

```sh
anvesa routes
anvesa routes GET
anvesa routes POST /api/v1/auth
```

---

### `primer [topic]`
Token-frugal guidance cheatsheets designed for AI agents and developers.

```sh
# List available topics
anvesa primer

# View specific topic
anvesa primer wql
anvesa primer overview --compact
```

---

### `mapping <action>`
How a language's syntax becomes an outline: `list|show|train|audit|refine|fork|lock|remove|verify|check`.

```sh
anvesa mapping train csharp --samples ./src --samples ./tests
anvesa mapping train csharp --samples ./src --tags tags.scm   # start from the grammar's tag queries
anvesa mapping train csharp --samples ./src --assist          # ask a language model about what is left
```

**Options (train):**
- `--samples <dir|file>`: Code to learn from (repeatable).
- `--replace`: Learn from scratch instead of extending the mapping in effect.
- `--min-samples N` (default 10), `--min-files N` (default 3): How much evidence a mapping needs.
- `--tags <tags.scm>`: Start from the grammar's own definitions and calls.
- `--assist`: Ask a language model (key from `OPENROUTER_API_KEY` or `ANVESA_ASSIST_API_KEY`); answers are
  checked against the samples and kept in `.anvesa/assist/`. `--assist-model <id>` picks the model,
  `--assist-refresh` asks again. Refused under `--no-network`.

---

### `status`
Displays index health, database size, freshness timestamp, and active embedding models.

```sh
anvesa status
```

---

### `where [root|config|index|models]`
Shows which project a command run here would use and how it was found (named by `--root`, the
nearest project above the current directory, or the current directory), with the paths of its
config, index and models. It opens nothing, so it answers even when the index or config is broken.
Name one path to print just that path, for scripts.

```sh
anvesa where
anvesa where config        # e.g. $EDITOR "$(anvesa where config)"
anvesa where --json
```

---

### `mcp serve`
Launches the native Model Context Protocol (MCP) server daemon over `stdio` for agent IDE integration.

```sh
anvesa mcp serve
```
