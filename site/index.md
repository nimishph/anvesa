---
layout: home
title: anveṣa
titleTemplate: Hybrid dense + structural code retrieval
hero:
  name: anveṣa
  text: Find code by meaning and structure
  tagline: >-
    Local, offline-first code intelligence. Neural embeddings combined with AST Tree-sitter
    queries through Reciprocal Rank Fusion (RRF). Single-binary native speed.
  image:
    src: /logo.svg
    alt: anveṣa
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: WQL Syntax
      link: /guide/wql
    - theme: alt
      text: CLI Reference
      link: /cli

features:
  - title: Fused Dense & Structural
    details: >-
      Neural embeddings (MiniLM, BGE) capture semantic intent, while AST Tree-sitter matches exact
      syntax. Reciprocal Rank Fusion (RRF) blends them into a single, ranked result list.
  - title: Wildcard Query Language (WQL)
    details: >-
      XPath-like structural queries over your repository code graph. Query //function[@name="foo"],
      filter by visibility, and trace declarations without regex guesswork.
  - title: Native SIMD Acceleration
    details: >-
      AVX2+FMA on x86_64, NEON on ARM64, and Rayon parallel multi-threaded parsing.
      Evaluates 100,000 vectors in 10.8ms (9.2M vectors/sec).
  - title: Zero-Runtime Native MCP Daemon
    details: >-
      Instant <2ms startup. Speaks Model Context Protocol over stdio for Claude Desktop,
      Cursor, and AI agent work without needing Node, Bun, or Python daemons running.
  - title: Code Graph & Blast Radius
    details: >-
      Trace callers, callees, and file dependents (import blast radius) in SQLite.
      Know the downstream impact before modifying or deleting any symbol.
  - title: Token-Frugal Primer
    details: >-
      Micro-topics (25-40 lines each) designed specifically for LLM context frugality.
      Agents load only the exact concept they need without blowing prompt budgets.
---

## The name

**anveṣa** (अन्वेष). *anv-eṣa* (m.), also *anveṣaṇa* (n.): “seeking for, searching, investigating”, from *anu* + √*iṣ*, to seek after.
Monier-Williams, *A Sanskrit-English Dictionary* (1899), p. 47: [see the entry in the Cologne Digital Sanskrit Dictionaries](https://www.sanskrit-lexicon.uni-koeln.de/scans/MWScan/2020/web/webtc/getword.php?key=anveza&filter=roman&noLit=off&transLit=slp1).

Anveṣa is a search that follows a trail. This tool follows code by what it means and by how it is built.

## Quick Start

```sh
# 1. Install via npm or grab the native binary from GitHub Releases
npm install -g @cntxt-labs/anvesa

# 2. Initialize in any repository (scaffolds ignore rules and grammar configs)
anvesa init

# 3. Incrementally index your codebase
anvesa index

# 4. Search naturally (fused semantic + structural)
anvesa search "how are authentication tokens verified?"

# 5. Query AST structure directly with WQL
anvesa query '//class//method[@visibility="public"]'

# 6. Trace call hierarchy and blast radius
anvesa callers verifyToken
anvesa dependents src/auth.ts
```

---

## When to Use Which Tool

| Task / Goal | Recommended Tool / Command | Why? |
| :--- | :--- | :--- |
| **Search by behavior or concept** | `anvesa search <concept>` | Fuses dense semantic similarity with structural matches. |
| **Find exact symbol definition** | `anvesa query '//function[@name="x"]'` | Direct AST lookup; ignores comments, strings, and false positives. |
| **Trace call hierarchy** | `anvesa callers <sym>` / `callees <sym>` | Follows actual call graph edges stored in SQLite. |
| **Check refactoring blast radius** | `anvesa dependents <file>` | Identifies all files that import or depend on the target. |
| **Discover API routes** | `anvesa routes [method] [path]` | Extracts registered HTTP endpoints from framework routers. |
| **Exact text / regex search** | Standard `ripgrep` / `grep` | When searching for raw text literals or log strings. |
