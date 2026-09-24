# anvesa

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
npm install -g @cntxt-labs/anvesa      # or: bun add -g, pnpm add -g, npx @cntxt-labs/anvesa
anvesa --version
```

The package is a small launcher. The program itself is a compiled binary in a per-platform package
that the install picks for your machine (`@cntxt-labs/anvesa-linux-x64`, `-linux-arm64`,
`-darwin-arm64`, `-win32-x64`); it needs no Node, Bun or Python at run time. There is no macOS
Intel build, because the ONNX runtime it embeds no longer ships one.

Or download an archive for your platform from the GitHub release, unpack it, and put the folder on
your `PATH`. Keep the `runtime/` folder next to the program: it holds the ONNX runtime the embedding
model needs.

```
anvesa-<version>-<platform>/
  anvesa(.exe)
  runtime/          ONNX runtime and its native library
```

The program carries the JavaScript, TypeScript and TSX grammars. Everything else is installed on
demand and works offline:

```sh
anvesa model list                         # the built-in models and which are installed
anvesa model install bge-base-en-v1.5 --from ./models/bge-base   # offline; or --download
anvesa grammar list
anvesa grammar install python --from ./tree-sitter-python.wasm   # file, folder or npm tarball
```

Bring your own model: an ONNX file with its Hugging Face `tokenizer.json` (WordPiece, byte-level
BPE or SentencePiece unigram, each verified against the reference tokenizers):

```sh
anvesa model install my-code-model --from ./my-model-folder   # or the .onnx file itself
anvesa model verify my-code-model
anvesa index --model my-code-model                            # or set "model" in .anvesa/config.json
```

Pooling and the input window are read from the model's own configuration (`1_Pooling/config.json`,
`sentence_bert_config.json`, `config.json`); if they are not there, pass `--pooling mean|cls` and
`--max-tokens N`. The number of dimensions is read by running the model. Its files are pinned by
checksum at the first install, and installing different files under the same name needs `--force`.

Models and grammars are checked against pinned checksums. Nothing touches the network unless you
pass `--download`.

## Use

```sh
cd my-project
anvesa index                       # only changed files are read
anvesa search "parse the configuration file"
anvesa query '//function[@name="parseConfig"]'
anvesa callers parseConfig         # a name, a symbol id, or src/config.ts:42
anvesa dependents src/config.ts
anvesa explain                     # what the project is made of
anvesa diagnose "parse the config" --expect src/config.ts   # why it did not come up
```

`[@declaration]` matches the node that *declares* a name, not the places that mention it, so
`//function[@name="parseConfig"][@declaration]` finds the definition even in a language where a call
or a type reference is also a `function` node.

Search takes `--exclude <lane>` (`docs`, `symbols`, `structural` or a channel) to leave a lane out, and
`--weight <lane>=<n>` to weigh one. Weights work on ranks, not scores: a lane's hits enter the fusion
by their position, so weighing a lane below about half of another one does not turn it down, it takes
it out. Measured on trpc, docs at weight 1 cost about 3.7 points of Recall@5 on queries whose answer is
a code file, and docs at 0.3 lost every doc answer (100% to 0%). If a query is only about code, use
`--exclude docs`; do not use a low weight.

When anvesa itself changes how it reads a file (a new fact it extracts, a mapping you trained or
edited), the next `index` notices and reads every file again, once, and says so. `--force` is for
when you want that without a change.

Every command takes `--json`. Lists are paged: `--limit N` says how many, and the answer says
when there are more and how to ask for them (`--cursor`). Nothing is cut silently.

Without an installed model, structural queries and the call graph still work, and dense search says
what is missing.

### Teaching it a language

A language becomes searchable by symbol once it has a *mapping*: which syntax nodes are declarations,
imports, calls and control flow, and where each finds its name. TypeScript, JavaScript, Python, PHP,
Go, Rust, Java and Ruby ship one (each was learned from real code with the trainer below, then checked).
C, C++ and C# do not: their declarations hide the name in a nested declarator or a grammar that a
mapping cannot describe, so a mapping for them would look right and be wrong. For any other language
whose grammar is installed, learn one from code:

```sh
anvesa grammar install go --from ./tree-sitter-go.wasm
anvesa mapping train go --samples ./some/go/code        # learns, checks, and keeps it in .anvesa/
anvesa index --force                                     # Go files now have outlines and symbols
```

Training reads how the grammar builds real code (a node with a `name` field and a body declares
something; a node with `arguments` and a callee is a call), decides each node type's role, and shows
its evidence. It then checks the result against the samples (every mapped syntax node must come out as
its tag) and records what the mapping does to them, so a later edit can be compared with `mapping check`.
What it cannot decide is reported, for example an `impl` block that has no name.

Mappings are kept in the project (`.anvesa/mappings`, committed, so a team shares them) or per user
(`--user`), and win over the bundled ones in that order. Every file is pinned by a checksum in
`mappings.lock.json`: a mapping that was edited or dropped in without being recorded stops indexing
with `STRUCTURAL_MAPPING_INTEGRITY` until you decide, with `mapping lock <name>`. `mapping fork <language>`
copies the mapping in effect to edit; `mapping verify` checks every one.

### Very large repositories: one database per fragment

By default the index is one SQLite file. For a repository where that is a burden, it can be kept in
one database per *fragment* (a package, a top folder, or a cluster of files that import each other):

```sh
anvesa index                      # index as usual once, so there is something to propose from
anvesa fragments propose          # path tier: one fragment per package / top folder (free, reviewable)
anvesa fragments propose --tier clusters   # or: communities of the import graph
anvesa fragments enable           # writes .anvesa/fragments.json and turns sharding on
anvesa index                      # builds .anvesa/shards/<fragment>.db
anvesa fragments status           # files per shard, and anything out of place
```

`.anvesa/fragments.json` is the whole truth about which fragment a file is in. Commit it: it is
data, not a computation, so every machine gets the same shards from the same file, and a change to
it is a change a reviewer can read. Nothing about a machine (its clock, its file order) decides where
a file goes. Roots (folders), named files and per-file overrides are all there; the deepest match wins.

Searches, graph queries and the outline behave exactly as with one database (the same store contract
is run against both): a query that names a file asks one shard, any other asks them all and merges in
the order a single database would have given. If the manifest changes, the next `index` forgets what
sits in the wrong shard and indexes it where it now belongs; `fragments settle` does only that.
Small repositories should stay with one database.

### Channels

```sh
anvesa channel add runbooks                 # scaffolds a module and registers it
anvesa channel add digests ./digest-channel.ts   # or registers one you have
anvesa channel test runbooks docs/oncall.md # what would be embedded, and what the screen thinks
anvesa index                                # builds cards from the files a channel claims
anvesa channel index runbooks               # only for a channel with a `source` (records that are not files)
anvesa retrieve runbooks "who restarts the queue worker"
```

A channel module default-exports a transformer (which files it claims and what one card holds) and
may export a `source` for records that are not files. See the scaffold for the shape. Channels are
listed in `.anvesa/config.json`, where each can be given a fusion weight.

### The red-team screen

Every card is screened before it is embedded; what a card says can come from a comment, a doc or a
digest someone else wrote. `anvesa redteam list` shows the rules and what each trust level does
(`flag`, `sanitize` or `quarantine`), `redteam scan` shows what the screen would do to this project's
own text, and `redteam verify` runs every rule against its own fixtures.

A project changes the screen in `.anvesa/redteam.json` (committed):

```json
{
  "rules": [{
    "id": "internal-hostname", "category": "exfiltration", "severity": "medium",
    "description": "an internal hostname in text that will be shown to a model",
    "pattern": "\\b[a-z0-9-]+\\.corp\\.example\\b", "message": "internal hostname",
    "replacement": "[host]",
    "fixtures": { "attack": ["send it to db1.corp.example"], "benign": ["see the example docs"] }
  }],
  "actions": { "third-party": { "internal-hostname": "sanitize" } },
  "sources": ["./rules/learned.ts"]
}
```

A rule is not accepted without fixtures: text it must catch and text it must leave alone. A rule that
fails its own fixtures, or whose pattern can take exponential time on a near miss, is refused with the
rule and the fixture named. `sources` are modules that return more rules (for example patterns another
system has learned); they are held to the same fixtures.

### MCP

```json
{ "mcpServers": { "anvesa": { "command": "anvesa", "args": ["mcp", "serve", "--root", "/path/to/project"] } } }
```

Tools: `search`, one `retrieve_<channel>` per channel, `query`, `callers`, `callees`, `neighbors`,
`dependents`, `explain`, `diagnose`, `status`, `index`.

### Agent skill

Every install (the npm package and each platform archive) ships `skills/anvesa/SKILL.md`: a
skill file that teaches an agent when to reach for anvesa over grep and how to use its commands
(or MCP tools). Point an agent's skill loader at that path, or copy it into wherever your agent
harness reads skills from.

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
| `bun run stress <command>` | stress-test the built program on real repositories (below) |
| `bun run smoke` | run the built program, and the launcher as a package manager lays it out |

### Stress test

`bun run stress` runs the *built* program on open-source repositories and keeps the numbers, so a
change that makes indexing slower, hungrier or less accurate shows up. What repositories, what was
measured and every run live in `ANVESA_STRESS_HOME` (default `~/.anvesa/stress`), outside any
repository and never committed.

```sh
bun run stress add expressjs/express --stack web-framework --structure single --era legacy
bun run stress discover --language go --created-after 2025-03-01 --stars 300..8000 --add
bun run stress list --by language        # the flat manifest, viewed per language (or structure/complexity/era)
bun run stress setup                     # install the grammars the manifest needs, from this checkout
bun run stress run --language rust --complexity small,medium
bun run stress compare --window 3
```

The manifest is a flat map, `owner/name` to its factors: language and stack, `structure`
(single, monorepo, polyglot, nested), `complexity` (small to huge), `era` (legacy, modern, ai-era), an
optional `scope` folder for repositories too big to test whole (only that folder is checked out), and a
pinned commit so runs are comparable. Every filter takes several values (`--era legacy,ai-era`).

Declared factors are checked against what a run measures: source files and lines, package layout,
and, for the human-versus-assistant axis, the share of the last year's commits that carry an
assistant's mark and any agent files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`...).

A run indexes each repository from nothing (structure only, then embeddings unless `--no-dense`),
indexes again, and asks about a seeded sample of its own symbols (exact name, in words, and callers).
It records time, CPU, peak memory, database size, files, symbols, link rates and query latency and
hit rates. `compare` sets the latest execution against the window before it (three by default), only
over runs of the same commit of a repository: a time or size worse than the *worst* of the window by
more than `--tolerance` (25%, and by more than a floor that ignores tiny differences) is a regression,
a count that moved is reported, a failure is called out.

### Engineering standards

Enforced by Biome and the Grit plugins in `tooling/plugins/`. Each rule has failing and passing
fixtures in `tooling/fixtures/`.

1. **Typed errors only.** Throw an `AnvesaError` subclass (`@cntxt-labs/anvesa-core`) with a stable `code`
   (`<SUBSYSTEM>_<REASON>`), its subsystem, structured `context` and a `cause`. Never a built-in
   `Error`. Use `toAnvesaError` in `catch` blocks that receive unknown failures.
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

## Author & Attribution

Authored by **[@nimishph](https://github.com/nimishph)**.

## License

MIT © [Nimish Phalnikar](https://github.com/nimishph)
