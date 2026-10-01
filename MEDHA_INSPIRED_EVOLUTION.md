# Anvesa Architecture & Evolution Plan (Medha-Inspired)

> Comprehensive blueprint for upcoming engineering initiatives in `@cntxt-labs/anvesa`, directly inspired by the architectural patterns, NAPI-RS hybrid bridge, agent usability tooling, and release pipelines established in `medha` (v0.7.0).

---

## 1. Executive Summary & Phasing Strategy

In `medha`, the transition from pure TypeScript to high-performance Rust was executed without disrupting existing TypeScript users through **progressive hybrid enhancement**:
1. **Core Mathematical Routines Ported to Rust:** Exposed through a high-speed NAPI-RS bridge (`crates/medha-napi`).
2. **Transparent TypeScript Fallback Bridge:** Integrated into `medha-core/src/rust-bridge.ts` so code runs at native speed when compiled binaries are present, and seamlessly falls back to TypeScript if absent.
3. **Daily Driver Unbroken:** The existing CLI remained the primary runner while gaining native speedups.
4. **Standalone Native Binary Assembled Last:** Standalone native CLI/MCP binary was only built once the native engine components were complete and tested.
5. **Frugal Agent UX:** Introduced `medha primer` (token-frugal micro-topics with zero-drift testing) and `medha ui` (local real-time inspection dashboard).

This document establishes the exact roadmap and technical specifications for `anvesa` across three phases, tracked in the **Beads** issue database.

---

## 2. Beads Issue Index & Dependency Graph

```text
  anv-1mh ($schema & Config Expansion)
  anv-80l (Multi-Mode Formatting)
  anv-35b (Primer CLI & MCP Tool)

  anv-ja8 (SIMD Vector Math NAPI-RS Bridge ──► Wires into dense/TS)
      │
      ├────────────────────────┐
      ▼                        ▼
  anv-gjm (Native Tree-Sitter) ──► Wires into syntax/TS
      │
      ▼
  anv-olu (Standalone Native CLI/MCP Binary with ort ──► Assembled last)

  anv-p29 (Anvesa UI Dashboard & Visual Graph Explorer)
```

| Bead ID | Priority | Type | Status | Title |
| :--- | :---: | :--- | :--- | :--- |
| `anv-1mh` | **P2** | `feature` | Open | Support `$schema` and expand project configuration tuning in `.anvesa/config.json` |
| `anv-80l` | **P2** | `feature` | Open | Add multi-mode results formatting for search and query (`compact`, `pretty`, `locations`, `json`) |
| `anv-35b` | **P1** | `feature` | Open | Add token-frugal `anvesa primer` CLI command and MCP tool with anti-drift test |
| `anv-ja8` | **P1** | `feature` | Open (Wires to TS) | SIMD-accelerated vector math and batch top-k scan via NAPI-RS |
| `anv-gjm` | **P2** | `feature` | Open (Wires to TS) | Evaluate and implement native tree-sitter parsing in Rust |
| `anv-olu` | **P3** | `feature` | **Deferred** (Blocked by `anv-ja8`, `anv-gjm`) | Standalone native Rust CLI and MCP binary with `ort` (ONNX runtime) |
| `anv-p29` | **P3** | `feature` | Open | Implement `anvesa ui`: Local web dashboard, visual query playground, and graph explorer |

---

## 3. Detailed Technical Specifications

### `anv-1mh`: Support `$schema` and Expand Project Config Tuning

#### Motivation & Current Defect
In `retriever/src/config.ts`, `validateProjectConfig()` iterates over object keys and explicitly rejects any key not in `['model', 'channels', 'fusion', 'indexing', 'security']`. Consequently, adding `"$schema"` to `.anvesa/config.json` throws:
```text
ProjectConfigError: .anvesa/config.json: $schema is not a known setting
```
Furthermore, Anvesa has no JSON Schema published, leaving developers and AI agents without IDE hover help, validation, or autocomplete.

#### Implementation Requirements
1. **Config Parser & Serializer Update (`retriever/src/config.ts`):**
   * Allow optional `$schema?: string` in `validateProjectConfig`.
   * Preserve `$schema` when running `writeProjectConfig()`.
2. **Author Schema Definition (`schemas/config.v1.json`):**
   * Use JSON Schema Draft 2020-12 (mirroring `medha/schemas/config.v1.json`).
   * Host at `https://raw.githubusercontent.com/nimishph/anvesa/main/schemas/config.v1.json`.
3. **Expand Config Tuning Blocks in `ProjectConfig`:**
   * **`search`:**
     * `defaultLimit: number` (default `20`, replacing hardcoded 1000).
     * `excludeLanes: string[]` (e.g. `["docs"]`).
     * `minScore: number` (minimum cosine similarity cutoff).
     * `collapse: boolean` (collapse multiple chunks from the same symbol).
   * **`indexing`:**
     * `ignore: string[]` (additional ignore globs beyond `.gitignore`, e.g. `["**/dist/**", "**/*.generated.*"]`).
     * `maxFileSizeBytes: number` (skip massive files, default 512KB).
     * `concurrency: number` (worker pool count).
     * `embeddingBatchSize: number` (default 32).
   * **`syntax`:**
     * `stripComments: boolean` (default false).
     * `maxChunkLines: number` (default 120).
     * `minChunkLines: number` (default 3).
   * **`redteam`:**
     * `maxCardsPerSource: number` (anti-flood threshold, default 500).
     * `quarantineOnSuspect: boolean` (strict prompt-injection security).

---

### `anv-80l`: Multi-Mode Results Formatting

#### Motivation
Currently, `cli/src/render.ts` renders search results as single-line summaries followed by full multi-line card bodies indented by 6 spaces. In MCP and agent contexts, 20 results can dump 5,000+ tokens of raw source code, bloating the LLM context. In human terminal contexts, there are no syntax colors, no IDE jump links, and no visual score breakdown.

#### Implementation Requirements
1. **CLI Option:**
   * Add `--format <compact|pretty|locations|json>` (alias `--compact`) to `anvesa search` and `anvesa query`.
2. **Format Modes:**
   * **`compact` (Default for MCP):**
     * Emits: `1. parseConfig (function) src/config.ts:45-80 (path: string) => Promise<Config> [dense#1] (score: 0.89)`
     * Emits concise 1-line docstring summary.
     * Omits raw multi-line card body unless `--full` is explicitly passed.
   * **`pretty` (Default for interactive TTY):**
     * ANSI syntax highlighting for code blocks matching the target language.
     * Clickable IDE jump links (`src/config.ts:45:1`) for instant terminal click-to-open.
     * Visual score confidence bars: `[████████░░] 0.842`.
   - **`locations` (Unix / Quickfix mode):**
     * Output format: `src/config.ts:45:1: function parseConfig [dense#1]`
     * Pipeable into `fzf`, `xargs`, or Neovim/VS Code quickfix lists.
   - **`json`:**
     * Clean, strictly-typed JSON array of result objects without circular node references.

---

### `anv-35b`: Token-Frugal `anvesa primer`

#### Motivation
`anvesa` has subtle, powerful concepts that agents frequently misinterpret:
* WQL query syntax (`//callable[@name="..."]`, axes, predicates).
* RRF fusion mechanics (why `--exclude docs` is preferred over low rank weights).
* Graph commands (`callers` vs `callees` vs `dependents` vs `neighbors`).
* Indexing modes (`--no-dense` vs full embedding passes).

Currently, Anvesa relies on a single ~176-line `skills/anvesa/SKILL.md`. Loading this entire skill burns ~9KB of context.

#### Implementation Requirements
1. **Micro-Topics (25–40 lines each in `cli/src/primer.ts`):**
   * **`overview`:** Core philosophy, command cheatsheet, and the Decision Heuristic table (when to use search vs query vs callers vs grep).
   * **`wql`:** Wildcard Query Language cheatsheet: axes (`//`, `/`), predicates (`[@name]`, `[@declaration]`, `[@visibility]`), regex matches (`=~`), and language normalization (`//callable`).
   * **`fusion`:** Reciprocal Rank Fusion (RRF) explanation across `dense`, `structural`, and `docs` lanes; guidance on boolean filtering vs weights.
   * **`graph`:** Blast radius tracing (`dependents`), call hierarchy (`callers`, `callees`), and locality (`neighbors`).
   * **`indexing`:** Incremental AST caching, `--no-dense` structural passes, and fragment databases.
   * **`grammars`:** Grammar discovery, user downloads, lockfiles, and integrity checks.
2. **Interfaces:**
   * **CLI:** `anvesa primer [topic]` with `--compact` and `--json`.
   * **MCP Tool:** `primer({ topic?: string })` (returns table of contents if empty).
3. **Anti-Drift Test Suite (`cli/src/primer.test.ts`):**
   * Asserts that **every registered CLI subcommand and MCP tool** is documented in at least one primer topic.
   * Asserts that engine constants (e.g. default fusion k=60) match code constants.

---

### `anv-ja8`: SIMD-Accelerated Vector Math & Batch Top-K (NAPI-RS)

#### Motivation
In `indexer/src/store/sqlite-vector-store.ts` (`#scan` method):
* Vectors are stored as raw `Float32Array` bytes in SQLite.
* During search, every card row is read from SQLite in JS, copied to a `scratchBytes` buffer, and evaluated via a scalar JS loop in `dense/src/vectors.ts`.
* For 20,000–100,000 cards, iterating SQLite in JS and running scalar loops creates heavy GC pressure and CPU lag.

#### Implementation Requirements
1. **Create `crates/anvesa-napi`:**
   * Rust native addon using `napi-rs` and `wide` / `packed_simd`.
   * Functions:
     * `dot_product_simd(a: &[f32], b: &[f32]) -> f32`: AVX2 / NEON accelerated dot product.
     * `normalize_simd(v: &[f32]) -> Vec<f32>`: Fast unit normalization.
     * `batch_scan_top_k(query: &[f32], vector_buffer: &[u8], dims: u32, limit: u32) -> Vec<(u32, f32)>`: Evaluates thousands of contiguous vector bytes directly in native memory, selecting top-k without crossing into JS per row.
2. **Progressive Hybrid Wiring (`dense/src/vectors.ts` & `indexer`):**
   * Patterned after `medha-core/src/rust-bridge.ts`: use native addon when available, with pure TypeScript fallback.
   * Full mathematical parity verified with unit tests.

---

### `anv-gjm`: Native Tree-Sitter AST Parsing in Rust

#### Motivation
`anvesa-syntax` relies on `web-tree-sitter` (WebAssembly). Limitations include:
* Single-threaded parsing on the main JS event loop.
* Memory copying across the JS/WASM linear memory boundary for every node.
* Crash vulnerability on oversized files (`RuntimeError: memory access out of bounds`).
* Slow cold-start initialization requiring `.wasm` bundle resolution.

#### Implementation Requirements
1. **Create `crates/anvesa-syntax`:**
   * Uses the official `tree-sitter` Rust crate.
   * Statically links tier-1 language grammars (TS, JS, Python, Go, Rust, C#).
2. **Multi-Threaded Concurrency via `rayon`:**
   * Parse repositories across all available CPU cores concurrently during `anvesa index`, yielding 10x–20x throughput improvements.
3. **NAPI-RS Extraction Bridge:**
   * Expose AST outline extraction (functions, methods, classes, signatures, calls) to TypeScript as compact flat buffers or JSON chunks.

---

### `anv-olu`: Standalone Native Rust CLI & MCP Binary (Deferred)

#### Motivation & Phasing
- **Phasing:** Explicitly deferred until `anv-ja8` and `anv-gjm` are completed and wired to TypeScript.
- **Goal:** Replace `bun build --compile ./src/binary.ts` and the fragile vendoring of `runtime/node_modules/onnxruntime-node` with patched relative require statements in `tooling/package-release.ts`.
- **Architecture:**
  - Crate: `crates/anvesa-cli`.
  - Dependencies: `clap` (CLI), `ort` (ONNX Runtime Rust bindings for embedding models), `rusqlite` (SQLite storage), `tree-sitter` (AST).
  - Direct stdio JSON-RPC for zero-runtime MCP daemon (`anvesa mcp serve`).
  - Instant startup (<5ms) with zero dependencies on Node, Bun, or Python.

---

### `anv-p29`: `anvesa ui` Local Web Dashboard & Graph Explorer

#### Motivation
Anvesa stores a rich code intelligence graph (dense embeddings, structural outlines, caller/callee trees, blast radius dependencies), but has no graphical interface.

#### Implementation Requirements
1. **Local Server (`cli/src/ui.ts`):**
   - Command: `anvesa ui [--port 4444] [--root .]`
   - Serves a zero-dependency, self-contained interactive web app.
2. **Features:**
   - **Search & WQL Playground:** Side-by-side search query testing with real-time RRF lane score inspection and AST outline previews.
   - **Visual Call Graph & Blast Radius:** Interactive SVG/Canvas node-link graph showing callers, callees, and file dependencies.
   - **Index & Health Dashboard:** Vector counts, dimensionality verification, grammar status, and quarantined card inspector.
3. **Static Architecture Export:**
   - Command: `anvesa report --html architecture.html`
   - Emits a standalone, zero-dependency HTML file embedding the repository graph and symbol index for documentation or CI artifacts.

---

## 4. Platform Parity & Tooling Modernization

### Adding `darwin-x64`
`anvesa` currently only supports 4 targets in `cli/package.json` and release workflows:
* `linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64`.
* **Action:** Adopt Medha's 5-target platform matrix:
  1. Add `@cntxt-labs/anvesa-darwin-x64` to `cli/package.json` optionalDependencies.
  2. Add `darwin-x64` to `tooling/platforms.ts`.
  3. Add `macos-13` (Intel runner) to `.github/workflows/ci.yml` and `release.yml`.
  4. Ensure `chmod 0755` executable permissions and SHA256 checksum generation in `.github/workflows/release.yml`.
