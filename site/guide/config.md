# Configuration & Schema Reference

Anvesa is configured via `.anvesa/config.json` in your repository root. A full JSON Schema is provided to enable autocomplete and inline validation in editors like VS Code, Cursor, and JetBrains.

---

## Minimal Configuration

```json
{
  "$schema": "https://raw.githubusercontent.com/nimishph/anvesa/main/schemas/config.v1.json",
  "fusion": {
    "k": 60
  }
}
```

---

## Complete Configuration Example

```json
{
  "$schema": "https://raw.githubusercontent.com/nimishph/anvesa/main/schemas/config.v1.json",
  "model": "sentence-transformers/all-MiniLM-L6-v2",
  "fusion": {
    "k": 60
  },
  "search": {
    "defaultLimit": 20,
    "minScore": 0.35,
    "excludeLanes": ["docs"],
    "collapse": false
  },
  "indexing": {
    "concurrency": 8,
    "maxFileSizeBytes": 524288,
    "embeddingBatchSize": 32,
    "fragments": "off",
    "ignore": [
      "**/dist/**",
      "**/coverage/**",
      "**/*.generated.ts"
    ]
  },
  "syntax": {
    "stripComments": false,
    "maxChunkLines": 120,
    "minChunkLines": 3
  },
  "channels": {
    "docs": {
      "enabled": true,
      "weight": 1.0
    },
    "custom-notes": {
      "enabled": true,
      "weight": 0.8,
      "module": "tools/notes-extractor.js",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  },
  "security": {
    "requireChecksums": true
  },
  "redteam": {
    "maxCardsPerSource": 500,
    "quarantineOnSuspect": false
  }
}
```

---

## Schema Properties

### `model`
*Type:* `string | null`  
The ONNX embedding model ID to use for dense vector search (e.g. `'sentence-transformers/all-MiniLM-L6-v2'`). When unset (`null`), Anvesa automatically selects the optimal model based on detected hardware acceleration (AVX2, Apple Silicon Metal, or DirectML).

### `fusion`
*Type:* `object`  
- **`k`** (`number`, default `60`): The Reciprocal Rank Fusion smoothing constant. Higher values balance top ranks more evenly across multiple channels.

### `search`
*Type:* `object`  
- **`defaultLimit`** (`integer`, default `20`): Default number of results returned when `--limit` is not specified.
- **`minScore`** (`number`, range `0.0` - `1.0`): Cutoff threshold for cosine similarity in dense channels. Matches below this score are dropped.
- **`excludeLanes`** (`string[]`): Channels or lanes to exclude by default (e.g. `["docs"]`).
- **`collapse`** (`boolean`, default `false`): When enabled, merges multiple chunks originating from the same symbol.

### `indexing`
*Type:* `object`  
- **`concurrency`** (`integer`): Number of worker threads for parallel parsing and embedding.
- **`maxFileSizeBytes`** (`integer`, default `524288` [512KB]): Maximum file size indexed. Files exceeding this limit are skipped.
- **`embeddingBatchSize`** (`integer`, default `32`): Batch size passed to local ONNX runtime during card embedding.
- **`fragments`** (`"on" | "off"`, default `"off"`): Enables index partitioning into separate SQLite database shards for very large repositories.
- **`ignore`** (`string[]`): Additional glob patterns ignored during indexing beyond `.gitignore` and `.anvesaignore`.

### `syntax`
*Type:* `object`  
- **`stripComments`** (`boolean`, default `false`): Strips comments before chunking AST cards to conserve token and vector space.
- **`maxChunkLines`** (`integer`, default `120`): Upper boundary on source code lines per extracted card chunk.
- **`minChunkLines`** (`integer`, default `3`): Minimum lines required to form an independent card chunk.

### `channels`
*Type:* `Record<string, ChannelConfig>`  
Defines custom extraction channels (e.g. Markdown docs, OpenAPI specifications, commit messages).
- **`enabled`** (`boolean`): Whether the channel is active.
- **`weight`** (`number`, default `1.0`): RRF ranking multiplier.
- **`module`** (`string`): Path to transformer script.
- **`sha256`** (`string`): Cryptographic hash pinning the module code.

### `security`
*Type:* `object`  
- **`requireChecksums`** (`boolean`, default `false`): Enforces that all custom channel modules specify a verified `sha256` hash.

### `redteam`
*Type:* `object`  
- **`maxCardsPerSource`** (`integer`, default `500`): Card generation limit preventing denial-of-service from maliciously large generated files.
- **`quarantineOnSuspect`** (`boolean`, default `false`): Automatically isolates cards suspected of prompt injection attacks.
