---
name: anvesa
description: Find code by meaning and structure using anvesa (@cntxt-labs/anvesa). Use when searching a codebase for concepts, finding declarations, tracing callers/callees/dependents, querying AST structure with WQL, or running named query patterns. Prefer anvesa over grep for semantic intent, symbol relationships, and structural invariants.
version: "0.8.0-alpha.3"
---

# anvesa: Semantic & Structural Code Retrieval

`anvesa` is a standalone, offline-capable code retrieval and code intelligence tool. It combines **dense retrieval** (local embeddings), **structural retrieval** (WQL over AST outlines), and **call-graph navigation** into fused, graded search results.

---

## Decision Heuristic: When to Use What

| Goal | Tool / Command | Why not grep? |
|---|---|---|
| **Find what code does by concept / intent** ("handle Stripe webhook signature", "parse auth header") | `anvesa search "intent"` | Grep only matches exact words. Search uses local embeddings and red-team-screened doc/symbol cards. |
| **Find definition of a symbol** | `anvesa query '//function[@name="foo"][@declaration]'` | Grep matches every mention, comment, and test string. WQL targets only the declaration node. |
| **Find any callable by name across TS, Python, Go, Rust** | `anvesa query '//callable[@name="save"]'` | Normalizes across functions, methods, arrows, and lambdas. |
| **Trace call graph / blast radius** | `anvesa callers <sym>`, `callees <sym>`, `dependents <path>` | Grep cannot resolve import paths or cross-package symbol references. |
| **Inspect symbol surroundings** | `anvesa neighbors <sym>` | Returns enclosing class/interface, sibling methods, and outgoing calls. |
| **Check non-code corpora** (runbooks, ADRs, past digests) | `anvesa retrieve <channel> "<query>"` | Scoped directly to the target domain channel. |
| **Run team-defined architectural queries** | `anvesa pattern run <name> key=value` | Pre-baked, validated structural patterns. |
| **Read known file / local edit** | Standard file read / edit tools | Anvesa is for search and graph discovery, not file editing. |

---

## CLI & MCP Reference

### 1. Indexing (Run first or when files change)

```bash
anvesa index                     # incremental (only changed files read)
anvesa index --force             # rebuild full index from scratch
anvesa index --no-embed          # structural & graph only (no embedding pass)
```

### 2. Search by Meaning & Name (Dense + Structural Fusion)

```bash
anvesa search "parse configuration file"
anvesa search "auth middleware" --exclude docs    # exclude doc cards when target is strictly code
anvesa search "user session" --limit 10          # page results (default 20, or search.defaultLimit)
```
- Hits are fused using Reciprocal Rank Fusion (RRF). Each hit reports its score and which lanes found it (`dense`, `structural`, `docs`).
- **Critical rule:** If you only care about code implementations, pass `--exclude docs`. Do not use low weights like `--weight docs=0.1`, because RRF ranks by position and low weights will distort rankings.

### 3. Structural Queries with WQL

WQL selects nodes from the compact AST outline:

```bash
anvesa query '//function[@name="parseConfig"]'
anvesa query '//class//method[@name^="get"]'
anvesa query '//callable[@name="save"]'
anvesa query '//function[@declaration]'            # declarations only (ignores calls/references)
anvesa query '//class[@name~="^Payment.*Handler"]' # regex match on attribute (=~ also works)

# Boolean logic (and, or, not / !)
anvesa query '//function[@name="find" or @name="findById"]'
anvesa query '//method[not(@name^="test")]'
anvesa query '//callable[(@name^="get" or @name^="find") and not(@isMethod)]'
```

#### Supported Selectors:
- `//tag`: Descendant combinator (matches at any depth).
- `//parent>child` or `//parent/child`: Direct child combinator.
- `//*`: Any node.
- `//callable`: Virtual selector matching `function`, `method`, `arrow`, `lambda`, `closure`.
- `[@attr="val"]`: Exact match.
- `[@attr^="prefix"]`: Starts with.
- `[@attr$="suffix"]`: Ends with.
- `[contains(@attr, "sub")]`: Substring match.
- `[@attr~="regex"]`: Regular expression.
- `[@attr]`: Attribute existence (e.g. `[@declaration]`, `[@docs]`).
- `[expr1 and expr2]`: Logical AND.
- `[expr1 or expr2]`: Logical OR.
- `[not(expr)]` or `[!expr]`: Logical NOT.
- `[(expr1 or expr2) and expr3]`: Parenthesized precedence.

#### Attributes
`name`, `declaration`, `kind`, `line`, `endLine`, `params`, `returns`, `signature`, `path`, `doc`,
`callable`, `isMethod`, `baseName`, `assignedTo`, `aliasOf`, `hash`, `shape`, `bodyShape`,
`bodyKind`, `bodyStmts`, `shapeNodes`, `startIndex`, `endIndex`. Any other attribute is an error
that lists these. There is no `@visibility`, `@export` or `@async`. The tag is the normalized
kind; `@kind` is the grammar's own node type (`function_declaration`), so `[@kind="function"]`
matches nothing.

A query lists result files that changed or were deleted since indexing; run `anvesa index` to
refresh.

### 4. Semantic & Structural Conjunction (WQL + Dense)

Conjunction combines semantic intent (what code does) with structural AST constraints (where it is defined in the AST):

```bash
# Via flags
anvesa search "save user" --wql '//class//method'           # semantic search constrained to class methods
anvesa query '//function' --semantic "parse config file"    # structural query ranked by semantic similarity

# Via inline conjunction syntax (&&, where, AND)
anvesa search "save user && //class//method"
anvesa search "save user where //class//method"
anvesa search "//class//method && save user"
anvesa query "//function && authenticate credentials"
```

- **Intersection Semantics**: Results MUST satisfy both the semantic intent and the AST outline structure. Hits failing the WQL AST structure are filtered out.
- **Semantic Ranking**: Surviving hits are ranked by semantic relevance score.

### 5. Graph Navigation & Graph-Weighted RepoMap

```bash
anvesa callers <symbol-name-or-path:line>    # who calls this symbol
anvesa callees <symbol-name-or-path:line>    # what does this symbol call
anvesa neighbors <symbol-name-or-path:line>  # enclosing scope, siblings, and call targets
anvesa dependents <path/to/file.ts>          # which files import this file
anvesa map                                   # graph-weighted repo map (PageRank on call/import graph)
anvesa map --budget 2000                     # the highest-ranked files that fit ~2000 tokens; says what it left out
anvesa map src --depth 1                     # repo map of a subdirectory; depth counts from it
```
Use `--budget` before putting a whole-repository map in a prompt: unbudgeted, a large repository's
map runs to hundreds of KB.

### 6. HTTP Route & Endpoint Extraction

```bash
anvesa routes                                # list all HTTP endpoints discovered across the project
anvesa routes POST                           # filter by HTTP method
anvesa routes /api/users                     # filter by route path template
anvesa routes --framework express            # filter by framework (laravel, express, nextjs, etc.)
```

### 7. Architectural Explanation, Diagnostics & Issue Reporting

```bash
anvesa explain                                           # summary of languages, packages, top symbols
anvesa diagnose "parse config" --expect src/config.ts    # why an expected file did not rank in top hits
anvesa issue "Describe bug or request"                   # open pre-filled GitHub issue with sanitized diagnostics
```

### 8. Language Mappings (Bundled, Auditing & Refinement)

Bundled mappings: TypeScript/JS/Vue, Python, PHP, Go, Rust, Java, Ruby, C, C++, C#.
C and C++ are partial: structs, classes, namespaces, includes and calls are named, but functions
come out unnamed, because their names sit in nested declarators that a mapping cannot follow
(training cannot fix that either). `//function` finds them; `[@name="..."]` does not, so use text
search to find a C/C++ function by name. In C#, properties are tagged (`//property`) but, as in
TypeScript and PHP, are not outline symbols; operators, indexers and conversion operators have no
name a mapping can read and are not mapped. Teach a language with
`anvesa mapping train <language> --samples <dir>`.

```bash
anvesa mapping list                          # list active mappings and tiers (bundled, project, user)
anvesa mapping audit <language>              # inspect codebase and report unmapped syntax node types
anvesa mapping refine <language>             # automatically learn and install unmapped node rules
anvesa mapping train <language> --samples <dir> [dir...] # learn from code; extends the mapping in effect (--replace: from scratch)
```

### 9. Channels & Patterns

```bash
anvesa channel list                          # list registered channels
anvesa retrieve <channel> "<query>"          # retrieve from a specific channel (e.g. digests, runbooks)
anvesa pattern list                          # list available query patterns, and rejected files
anvesa pattern run <name> key=value          # execute a named pattern, e.g. pattern run by-prefix prefix=get
```
Pattern files live in `.anvesa/patterns/` and need `name`, `description` and `target`; see
`anvesa primer patterns`. Channels: `anvesa primer channels`.

### 10. Models

```bash
anvesa model list                            # anvesa-code, open models (gte-modernbert-base) and your own
anvesa model use anvesa-code-400m            # the model this project uses; asks when no name is given
anvesa model install <id> --download         # fetch and pin a catalog model
```
After `model use`, run `anvesa index`: search refuses an index embedded with another model
(`RETRIEVER_MODEL_MISMATCH`). See `anvesa primer models`.

### 11. Several Repositories (Federation)

```bash
anvesa federation status                     # each configured repository: ready, unindexed, missing
anvesa search "retry payment" --federated    # the host and every ready repository, fused
anvesa search "retry payment" --repo payments
anvesa dependents src/client.ts --federated  # importers across repositories
```
Configure in `.anvesa/workspace.json`:
`{"federation": {"repositories": [{"name": "payments", "path": "../payments", "weight": 1.0}]}}`.
Only search and dependents reach other repositories. See `anvesa primer federation`.

### 12. Installing this skill

```bash
anvesa skill install                     # .claude/skills/anvesa/SKILL.md in this project
anvesa skill install --agent opencode    # .opencode/skills/; --agent codex: .agents/skills/
anvesa skill install --user              # in your home folder, for every project
anvesa skill status                      # where it is installed, and at which version
```
`anvesa init` offers it. `index` and `search` keep an installed copy at the running version, and
never install one that is not there.

### 13. Primer

`anvesa primer` lists topics: overview, wql, fusion, graph, indexing, grammars, models, channels,
patterns, federation, telemetry. `anvesa primer <topic>` prints one (25-50 lines).

---

## Paging & Large Result Sets

`anvesa` enforces strict engineering standards: **no static caps and no blind truncation**.
When results exceed `--limit`:
- The response returns a `nextCursor` token.
- To fetch the next page, pass `--cursor <token>`.
- Never guess or truncate in agent scripts; iterate via cursors when full coverage is required.

---

## MCP Server Usage

If `anvesa` is running as an MCP server (`anvesa mcp serve`):
- `search`: parameters `{ "query": string, "wql"?: string, "channels"?: string[], "exclude"?: string[], "weights"?: Record<string, number>, "scope"?: string, "format"?: "compact" | "full" | "locations", "full"?: boolean, "limit"?: number, "cursor"?: string }`
- `retrieve_<channel>` (one per channel, e.g. `retrieve_symbols`, `retrieve_docs`): parameters `{ "query": string, "scope"?: string, "limit"?: number, "cursor"?: string }`
- `query`: parameters `{ "wql": string, "semantic"?: string, "scope"?: string, "limit"?: number, "cursor"?: string }`
- `callers`: parameters `{ "target": string, "resolvedOnly"?: boolean, "limit"?: number, "cursor"?: string }`
- `callees`: parameters `{ "target": string, "limit"?: number, "cursor"?: string }`
- `neighbors`: parameters `{ "target": string, "limit"?: number, "cursor"?: string }`
- `dependents`: parameters `{ "path": string, "depth"?: number, "limit"?: number, "includeTypeOnly"?: boolean }`
- `repomap`: parameters `{ "depth"?: number, "budget"?: number, "scope"?: string }`
- `routes`: parameters `{ "method"?: string, "path"?: string, "framework"?: string }`
- `explain`: parameters `{ "limit"?: number }`
- `diagnose`: parameters `{ "query": string, "path": string, "depth"?: number }`
- `status`: parameters `{}`
- `index`: parameters `{ "force"?: boolean }`
- `pattern_list`: parameters `{}`
- `pattern_run`: parameters `{ "name": string, "args"?: Record<string, string>, "limit"?: number, "cursor"?: string }`
- `primer`: parameters `{ "topic"?: string }`
- `show_in_ui`: parameters `{ "query"?: string, "mode"?: "fused" | "semantic" | "structural", "wql"?: string, "scope"?: string, "symbol"?: string, "view"?: "search" | "graph" | "wql" | "status", "repomap"?: boolean, "routes"?: boolean, "open"?: boolean }`
