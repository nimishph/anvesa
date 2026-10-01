# Code Graph & Blast Radius

Anvesa maintains an incremental symbol call graph, locality clusters, and import dependency tree directly within its local SQLite index. This allows AI agents and developers to trace call hierarchies, investigate dependencies, and evaluate refactoring blast radius in sub-millisecond lookups.

---

## Callers and Callees

Understand how functions connect across modules without guessing with regular expressions.

### Who calls this function? (`callers`)
Find all call sites that invoke a specific symbol:

```sh
# Target by symbol name
anvesa callers parseConfig

# Target by qualified member name
anvesa callers Store.get

# Target by file location (line number)
anvesa callers src/config.ts:42
```

#### Filtering ambiguous calls
In dynamic languages or overloaded codebases, Anvesa tracks both resolved (exact signature/import bindings) and heuristic call references:
```sh
# Only show confirmed, resolved call sites
anvesa callers parseConfig --resolved-only
```

### What does this function call? (`callees`)
Inspect outgoing call paths from a function or method:
```sh
anvesa callees handleAuthRequest
```

### Locality neighborhood (`neighbors`)
Inspect callers and callees together to view immediate local code context:
```sh
anvesa neighbors "Database.connect"
```

---

## Import Dependency & Blast Radius (`dependents`)

Before modifying a core utility or interface, evaluate its **blast radius**—every file that directly or transitively imports it.

```sh
# Which files import src/types.ts?
anvesa dependents src/types.ts

# Traverse transitive dependencies up to depth 3
anvesa dependents src/types.ts --depth 3

# Include type-only imports (e.g. TypeScript `import type`)
anvesa dependents src/types.ts --types

# Cap maximum returned files
anvesa dependents src/types.ts --limit 50
```

### Output Formats for Blast Radius
```sh
# Compact line list
anvesa dependents src/types.ts --format compact

# JSON for programmatic CI/CD gates
anvesa dependents src/types.ts --format json
```

---

## Architectural Repomap (`map`)

Anvesa can generate a compact, PageRank-weighted architectural outline of your repository. Important symbols that are heavily referenced receive prominence, while trivial internals are summarized.

```sh
# Generate repomap for entire repository
anvesa map

# Scope to a specific directory
anvesa map packages/core

# Tune token budget (ideal for priming LLM context windows)
anvesa map --budget 2000

# Control traversal depth
anvesa map --depth 2
```

---

## Automatic Route Discovery (`routes`)

For web applications and APIs, Anvesa automatically extracts endpoint routes across popular frameworks:
- **Express.js / Node.js** (`app.get`, `router.post`)
- **Next.js** (App Router & Pages Router)
- **FastAPI** (`@app.get`, `@router.post`)
- **Laravel / PHP** (`Route::get`, `Route::post`)

```sh
# List all discovered HTTP routes
anvesa routes

# Filter by HTTP method
anvesa routes GET

# Filter by path prefix
anvesa routes POST /api/v1/auth
```
