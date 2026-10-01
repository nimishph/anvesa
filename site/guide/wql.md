# Wildcard Query Language (WQL)

Wildcard Query Language (WQL) provides a powerful, XPath-inspired syntax to query the structural AST outline of your codebase without regex guessing.

---

## Why WQL?

Standard regex tools (`grep`, `ripgrep`) cannot distinguish between:
- A function declaration vs. a function call
- A method inside a class vs. a standalone utility
- Code vs. comments or string literals

WQL operates directly on Tree-sitter Concrete Syntax Trees (CST). It understands language semantics across TypeScript, Python, Go, and Rust.

---

## Syntax Overview

### Axes

| Axis | Syntax | Description | Example |
| :--- | :--- | :--- | :--- |
| **Descendant** | `//` | Matches at any nesting depth | `//class//method` |
| **Direct Child** | `/` | Matches direct children only | `//class/method` |

### Normalized Tags

Anvesa normalizes AST node kinds across languages into canonical tags:

- `//callable` — Any function, method, or constructor
- `//function` — Standalone functions
- `//method` — Member methods in classes/structs/interfaces
- `//class` — Classes, structs, or records
- `//interface` — Interfaces, traits, or protocols

---

## Predicates & Filters

Predicates are enclosed in square brackets `[...]`:

### 1. Name Matching (`@name`)
```sh
# Exact match
anvesa query '//function[@name="parseConfig"]'

# Case-insensitive / prefix regex match
anvesa query '//function[@name=~"^validate[A-Z]"]'
```

### 2. Visibility (`@visibility`)
```sh
# Only exported / public methods
anvesa query '//method[@visibility="public"]'
anvesa query '//function[@exported]'
```

### 3. Declarations vs. Calls
```sh
# Symbol definitions only
anvesa query '//callable[@declaration]'

# Call invocations only
anvesa query '//callable[@call]'
```

### 4. Signature Filters (`@signature`)
```sh
# Find functions accepting specific argument signatures
anvesa query '//function[@signature^="(path: string)"]'
```

---

## Conjunction Queries (Semantic + Structural)

Anvesa allows blending semantic intent with strict structural constraints using `&&`:

```sh
# Natural language meaning + AST constraint
anvesa search "handle database connections && //class"
anvesa query '//function && calculate metrics'
```

The retrieval engine scores candidates that satisfy the AST predicate and ranks them by cosine similarity in a single fused pass.
