---
name: anvesa
description: Find code by meaning and structure using anvesa (@cntxt-labs/anvesa). Use when searching a codebase for concepts, finding declarations, tracing callers/callees/dependents, querying AST structure with WQL, or running named query patterns. Prefer anvesa over grep for semantic intent, symbol relationships, and structural invariants.
version: "0.2.0"
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
| **Run team-defined architectural queries** | `anvesa pattern run <name> [--param=val]` | Pre-baked, validated structural patterns. |
| **Read known file / local edit** | Standard file read / edit tools | Anvesa is for search and graph discovery, not file editing. |

---

## CLI & MCP Reference

### 1. Indexing (Run first or when files change)

```bash
anvesa index                     # incremental (only changed files read)
anvesa index --force             # rebuild full index from scratch
anvesa index --no-dense          # structural & graph only (no embedding pass)
```

### 2. Search by Meaning & Name (Dense + Structural Fusion)

```bash
anvesa search "parse configuration file"
anvesa search "auth middleware" --exclude docs    # exclude doc cards when target is strictly code
anvesa search "user session" --limit 10          # page results (default 1000)
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
anvesa query '//class[@name=~"^Payment.*Handler"]' # regex match on attribute

# Boolean logic (and, or, not / !)
anvesa query '//function[@name="find" or @name="findById"]'
anvesa query '//method[not(@name^="test")]'
anvesa query '//function[(@export=true or @async=true) and not(@deprecated)]'
```

#### Supported Selectors:
- `//tag`: Descendant combinator (matches at any depth).
- `//parent>child`: Direct child combinator.
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

### 4. Graph Navigation & Graph-Weighted RepoMap

```bash
anvesa callers <symbol-name-or-path:line>    # who calls this symbol
anvesa callees <symbol-name-or-path:line>    # what does this symbol call
anvesa neighbors <symbol-name-or-path:line>  # enclosing scope, siblings, and call targets
anvesa dependents <path/to/file.ts>          # which files import this file
anvesa map                                   # graph-weighted repo map (PageRank on call/import graph)
anvesa map --budget 500 --depth 2            # budget-constrained dense ASCII tree
anvesa map [directory]                       # repo map scoped to subdirectory
```

### 5. HTTP Route & Endpoint Extraction

```bash
anvesa routes                                # list all HTTP endpoints discovered across the project
anvesa routes POST                           # filter by HTTP method
anvesa routes /api/users                     # filter by route path template
anvesa routes --framework express            # filter by framework (laravel, express, nextjs, etc.)
```

### 6. Architectural Explanation, Diagnostics & Issue Reporting

```bash
anvesa explain                                           # summary of languages, packages, top symbols
anvesa diagnose "parse config" --expect src/config.ts    # why an expected file did not rank in top hits
anvesa issue "Describe bug or request"                   # open pre-filled GitHub issue with sanitized diagnostics
```

### 7. Language Mappings (Bundled, Auditing & Refinement)

Bundled mappings: TypeScript/JS/Vue, Python, PHP, Go, Rust, Java, Ruby, C, C++.

```bash
anvesa mapping list                          # list active mappings and tiers (bundled, project, user)
anvesa mapping audit <language>              # inspect codebase and report unmapped syntax node types
anvesa mapping refine <language>             # automatically learn and install unmapped node rules
anvesa mapping train <language> --samples <dir> # learn a complete mapping from scratch
```

### 8. Channels & Patterns

```bash
anvesa channel list                          # list registered channels
anvesa retrieve <channel> "<query>"          # retrieve from a specific channel (e.g. digests, runbooks)
anvesa pattern list                          # list available query patterns
anvesa pattern run <name> [--param=val]      # execute named parameterized pattern
```

---

## Paging & Large Result Sets

`anvesa` enforces strict engineering standards: **no static caps and no blind truncation**.
When results exceed `--limit`:
- The response returns a `nextCursor` token.
- To fetch the next page, pass `--cursor <token>`.
- Never guess or truncate in agent scripts; iterate via cursors when full coverage is required.

---

## MCP Server Usage

If `anvesa` is running as an MCP server:
- `search`: parameters `{ "query": string, "exclude"?: string[], "limit"?: number, "cursor"?: string }`
- `query`: parameters `{ "wql": string, "limit"?: number, "cursor"?: string }`
- `callers`: parameters `{ "target": string }`
- `callees`: parameters `{ "target": string }`
- `neighbors`: parameters `{ "target": string }`
- `dependents`: parameters `{ "path": string, "depth"?: number, "limit"?: number, "includeTypeOnly"?: boolean }`
- `repomap`: parameters `{ "depth"?: number, "budget"?: number, "scope"?: string }`
- `routes`: parameters `{ "method"?: string, "path"?: string, "framework"?: string }`
- `explain`: parameters `{}`
- `diagnose`: parameters `{ "query": string, "expect": string }`
- `pattern_list`: parameters `{}`
- `pattern_run`: parameters `{ "name": string, "params"?: Record<string, string> }`
