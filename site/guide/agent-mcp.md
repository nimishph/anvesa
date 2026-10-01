# Model Context Protocol (MCP) Integration

Anvesa includes a built-in, native **Model Context Protocol (MCP)** server daemon. It turns your repository index into a suite of structured tools for LLM agent environments like Claude Desktop, Cursor, VS Code (Copilot/Cline), and Antigravity.

---

## Running the MCP Daemon

Start the server over standard I/O:

```sh
anvesa mcp serve
```

The daemon immediately opens the local `.anvesa/index.db` index in read-only mode and begins listening for JSON-RPC messages on `stdio`.

---

## Editor & Agent Configurations

### Claude Desktop
Add Anvesa to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anvesa": {
      "command": "npx",
      "args": ["-y", "@cntxt-labs/anvesa", "mcp", "serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Or using the standalone native binary:

```json
{
  "mcpServers": {
    "anvesa": {
      "command": "/usr/local/bin/anvesa",
      "args": ["mcp", "serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### Cursor & Cline / Roo Code
Configure in `.cursor/mcp.json` or your Cline MCP settings:

```json
{
  "mcpServers": {
    "anvesa": {
      "command": "anvesa",
      "args": ["mcp", "serve"]
    }
  }
}
```

---

## Available MCP Tools

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `search` | `query`, `format?`, `wql?`, `channels?`, `exclude?`, `limit?` | Fused dense semantic + structural search. |
| `query` | `wql`, `semantic?`, `limit?` | Pure AST structural query (e.g. `//function[@name="foo"]`). |
| `callers` | `target`, `resolvedOnly?`, `limit?` | Trace who calls a symbol or location. |
| `callees` | `target`, `limit?` | Trace outgoing calls from a symbol or location. |
| `neighbors` | `target`, `limit?` | Immediate caller/callee locality neighborhood. |
| `dependents` | `path`, `depth?`, `limit?`, `includeTypeOnly?` | File-level blast radius and import dependencies. |
| `repomap` | `dir?`, `budget?`, `depth?` | PageRank-weighted architectural outline within token budget. |
| `routes` | `method?`, `path?` | Discovered HTTP routes (Express, Next.js, FastAPI, Laravel). |
| `explain` | `limit?` | High-level repository structural summary and key symbols. |
| `primer` | `topic?`, `compact?` | Token-frugal guidance on Anvesa architecture and syntax. |
| `status` | *(none)* | Index health, model tiers, and channel statistics. |
| `index` | `force?`, `scope?`, `retryQuarantined?` | Trigger an incremental or forced re-indexing pass. |

---

## Token Frugality: Formats & Micro-Summaries

To prevent blowing out agent context windows, the `search` tool supports three output formats:

1. **`compact` (Default):**
   - Returns symbol name, file location (`path:line:col`), kind, signature, and a 1-line docstring summary.
   - Body code is omitted, consuming minimal tokens (~40 tokens per match).

2. **`locations`:**
   - Ultra-compact format returning only `path:line:col`, `kind`, and `title`.
   - Ideal for quick ranking scans across 20+ matches (~15 tokens per match).

3. **`full`:**
   - Includes the complete source card text, attributes, and provenance.
   - Used when the agent specifically requires the implementation body.

---

## Security: Untrusted Content Isolation

Code retrieved from an index is inherently untrusted. Anvesa automatically protects LLM agents from prompt injections embedded in source code comments or strings:

- All source code and markdown outputs returned via MCP tools are wrapped in cryptographic boundary fences:
  ```text
  <<<ANVESA_UNTRUSTED_CONTENT_BEGIN>>>
  // source code from repository
  <<<ANVESA_UNTRUSTED_CONTENT_END>>>
  ```
- Any suspicious payloads detected by Anvesa's redteam engine are quarantined or flagged before reaching the LLM context.
