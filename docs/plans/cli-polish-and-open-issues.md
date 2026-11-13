---
id: plan/cli-polish-and-open-issues
status: draft
---

# CLI polish and the open issues (0.8.0-alpha.3)

Two streams in one plan. The first is the seven open GitHub issues (nimishph/anvesa #26, #46–#51),
all filed against 0.8.0-alpha.3 or earlier. The second is six asks from the maintainer: a `model use`
picker, a wider `model list`, a telemetry notice on every index/search run, settings in `anvesa ui`,
an audit of every command against the primer and skill, and a way to install the anvesa skill.

Order of work (each wave can ship as its own alpha):

1. **Wave A, correctness:** #47, #48 (UI shows wrong data), #26.1 (search silently returns nothing),
   #51 pattern escaping (an injection-shaped bug), #46 (routes), and `init` adding `$schema` to an
   existing config.
2. **Wave B, model UX:** `model use`, `model list` catalog, #26.2–3 (tokenizer acceptance).
3. **Wave C, surface audit:** the command/primer/skill audit, #49 doc mismatches, #50 channel gaps,
   the rest of #51.
4. **Wave D, new surfaces:** UI settings, telemetry notice, skill install.

The audit (Wave C) comes before the new surfaces so that new commands land in an already-synced
primer and skill rather than widening the drift.

## Requirement: the dashboard searches with the project's embedder {#req-ui-embedder}

Issue #47. `ui/src/server.ts` opens `Retriever.open({ root, config })` without the embedder the CLI
resolves, so every non-WQL search fails with "No embedder is available" and the page silently falls
back to demo data under a **Live Index Connected** header. The server resolves the embedder the same
way `anvesa search` does (shared helper, not a copy). When it cannot, `/api/search` returns the
error and the page shows it; it never substitutes demo results for a live project. The first-load
graph request uses a symbol from the live index, not `Retriever.search` from the mock data.

```yojana:claim
kind: text
expression: /fallback:\s*true/ in ui/src/server.ts
expect: false
```

## Requirement: result cards render highlighted code, not markup {#req-ui-highlight}

Issue #48. Snippets show `hl-keyword">export` because the highlighted HTML is escaped (or
highlighted twice). Escape once, before highlighting. A UI test feeds a snippet containing `<`, `&`
and `"` and checks the rendered card has no `hl-` text outside class attributes.

## Requirement: the encoder an index was built with is the one search uses {#req-model-recorded}

Issue #26 item 1. `anvesa index --model X` records X in the project config; plain `status`,
`search` and `query` use it rather than re-choosing by hardware. A model that differs from the one
the index was embedded with is an error naming both. `init --model` and `model verify` accept
installed custom models, not only the built-in list.

Found already done in 0.8.0-alpha.3 (Wave B survey): `index` writes `"model"` to the config,
`Retriever` raises `ModelMismatchError` (`RETRIEVER_MODEL_MISMATCH`), and the CLI tests "index
records the model it embedded with" and "init --model takes a model the user installed" cover it.

```yojana:claim
kind: text
expression: RETRIEVER_MODEL_MISMATCH in retriever/src/errors.ts
```

## Requirement: tokenizers with literal added tokens and a named pad token install {#req-tokenizer-accept}

Issue #26 items 2–3. Non-special `added_tokens` (ModernBERT's `|||IP_ADDRESS|||` and whitespace
runs) are matched literally before the model's pre-tokenizer, as Hugging Face does. A tokenizer
with no `padding` block still finds its pad token (ModernBERT's `<|padding|>`).

Found already done in 0.8.0-alpha.3 (`addedTokenSplitter` and `PAD_NAMES` in
`embedder/src/tokenizer-hf.ts`). Checked in Wave B: the unmodified gte-modernbert-base
`tokenizer.json` (revision e7f32e3c) gives the same ids as Hugging Face `tokenizers` 0.22.2 on code,
whitespace runs and the `|||…|||` tokens. The one difference is deliberate: text that spells a
special token (`[CLS]`, `<|padding|>`) stays text, so a source file cannot inject one.

```yojana:claim
kind: text
expression: export function addedTokenSplitter in embedder/src/tokenizer-hf.ts
```

## Requirement: pattern parameters cannot change a query's shape {#req-pattern-escape}

Issue #51 (patterns). Parameter values are escaped as WQL string literals before substitution, so
`prefix=use"][@name$="State` matches a name with those characters and adds no predicate. Also: a
pattern without a description is reported invalid, a duplicate name is an error at load, and an
unknown parameter is an error listing the accepted ones.

## Requirement: Laravel routes carry their group prefixes {#req-laravel-prefixes}

Issue #46. Prefixes accumulate through nested `Route::prefix(...)->group(...)` and
`Route::group(['prefix' => ...], ...)`, including chained `middleware()->prefix()`, `name()` and
`controller()`. The repro in the issue lists `/cart`, `/cart/add`, `/cart/items/{id}`, `/profile`,
`/orders/{number}`, `/health`, and is checked in as a fixture test.

## Requirement: `init` adds `$schema` to an existing config that lacks it {#req-init-schema}

New. A fresh `.anvesa/config.json` from `init` carries `$schema`, but an existing one is "kept"
untouched (`cli/src/commands.ts`, the `init` handler), and `$schema` only appears later if `index`
or `rememberModel` happen to rewrite the file for a model change. `init` instead adds
`"$schema": CONFIG_SCHEMA_URL` as the first key to a kept config that has none, keeps every other
key, value and their order, never replaces a `$schema` the user set, and reports
`updated .anvesa/config.json (added $schema)`. A config that is not valid JSON is reported and left
alone. Tests: missing → added first; present (any value) → untouched; invalid JSON → untouched with
a note.

```yojana:claim
kind: text
expression: added \$schema in cli/src/commands.ts
```

## Requirement: `anvesa model use` picks the project's encoder interactively {#req-model-use}

New. `anvesa model use` on a terminal shows a numbered list of the installed and installable
models (from the catalog in req-model-catalog) with kind, size, licence and which is installed and
in use; a number or a name chooses and Enter keeps the current one. It uses the same prompt `init`
does, so it works on any terminal and in tests; an arrow-key menu would need raw-mode input the
CLI does not have yet. `anvesa model use <id>` does the same without a prompt (scripts, CI,
agents). The choice is written to `.anvesa/config.json`'s `model`. A model that is not installed is
downloaded first after a yes (or with `--download`/`--yes`), so the config never names a model that
cannot load. It says that `anvesa index` must re-embed when the model changed. Off a terminal with
no id it errors, naming `model use <model>`.

```yojana:claim
kind: text
expression: case 'use' in cli/src/commands.ts
```

## Requirement: `model list` shows the anvesa-code models and a curated set of open models {#req-model-catalog}

New. `model list` groups: **anvesa-code** (built in), **open models** (a curated, licence-checked
catalog: gte-modernbert-base, Apache-2.0, first; each entry has repo, pooling, max tokens, licence
and a pinned revision and checksums), and **installed custom** models. An open-model entry installs
with `anvesa model install <id> --download`, no `--from` needed, and is never chosen automatically.

Changed in Wave B: the bar of a measured MRR before listing is not met for gte-modernbert-base.
anvesa-gen-lab's bench is not on the machine this was built on. The entry is listed anyway, as the
maintainer asked, and its notes say it is a general-purpose encoder not scored on code and with no
ranker. Scoring it is a follow-up in anvesa-gen-lab; if it scores below anvesa-code-150m, the notes
say so.

```yojana:claim
kind: text
expression: gte-modernbert-base in embedder/src/models.ts
```

## Requirement: every command is listed, documented, and matches the primer and skill {#req-command-audit}

New. A table in this plan's follow-up (`docs/command-audit.md`) lists every command in
`cli/src/help.ts` (`init` through `mcp serve`, 26 entries) with: does `--help` match behaviour, is
it in the primer, is it in `skills/anvesa/SKILL.md`, is it an MCP tool, and gaps found. The primer
today has topics overview, wql, fusion, graph, indexing and grammars; routes, patterns, federation
(including the `workspace.json` format #51 had to discover from errors), fragments, channels,
models and telemetry have none. A test fails when a command in `COMMAND_HELP` is named in neither
the primer nor the skill, and when the skill or primer shows WQL syntax the parser rejects.

```yojana:claim
kind: path
expression: docs/command-audit.md
```

## Requirement: documented WQL forms work or are no longer documented {#req-wql-docs}

Issue #49. Decide per form: `@name=~` (accept as an alias of `~=`), `//class/method` (support child
`/` or remove it from the primer), `@visibility`/`@export`/`@async` (remove from the skill unless
indexed), `*=` (document `contains()`), `[@kind="function"]` (fix or explain). `query` warns when a
file it returns has changed since indexing; `--limit -1` reports a limit error.

## Requirement: channels cannot shadow or silently lose built-ins {#req-channel-gaps}

Issue #50. `channel add` refuses a built-in name; `channel remove` of a built-in or an unknown name
is an error; changing a module's claim triggers a reindex of that channel without a version bump.

## Requirement: the rest of the observed issues {#req-observed-rest}

Issue #51, beyond patterns: federated results keep their source scores beside the fused rank;
`--repo` naming a missing or unknown repo is an error; `query --federated` and `retrieve --federated`
work or are refused; an unreadable `.git` is a warning, not an `EACCES` crash; `map --budget` caps
output; `map <missing>` is an error and `--depth` counts from the named directory; `fragments
settle` re-scans first; `fragments disable` removes `shards/` and `fragments.json`; cluster tier
merges fragments under a minimum size. Progress per shard while indexing a sharded project (#26.4).
Path/fragment filter for `search` (#26.5) is tracked here but may move to its own plan.

## Requirement: the telemetry notice shows on every index and search run {#req-telemetry-notice}

New. Today `TELEMETRY_NOTICE` shows once and is remembered in `preferences.telemetry.notice_shown`.
Instead, while telemetry is on, `index`, `search` and `query` print a one-line notice on stderr
(not the five-line block) every run, unless `preferences.telemetry.show_notice` is `false` in the
user config or the project config. `anvesa telemetry quiet` sets it. The first run still sends
nothing until the notice has been seen once. Never printed with `--json` on stdout, the MCP server,
or CI.

```yojana:claim
kind: text
expression: show_notice in cli/src/telemetry.ts
```

## Requirement: `anvesa ui` edits the project's settings {#req-ui-settings}

New. A Settings view in the dashboard reads `.anvesa/config.json` against `schemas/config.v1.json`
and edits the common keys: model (with the same catalog as `model use`), channels, fusion
parameters, ignore patterns, telemetry. `GET/PUT /api/config` validates against the schema, writes
with the CLI's file lock, keeps unknown keys and key order, and says which changes need a reindex.
The server binds to localhost only and the PUT requires a per-launch token printed in the URL, so
another page in the browser cannot rewrite the config.

```yojana:claim
kind: text
expression: api/config in ui/src/server.ts
```

## Requirement: the anvesa skill can be installed into an agent's skill folder {#req-skill-install}

New. `anvesa skill install [--agent claude|opencode|codex] [--user|--project]` copies the packaged
`skills/anvesa/SKILL.md` (already in the npm `files`) into the agent's skill folder, e.g.
`.claude/skills/anvesa/` or `~/.claude/skills/anvesa/`. `anvesa skill status` shows where it is
installed and at which version. `init` offers it alongside the AGENTS.md section. `index` and
`search` refresh an *already installed* copy whose version is older, silently, and never install one
that is not there. No npm `postinstall`: it is skipped under `--ignore-scripts`, runs without a
project, and writes to a home directory nobody approved.

```yojana:claim
kind: text
expression: /skill install/ in cli/src/help.ts
```
