# Token-Frugal Primer

When an AI agent or developer is working inside a codebase, reading a 10-page manual or pulling full documentation into an LLM context window wastes thousands of tokens.

Anvesa provides a built-in **Token-Frugal Primer** system (`§anv-35b`). Each primer topic delivers a focused, 25-to-50-line cheatsheet containing only the syntax, commands, and rules needed for immediate execution.

---

## Available Primer Topics

| Topic | Description | Token Footprint |
| :--- | :--- | :--- |
| **`overview`** | Philosophy, command cheatsheet, and decision heuristic table. | ~250 tokens |
| **`wql`** | Wildcard Query Language syntax, axes, predicates, regex matching. | ~200 tokens |
| **`fusion`** | Reciprocal Rank Fusion mechanics, scoring formula, lane filtering. | ~180 tokens |
| **`graph`** | Callers, callees, dependents blast radius, repomap, routes. | ~200 tokens |
| **`indexing`** | Incremental runs, storage partitioning, fragment databases. | ~190 tokens |
| **`grammars`** | Tree-sitter parsers, ONNX models, hardware doctor, red-team screens. | ~220 tokens |

---

## CLI Usage

### Listing Available Topics
```sh
anvesa primer
```

### Fetching a Specific Topic
```sh
# Formatted topic view
anvesa primer wql

# Ultra-compact mode (raw markdown without headers/footers)
anvesa primer wql --compact
```

### JSON Mode for Tool Chaining
```sh
anvesa primer graph --json
```

---

## Agent / MCP Usage

In agent environments, models can invoke the `primer` MCP tool dynamically to teach themselves how to formulate complex queries on the fly:

```json
{
  "tool": "primer",
  "arguments": {
    "topic": "wql",
    "compact": true
  }
}
```

The agent receives the exact syntax for descendant axes (`//`), predicates (`[@name=...]`), and conjunctions (`&&`) in under 200 tokens, then immediately proceeds to execute its search.
