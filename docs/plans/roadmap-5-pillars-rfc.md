# RFC: Anvesa Core Evolution — The 5 Strategic Pillars

- **Author**: Anvesa Core Team & AI Agent Pair
- **Status**: Proposed / Design Specification
- **Target Version**: `0.8.0` – `0.9.0`
- **Scope**: Telemetry, Auto-Watching, Agent Showcase UI, SCIP/LSIF Compiler Ingestion, Multi-Repo Federation

---

## Executive Summary

This RFC outlines the technical architecture, data contracts, and implementation blueprints for the next five major evolutionary capabilities of **Anvesa**:

1. **Anonymous, Non-IP Telemetry**: Privacy-first operational insights with strict zero-PII guarantees.
2. **`anvesa watch` (Continuous Auto-Indexing Daemon)**: Event-driven AST and embedding synchronization.
3. **`anvesa ui` Agent Showcase**: URL parameter-driven visual query presentation for AI coding agents.
4. **SCIP/LSIF Ingestion & OSS Grammar Training**: Compiler-accurate call graphs and automated syntax mapping expansion.
5. **Multi-Repository Workspace Federation**: Cross-repo retrieval, dependency blast radius, and unified code maps.

---

## Pillar 1: Anonymous & Non-IP Telemetry

### 1.1 Privacy Principles & Guarantees
Anvesa operates in privacy-sensitive enterprise and open-source environments. The telemetry pipeline must adhere to strict invariants:
- **Zero-IP Policy**: Client IP addresses are stripped at the edge proxy and never written to logs or storage.
- **Zero-PII & Zero Code Content**: Never collect file paths, function/class names, code snippets, git commit messages, or raw query text.
- **Strict Opt-Out & Audit Mode**:
  - `ANVESA_NO_TELEMETRY=1` or `ANVESA_NO_NETWORK=1` blocks the subsystem entirely.
  - Configuration `"telemetry": false` in `.anvesa/config.json`.
  - CLI flag `--no-network` terminates with an error if network dispatch is attempted.
- **Ephemeral Session Identifiers**: A randomly generated UUID rotated every 24 hours. No persistent hardware UUIDs or MAC address hashes.

### 1.2 Event Payload Schema
```typescript
export interface TelemetryPayload {
  readonly schemaVersion: '1.0.0';
  readonly sessionId: string; // Rotated daily
  readonly timestamp: number;
  readonly anvesaVersion: string;
  readonly platform: {
    readonly os: 'linux' | 'darwin' | 'win32';
    readonly arch: 'x64' | 'arm64';
    readonly cpuCores: number;
    readonly totalMemoryGbBucket: '2-4' | '4-8' | '8-16' | '16-32' | '32+';
  };
  readonly event: {
    readonly type: 'cli_command' | 'mcp_tool_call' | 'index_completed' | 'error';
    readonly commandName: string; // e.g. "search", "query", "callers"
    readonly durationMsBucket: '<10' | '10-50' | '50-200' | '200-1000' | '1000+';
    readonly modelId?: string; // e.g. "bge-base-en-v1.5"
    readonly resultCountBucket?: '0' | '1-5' | '6-20' | '20+';
    readonly errorCode?: string; // e.g. "CORE_INVALID_ARGUMENT" (no stack traces)
    readonly optionsUsed?: {
      readonly hasScope: boolean;
      readonly hasWqlConjunction: boolean;
      readonly customWeights: boolean;
    };
  };
}
```

### 1.3 Transport & Resilience
- **Non-blocking Batching**: Events are queued in a small memory ring-buffer (max 50 events).
- **Asynchronous Dispatch**: Flushed every 60 seconds or on graceful process exit using `fetch()` with an aggressive 600ms timeout.
- **Failure Handling**: Network errors are silently discarded; telemetry may never slow down or crash a CLI command.

---

## Pillar 2: `anvesa watch` (Continuous Auto-Indexing Daemon)

### 2.1 Problem Statement
Currently, Anvesa's index reflects the moment `anvesa index` was run. As human developers or autonomous AI agents create, refactor, and delete files, the vector store and code graph drift.

### 2.2 System Architecture
```
┌────────────────────────────────────────────────────────┐
│                   File System Watcher                  │
│       (ReadDirectoryChangesW / inotify / FSEvents)     │
└───────────────────────────┬────────────────────────────┘
                            │ Raw Path Events
                            ▼
┌────────────────────────────────────────────────────────┐
│             Pre-Filter (.anvesaignore / .git)          │
└───────────────────────────┬────────────────────────────┘
                            │ Filtered Dirty Paths
                            ▼
┌────────────────────────────────────────────────────────┐
│            Debounce Window (Default: 300ms)            │
└───────────────────────────┬────────────────────────────┘
                            │ Batched Changed Files
                            ▼
┌────────────────────────────────────────────────────────┐
│               Incremental AST Analyzer                 │
│      - Parse changed files with Tree-Sitter            │
│      - Compute symbol hash deltas                      │
└───────────────────────────┬────────────────────────────┘
                            │ Modified Symbol Cards Only
                            ▼
┌────────────────────────────────────────────────────────┐
│           Red-Team Safety Screen Gate                  │
└───────────────────────────┬────────────────────────────┘
                            │ Clean Cards
                            ▼
┌────────────────────────────────────────────────────────┐
│          Incremental SQLite & Vector Update            │
│      - Re-embed modified symbol cards                  │
│      - Prune removed symbol cards                      │
│      - Reconcile call and import graph edges           │
└────────────────────────────────────────────────────────┘
```

### 2.3 Implementation Details
1. **CLI Command**:
   ```bash
   anvesa watch [--debounce-ms 300] [--no-embed] [--scope <dir>]
   ```
2. **Embedded Watcher Mode**:
   - `anvesa mcp serve --watch`: Keeps the index warm for coding agents during active pair-programming sessions.
   - `anvesa ui --watch`: Automatically updates the web dashboard graph and search index in real time.
3. **Dirty Symbol Hashing**:
   - Each symbol card stores a BLAKE3/SHA-256 hash of its source text slice: `hash(kind + signature + body)`.
   - If a file modification only changes comments or formatting outside a function, the function's embedding is untouched, saving significant compute.

---

## Pillar 3: `anvesa ui` — Agent Showcase via Query Parameters

### 3.1 Objective
Allow AI coding agents to visually present their search results, call graphs, and architectural findings to the human developer with a single URL or CLI command.

### 3.2 URL Parameter Specification
The web dashboard router parses query parameters on load and updates reactive state:

| Parameter | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `q` / `search` | `string` | Query text to execute in Search Studio | `?q=authentication+token` |
| `mode` | `enum` | Search mode: `fused`, `semantic`, `structural` | `&mode=fused` |
| `wql` | `string` | Conjunction WQL structural predicate | `&wql=//class//method` |
| `weightDocs` | `number` | Documentation channel weight ($0.0 - 2.0$) | `&weightDocs=0.5` |
| `scope` | `string` | Directory path scope constraint | `&scope=packages/retriever` |
| `view` | `enum` | Target tab: `search`, `graph`, `wql`, `status` | `&view=graph` |
| `symbol` | `string` | Target symbol to center in Call Graph | `&symbol=Retriever.search` |
| `repomap` | `boolean` | Open PageRank Architectural Repomap | `&repomap=true` |
| `highlight` | `string` | Specific card ID to pulse and scroll into view | `&highlight=sym:retriever:fuse` |

### 3.3 CLI Invocation
```bash
# Agent opens browser showcasing specific search results:
anvesa ui --search "parse configuration" --wql "//function"

# Agent opens browser centered on a complex symbol's call hierarchy:
anvesa ui --view graph --symbol "Retriever.search"
```

### 3.4 MCP Tool Addition (`open_ui`)
Register an MCP tool in `cli/src/mcp.ts`:
```typescript
server.registerTool('show_in_ui', {
  description: 'Open the Anvesa visual web dashboard in the human user\'s browser to showcase code search results, a symbol call graph, or an architectural repomap.',
  inputSchema: {
    query: z.string().optional(),
    symbol: z.string().optional(),
    wql: z.string().optional(),
    view: z.enum(['search', 'graph', 'wql', 'status']).optional(),
  }
}, async (args) => {
  const url = buildUiUrl(args);
  await openBrowser(url);
  return { content: [{ type: 'text', text: `Opened Anvesa Dashboard at ${url}` }] };
});
```

---

## Pillar 4: SCIP/LSIF Ingestion & Open-Source Grammar Training

### 4.1 Hybrid Graph Architecture: AST + Compiler Precision
While Tree-Sitter AST outlines are fast, offline, and language-agnostic, they lack semantic type resolution for complex generics, cross-file re-exports, and dynamic method dispatches.

```
                  ┌───────────────────────────────┐
                  │      Source Code Workspace    │
                  └──────────────┬────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
    ┌─────────────────────────┐     ┌─────────────────────────┐
    │  Tree-Sitter Syntax AST │     │   SCIP / LSIF Compiler  │
    │   (Fast, 14+ Languages) │     │ (rust-analyzer, tsc, Go)│
    └────────────┬────────────┘     └────────────┬────────────┘
                 │ Syntactic Edges               │ Verified Type References
                 └───────────────┬───────────────┘
                                 ▼
    ┌─────────────────────────────────────────────────────────┐
    │              Unified Graph Knowledge Base               │
    │  - Edges tagged: { accuracy: "compiler" | "syntactic" } │
    │  - Callers / Callees / Dependents unified queries       │
    └─────────────────────────────────────────────────────────┘
```

### 4.2 Ingestion Engine (`anvesa graph import`)
- **Format Support**:
  - SCIP (Source Code Intelligence Protocol) protobuf (`index.scip`).
  - LSIF JSON lines (`dump.lsif`).
- **Schema Mapping**:
  - SCIP `SymbolInformation` -> Anvesa `symbols` table (`name`, `kind`, `signature`, `doc`).
  - SCIP `Occurrence` (`definition` / `reference`) -> Anvesa `edges` table (`caller_id`, `callee_id`, `kind`, `accuracy: "compiler"`).
- **Fallback Resolution**: Queries to `anvesa callers` prioritize `compiler` edges, falling back to AST pattern edges when SCIP data is unavailable.

### 4.3 Automated OSS Grammar Training Pipeline
Expand language coverage and refine unmapped syntax nodes using open-source corpora:
```bash
anvesa mapping train <language> --corpus <dir|github-org> [--min-samples 50]
```
1. **Corpus Traversal**: Ingests thousands of real-world OSS repositories in target languages (Kotlin, Zig, Swift, Elixir, C#).
2. **Grammar Node Frequency Analysis**: Identifies Tree-Sitter AST nodes that appear frequently in valid code but lack outline mappings in `mappings/<language>.json`.
3. **Automated Mapping Synthesis**: Proposes mapped structural roles (`callable`, `container`, `import`, `export`) with automated unit tests (`bun test`).

---

## Pillar 5: Multi-Repository Workspace Federation

### 5.1 Architecture & Federation Topology
In enterprise environments, microservices, polyrepos, and modular libraries span multiple repositories that depend on each other.

```
                            ┌────────────────────────┐
                            │   Root Workspace / UI  │
                            └───────────┬────────────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
    ┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
    │   Repo 1: API    │       │  Repo 2: Client  │       │  Repo 3: Types   │
    │ (.anvesa/index)  │       │ (.anvesa/index)  │       │ (.anvesa/index)  │
    └──────────────────┘       └──────────────────┘       └──────────────────┘
```

### 5.2 Workspace Manifest (`.anvesa/workspace.json`)
```json
{
  "version": 1,
  "federation": {
    "enabled": true,
    "repositories": [
      {
        "name": "core-api",
        "path": "../backend-service",
        "defaultLanes": ["symbols", "docs"]
      },
      {
        "name": "web-frontend",
        "path": "../frontend-app",
        "defaultLanes": ["symbols"]
      },
      {
        "name": "shared-contracts",
        "path": "../contracts",
        "defaultLanes": ["symbols", "docs"]
      }
    ]
  }
}
```

### 5.3 Federated Retrieval Execution
1. **Fan-Out Query Dispatch**: `Retriever.search()` executes parallel queries against each federated repository's index.
2. **Provenance-Preserving RRF Fusion**:
   - Each hit includes a repository identifier: `{ repo: "core-api", path: "src/auth.ts", symbol: "verifyJwt" }`.
   - Results are fused across repository boundaries with optional per-repository weighting (`--weight repo:core-api=1.5`).
3. **Cross-Repository Blast Radius (`anvesa dependents`)**:
   - Detects when changes to `shared-contracts` break method signatures used in `core-api` and `web-frontend`.

---

## Phased Implementation Roadmap

```mermaid
gantt
    title Anvesa Core Evolution Roadmap
    dateFormat  YYYY-MM
    section Pillar 3: Agent UI Showcase
    URL Param Router & Agent Links      :active, p3_1, 2026-10, 2026-11
    MCP show_in_ui Tool                 :p3_2, 2026-10, 2026-11
    section Pillar 2: anvesa watch
    FS Watcher & Debounce Pipeline      :p2_1, 2026-11, 2026-12
    Incremental AST & Vector Re-index   :p2_2, 2026-11, 2026-12
    section Pillar 1: Telemetry
    Anonymization Pipeline & Schema     :p1_1, 2026-12, 2027-01
    Opt-out Controls & Guard Rails      :p1_2, 2026-12, 2027-01
    section Pillar 4: SCIP & Grammars
    SCIP / LSIF Ingestion Engine        :p4_1, 2027-01, 2027-02
    OSS Corpus Grammar Training Pipeline:p4_2, 2027-01, 2027-02
    section Pillar 5: Multi-Repo
    Workspace Federation Schema         :p5_1, 2027-02, 2027-03
    Cross-Repo Search & Call Graph Mesh :p5_2, 2027-02, 2027-03
```

---

## Verification & Safety Invariants

1. **Zero External Runtime Dependencies**: All features must remain native Bun/Node compatible, self-contained within the Anvesa binary package.
2. **Red-Team Boundary Preserved**: Telemetry, watcher events, and federated cards must continue to pass through the Red-Team screening gate before entering any vector store.
3. **Offline Default**: Anvesa must continue to be 100% functional without internet connectivity.
