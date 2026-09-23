---
name: code-lens
description: Find code by meaning and structure using code-lens (@cntxt-labs/code-lens). Use when searching a codebase for concepts, finding declarations, tracing callers/callees/dependents, querying AST structure with WQL, or running named query patterns. Prefer code-lens over grep for semantic intent, symbol relationships, and structural invariants.
version: "0.1.0"
---

# code-lens: Semantic & Structural Code Retrieval

`code-lens` is a standalone, offline-capable code retrieval and code intelligence tool. It combines **dense retrieval** (local embeddings), **structural retrieval** (WQL over AST outlines), and **call-graph navigation** into fused, graded search results.

---

## Decision Heuristic: When to Use What

| Goal | Tool / Command | Why not grep? |
|---|---|---|
| **Find what code does by concept / intent** ("handle Stripe webhook signature", "parse auth header") | `code-lens search "intent"` | Grep only matches exact words. Search uses local embeddings and red-team-screened doc/symbol cards. |
| **Find definition of a symbol** | `code-lens query '//function[@name="foo"][@declaration]'` | Grep matches every mention, comment, and test string. WQL targets only the declaration node. |
| **Find any callable by name across TS, Python, Go, Rust** | `code-lens query '//callable[@name="save"]'` | Normalizes across functions, methods, arrows, and lambdas. |
| **Trace call graph / blast radius** | `code-lens callers <sym>`, `callees <sym>`, `dependents <path>` | Grep cannot resolve import paths or cross-package symbol references. |
| **Inspect symbol surroundings** | `code-lens neighbors <sym>` | Returns enclosing class/interface, sibling methods, and outgoing calls. |
| **Check non-code corpora** (runbooks, ADRs, past digests) | `code-lens retrieve <channel> "<query>"` | Scoped directly to the target domain channel. |
| **Run team-defined architectural queries** | `code-lens pattern run <name> [--param=val]` | Pre-baked, validated structural patterns. |
| **Read known file / local edit** | Standard file read / edit tools | Code-lens is for search and graph discovery, not file editing. |

---

## CLI & MCP Reference

### 1. Indexing (Run first or when files change)

```bash
code-lens index                     # incremental (only changed files read)
code-lens index --force             # rebuild full index from scratch
code-lens index --no-dense          # structural & graph only (no embedding pass)
```

### 2. Search by Meaning & Name (Dense + Structural Fusion)

```bash
code-lens search "parse configuration file"
code-lens search "auth middleware" --exclude docs    # exclude doc cards when target is strictly code
code-lens search "user session" --limit 10          # page results (default 1000)
```
- Hits are fused using Reciprocal Rank Fusion (RRF). Each hit reports its score and which lanes found it (`dense`, `structural`, `docs`).
- **Critical rule:** If you only care about code implementations, pass `--exclude docs`. Do not use low weights like `--weight docs=0.1`, because RRF ranks by position and low weights will distort rankings.

### 3. Structural Queries with WQL

WQL selects nodes from the compact AST outline:

```bash
code-lens query '//function[@name="parseConfig"]'
code-lens query '//class//method[@name^="get"]'
code-lens query '//callable[@name="save"]'
code-lens query '//function[@declaration]'            # declarations only (ignores calls/references)
code-lens query '//class[@name=~"^Payment.*Handler"]' # regex match on attribute
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

### 4. Graph Navigation

```bash
code-lens callers <symbol-name-or-path:line>    # who calls this symbol
code-lens callees <symbol-name-or-path:line>    # what does this symbol call
code-lens neighbors <symbol-name-or-path:line>  # enclosing scope, siblings, and call targets
code-lens dependents <path/to/file.ts>          # which files import this file
```

### 5. Architectural Explanation & Diagnostics

```bash
code-lens explain                                           # summary of languages, packages, top symbols
code-lens diagnose "parse config" --expect src/config.ts    # why an expected file did not rank in top hits
```

### 6. Channels & Patterns

```bash
code-lens channel list                          # list registered channels
code-lens retrieve <channel> "<query>"          # retrieve from a specific channel (e.g. digests, runbooks)
code-lens pattern list                          # list available query patterns
code-lens pattern run <name> [--param=val]      # execute named parameterized pattern
```

---

## Paging & Large Result Sets

`code-lens` enforces strict engineering standards: **no static caps and no blind truncation**.
When results exceed `--limit`:
- The response returns a `nextCursor` token.
- To fetch the next page, pass `--cursor <token>`.
- Never guess or truncate in agent scripts; iterate via cursors when full coverage is required.

---

## MCP Server Usage

If `code-lens` is running as an MCP server:
- `search`: parameters `{ "query": string, "exclude"?: string[], "limit"?: number, "cursor"?: string }`
- `query`: parameters `{ "wql": string, "limit"?: number, "cursor"?: string }`
- `callers`: parameters `{ "target": string }`
- `callees`: parameters `{ "target": string }`
- `neighbors`: parameters `{ "target": string }`
- `dependents`: parameters `{ "path": string }`
- `explain`: parameters `{}`
- `diagnose`: parameters `{ "query": string, "expect": string }`
- `pattern_list`: parameters `{}`
- `pattern_run`: parameters `{ "name": string, "params"?: Record<string, string> }`
