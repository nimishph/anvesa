# Getting Started with Anvesa

Anvesa is a hybrid code retrieval and intelligence engine designed for AI agents and developers. It indexes repositories locally, allowing instant search by semantic meaning and AST structure without sending your code to any third-party cloud.

---

## Installation

### Option 1: Via npm (JavaScript / TypeScript Ecosystem)

```sh
# Global installation
npm install -g @cntxt-labs/anvesa

# Or run on-demand with npx
npx @cntxt-labs/anvesa search "auth handler"
```

The npm package includes pre-compiled native NAPI-RS binaries for:
- Linux x64 & ARM64
- macOS ARM64 (Apple Silicon) & Intel x64
- Windows x64

If you are on an unsupported platform, Anvesa automatically falls back to pure TypeScript with zero installation errors.

### Option 2: Standalone Native Binary (Zero-Runtime)

For production servers, CI/CD runners, or environments without Node.js or Bun:
1. Download the single executable (`anvesa` or `anvesa.exe`) from the [GitHub Releases](https://github.com/nimishph/anvesa/releases).
2. Move it to your system PATH (e.g. `/usr/local/bin` or `%USERPROFILE%\bin`).
3. Verify installation:
   ```sh
   anvesa --version
   ```

---

## 3-Step Repository Setup

### 1. Initialize
Run `anvesa init` inside your project root:
```sh
anvesa init
```
This scaffolds:
- `.anvesa/` configuration directory
- `.anvesaignore` with sensible defaults (ignoring build artifacts, node_modules, etc.)
- Downloads Tier-1 Tree-sitter grammars (TypeScript, JavaScript, Python, Go, Rust)

### 2. Index the Codebase
Index your repository:
```sh
anvesa index
```
Anvesa will:
- Parse all supported source files into AST outlines
- Extract symbol definitions, methods, classes, and call hierarchies
- Generate dense vector embeddings for all code cards using local ONNX models
- Store everything in SQLite at `.anvesa/index.db`

> **Tip (Fast Pass):** To skip embedding generation and index only the structural AST (<2 seconds), use:
> ```sh
> anvesa index --no-dense
> ```

### 3. Search and Query
Once indexed, you can search immediately:

```sh
# Fused search (dense + structural)
anvesa search "parse configuration file"

# Multi-mode formatting
anvesa search "validate user" --format compact
anvesa search "validate user" --format pretty
anvesa search "validate user" --format locations
anvesa search "validate user" --format json
```
