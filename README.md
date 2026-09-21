# code-lens

Find code by meaning and by structure, from the command line or from an AI agent over MCP. It
works offline once its parts are installed, and it runs as one program with no server.

- **Dense retrieval** finds symbols and documentation by what they do, with a local embedding model.
  Every piece of text passes a red-team screen before it is embedded, and comes back fenced as
  untrusted data.
- **Structural retrieval** answers exact questions over the shape of the code with WQL, a small
  query language: `//class//method[@name^="parse"]`.
- **Fusion** ranks both together (reciprocal rank fusion, per-channel weights) and says which lane
  found each result.
- **Your own channels** put anything else in the same index: issue text, run logs, a wiki. A
  channel is one small module.
- **Workspaces** are understood: monorepos, nested packages and cross-package calls.

There is no lexical search and no grep. An exact name is a WQL query.

## Install

```sh
npm install -g @sutras/code-lens      # or: bun add -g, pnpm add -g, npx @sutras/code-lens
code-lens --version
```

The package is a small launcher. The program itself is a compiled binary in a per-platform package
that the install picks for your machine (`@sutras/code-lens-linux-x64`, `-linux-arm64`,
`-darwin-arm64`, `-win32-x64`); it needs no Node, Bun or Python at run time. There is no macOS
Intel build, because the ONNX runtime it embeds no longer ships one.

Or download an archive for your platform from the GitHub release, unpack it, and put the folder on
your `PATH`. Keep the `runtime/` folder next to the program: it holds the ONNX runtime the embedding
model needs.

```
code-lens-<version>-<platform>/
  code-lens(.exe)
  runtime/          ONNX runtime and its native library
```

The program carries the JavaScript, TypeScript and TSX grammars. Everything else is installed on
demand and works offline:

```sh
code-lens model list                         # the built-in models and which are installed
code-lens model install bge-base-en-v1.5 --from ./models/bge-base   # offline; or --download
code-lens grammar list
code-lens grammar install python --from ./tree-sitter-python.wasm   # file, folder or npm tarball
```

Models and grammars are checked against pinned checksums. Nothing touches the network unless you
pass `--download`.

## Use

```sh
cd my-project
code-lens index                       # only changed files are read
code-lens search "parse the configuration file"
code-lens query '//function[@name="parseConfig"]'
code-lens callers parseConfig         # a name, a symbol id, or src/config.ts:42
code-lens dependents src/config.ts
code-lens explain                     # what the project is made of
code-lens diagnose "parse the config" --expect src/config.ts   # why it did not come up
```

Every command takes `--json`. Lists are paged: `--limit N` says how many, and the answer says
when there are more and how to ask for them (`--cursor`). Nothing is cut silently.

Without an installed model, structural queries and the call graph still work, and dense search says
what is missing.

### Channels

```sh
code-lens channel add runbooks                 # scaffolds a module and registers it
code-lens channel add digests ./digest-channel.ts   # or registers one you have
code-lens channel test runbooks docs/oncall.md # what would be embedded, and what the screen thinks
code-lens channel index runbooks
code-lens retrieve runbooks "who restarts the queue worker"
```

A channel module default-exports a transformer (which files it claims and what one card holds) and
may export a `source` for records that are not files. See the scaffold for the shape. Channels are
listed in `.code-lens/config.json`, where each can be given a fusion weight.

### MCP

```json
{ "mcpServers": { "code-lens": { "command": "code-lens", "args": ["mcp", "serve", "--root", "/path/to/project"] } } }
```

Tools: `search`, one `retrieve_<channel>` per channel, `query`, `callers`, `callees`, `neighbors`,
`dependents`, `explain`, `diagnose`, `status`, `index`.

## How well does it work

`bun run eval:retrieval` measures retrieval on a repository, with queries derived from its own
index. On trpc (627 TypeScript files, bge-base):

| Lane | Query | Recall@5 | MRR |
|---|---|---|---|
| dense | a symbol's name as words | 98.0% | 0.90 |
| dense | what a symbol does (from its doc comment, name removed) | 76.3% | 0.65 |
| fused | exact name, WQL | 99.7% | 0.99 |

The intent number is generous: the doc comment is also part of the card. `bun run eval` scores the
symbol, import and call graph against the TypeScript compiler (98.5% call precision on trpc).
On that repository with the small model, indexing takes under a minute and peaks near 400 MB.

## Develop

Self-contained: own `package.json`, lockfile, `tsconfig`, Biome and boundary config.

```
cli -> retriever -> indexer -> dense -> structural -> syntax -> core
```

Each package may import only the ones to its right, and only through their `src/index.ts`
(`.dependency-cruiser.cjs`). `embedder` implements `dense`'s `Embedder`; `eval` measures the rest.

| Command | What it does |
|---|---|
| `bun run check` | lint, typecheck, boundaries, tests |
| `bun run lint` / `lint:fix` | Biome |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run boundaries` | dependency-cruiser |
| `bun test` | all tests, including the rule tests |
| `bun run package` | build the program, its `runtime/` and the npm package for this platform into `dist/` |
| `bun run smoke` | run the built program, and the launcher as a package manager lays it out |

### Engineering standards

Enforced by Biome and the Grit plugins in `tooling/plugins/`. Each rule has failing and passing
fixtures in `tooling/fixtures/`.

1. **Typed errors only.** Throw a `CodeLensError` subclass (`@sutras/code-lens-core`) with a stable `code`
   (`<SUBSYSTEM>_<REASON>`), its subsystem, structured `context` and a `cause`. Never a built-in
   `Error`. Use `toCodeLensError` in `catch` blocks that receive unknown failures.
2. **No swallowed failures.** No empty `catch` (comment-only counts as empty) and no
   `.catch(() => {})`. Handle, wrap and rethrow, or return a typed result.
3. **No static caps or blind truncation.** No `slice(0, 500)`, `Math.min(x, 30)` or similar literal
   bounds. A limit comes from the caller, or is derived from a real constraint, and is reported
   through `LimitReport`. Use `paginate` and cursors for results and split text into more pieces
   rather than cutting it.
4. **Caller-owned time.** Timeouts and cancellation come from a `Deadline`. Nothing picks a timeout
   on the caller's behalf.

`DEFAULT_RESULT_LIMIT` (1000) is the one documented default: high enough not to shape results, there
so an unbounded result set is never returned by accident.
