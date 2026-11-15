---
id: plan/pr-review-followups
status: draft
---

# Review follow-ups on the Wave A–D PRs

The maintainer's review comments on nimishph/anvesa#52 (Wave A) and #53 (Wave B), planned as one
piece of work. #54 and #55 had none. Each requirement names the comment it answers.

The work comes in three kinds, and they land in this order:

1. **Fixes** that are small and stand alone: the dashboard's sample data and the empty catch (#52),
   and `init` running `model use` (#53). They can land on their PR's branch.
2. **Restructures** that move a lot of code without changing behaviour: the CLI command registry
   (#52) and the model registry (#53). They land after the whole A–D stack has merged into `main`,
   because Waves C and D edit the same files and a move made earlier would conflict at every level
   of the stack.
3. **Designs** the maintainer asked for before any code: patterns (#52), corpus adapters (#52) and
   whether a small on-device model would help them. Each is a written proposal for the maintainer to
   accept, change or reject. The code follows in a plan of its own, once a design is chosen.

The proposals below are first sketches, so the requirements have something concrete to argue
against. They are not decisions.

## Requirement: the dashboard shows real state or says why it cannot, never sample data {#req-ui-no-mock}

Answers #52 on `ui/public/js/graph.js` ("no mock data - show clear status panel") and
`ui/public/js/search.js:316` ("What's need of ANVESA_MOCK?").

`window.ANVESA_MOCK` (`ui/public/js/mock-data.js`) is left over from before the dashboard had a live
index. Search, graph, repomap, routes and health all fall back to it. Instead, each view shows one
status panel naming the state and what to do about it:

- **not indexed** (`RETRIEVER_NOT_INDEXED`): run `anvesa index`;
- **server unreachable**: restart `anvesa ui`;
- **no encoder**: install a model, and say which, while structural search still runs;
- **nothing found**: for a query or a symbol, the same wording as the CLI.

The server stops answering `demo: true`. Wave A's `failure()` returns `{ live: false, state:
'not-indexed', message }`, and the page draws the panel from `state`.

```yojana:claim
kind: path
expression: ui/public/js/mock-data.js
expect: false
```

```yojana:claim
kind: text
expression: ANVESA_MOCK in ui/public/**/*.js
expect: false
```

```yojana:claim
kind: text
expression: "demo: true in ui/src/server.ts"
expect: false
```

Done. `mock-data.js` is gone, and every view draws `ui/public/js/state-panel.js` from the server's
`state`: `not-indexed`, `unavailable`, `no-encoder`, `invalid` or `error`, plus `unreachable` when
the server itself did not answer. An index that opens with no files in it counts as not indexed.
The fixes found along the way:

- The header pill said "Ready" before anything was known; it now names the state.
- The header showed a hard-coded `sutras/anvesa`; it now shows the project's folder name.
- The graph drew made-up callers and callees for a symbol that had none.
- Search cards showed a made-up score of `0.850`.
- The routes table read `path` as the URL pattern; the live field is `route`.
- The routes filter added a new listener on every load.

## Requirement: no empty catch in the dashboard's scripts {#req-ui-no-empty-catch}

Answers #52 on `ui/public/js/graph.js:86` ("empty catch not allowed").

A failed request is a state for the panel in `req-ui-no-mock` ("server unreachable"), not something
to swallow. Every `catch` in `ui/public/js` either shows the failure or rethrows it. There are three
empty ones today: `graph.js:85` (a comment only), `graph.js:482` and `graph.js:546` (`catch {}`).

The repository already has the rule, `tooling/plugins/no-empty-catch.grit`, but `biome.json`
excludes `ui/public`, so the dashboard's scripts were never linted. Linting them is the fix that
lasts. The browser scripts may need their own biome overrides (globals such as `window`), not an
exclusion.

```yojana:claim
kind: text
expression: "!ui/public in biome.json"
expect: false
```

```yojana:claim
kind: text
expression: "catch {} in ui/public/js/*.js"
expect: false
```

Done. `ui/public` is linted. A fourth empty handler, a `.catch(() => {})` in `app.js`, was found
once it was. The HTML's lint findings are fixed too: button types, decorative icons hidden from
screen readers, the logo as a button rather than a `javascript:` link, and a name for the docs link.

## Requirement: `init` ends by running `model use` {#req-init-model-use}

Answers the #53 review ("with init -- auto run model use once necessary initializations are done").

Today `init` has its own model prompt (`chooseModel` in `cli/src/init.ts`), separate from `model
use`'s picker. Instead, once `init` has written its files, set up the agent section and offered
parsers, it calls `useModel` from `cli/src/model-use.ts`. There is then one picker: the same list,
the same Enter-keeps-current, and the same download-on-yes. The rules for when `init` may download
stay as they are: a terminal asks, `--yes` accepts, `--no-download` and `--json` only report.
`chooseModel` is removed.

```yojana:claim
kind: text
expression: useModel in cli/src/init.ts
```

```yojana:claim
kind: text
expression: choiceTable in cli/src/init.ts
expect: false
```

Changed. `chooseModel` stays as the name of `init`'s step, but its body is now a call to
`useModel`, so the second claim is replaced by one on the picker it removed (`choiceTable`).
`useModel` gained what `init` needs:

- `fallback`: the model this machine suits, picked by Enter or `--yes`;
- `notes`: "recommended" or "too large" beside a model;
- `mayDownload`: no network, or `--no-download`;
- `declineSkips`: a no to the download skips the step, rather than failing `init`;
- a disk-space check, and "s" to skip.

`init` asks about parsers, then the skill, then the model, so the model comes once everything else
is in place.

## Requirement: models are described one file each, found by a registry {#req-model-registry}

Answers #53 on `embedder/src/models.ts:199` ("dont maintain hardcoded here --- create a registry
pattern that refers to model-config dir - where one config per model is maintained").

Proposal:

- `embedder/models/<id>.json`, one per built-in model, holds everything a `ModelSpec` holds today:
  repo, revision, file paths, sizes and checksums, dimensions, pooling, family, tier, license, notes
  and summary. `schemas/model.v1.json` describes the format.
- `embedder/src/registry.ts` builds the catalog from those files, so that `MODEL_CATALOG`,
  `BUILTIN_MODELS`, `OPEN_MODELS` and `builtinModel()` all become views of the registry.
- A compiled binary cannot read a source folder at run time, so `scripts/gen-model-index.ts`
  writes `embedder/src/models.generated.ts`. That file imports every config with `with { type:
  'json' }`. A test fails when the folder and the generated index disagree, so adding a model is:
  add a file, run the script.
- Models a person brings in (`anvesa model install --from`) already keep a `model.json` in the
  models cache. The registry reads those through the same loader, so built-in and custom models
  share one format and one set of checks.
- Retired ids (`RETIRED_MODELS`) become a `retired` field in the replacement's config.

```yojana:claim
kind: path
expression: embedder/models/gte-modernbert-base.json
```

```yojana:claim
kind: path
expression: embedder/src/registry.ts
```

```yojana:claim
kind: text
expression: "/const [A-Z0-9_]+: ModelSpec = \\{/ in embedder/src/models.ts"
expect: false
```

## Requirement: CLI commands live one per module, registered by id {#req-cli-registry}

Answers #52 on `cli/src/commands.ts` ("file is too big, reorganize ...") and its reply ("every
command must have an id of format `resource:cmd_name` through which it gets registered").

`cli/src/commands.ts` is about 1900 lines. It holds every handler, the shared session code and the
renderers' glue, and `cli/src/help.ts` keeps a second list of the same commands. Layout, as asked:

```
cli/src/cmd/
  root.ts          parse argv, find the command by id, run it, map errors to exit codes
  registry.ts      discovers the command modules, registers each by id, injects shared services
  shared/          session (openSession, withProject), output (emit, formats), options, errors
  commands/
    project/       init.ts, status.ts, where.ts, ui.ts
    index/         index.ts, fragments.ts
    search/        search.ts, retrieve.ts, query.ts, diagnose.ts, federation.ts
    graph/         callers.ts, callees.ts, neighbors.ts, dependents.ts, explain.ts, map.ts, routes.ts
    extend/        channel.ts, grammar.ts, mapping.ts, model.ts, pattern.ts, redteam.ts
    agent/         primer.ts, skill.ts, telemetry.ts, issue.ts, mcp.ts
```

- Each module exports one `defineCommand({ id, words, summary, details, options, run })`. `id` is
  `resource:cmd_name` (`graph:callers`, `model:use`, `search:query`); `words` is what a person
  types (`callers`; `model use`).
- Help, the drift test and the MCP server read the registry, so `help.ts`'s separate list goes
  away.
- `run` receives its services (the session opener, the model cache, the prompt, the clock), so a
  test can pass fakes without building an `Environment`.
- Discovery is a generated index, as in `req-model-registry` (a compiled binary has no folder to
  scan), and a test checks that it matches the folder.
- Behaviour does not change: the existing CLI tests run unchanged against the new layout. That is
  the check that the move was only a move.

```yojana:claim
kind: path
expression: cli/src/cmd/registry.ts
```

```yojana:claim
kind: text
expression: "/id: '[a-z]+:[a-z_-]+'/ in cli/src/cmd/commands/**/*.ts"
```

```yojana:claim
kind: path
expression: cli/src/commands.ts
expect: false
```

## Requirement: a design for patterns: where they live, how they are found, how they run {#req-pattern-design}

Answers #52 on `retriever/src/pattern-runner.ts` ("frugal system-design, propose a better system
design for `pattern` feature --- should cover organization of files at end-user machine for
discovery and pattern workflow architecture").

The deliverable is `docs/design/patterns.md`, for the maintainer to decide on. It covers:

- **Where patterns live, and which wins.** There are three tiers, the way grammars already have
  project and user tiers:
  - bundled with anvesa;
  - the user's, in `~/.anvesa/patterns/`;
  - the project's, in `.anvesa/patterns/`.

  A pattern is named `tier:name` when its bare name is ambiguous. A project pattern shadows a user
  one, which shadows a bundled one, and `pattern list` says when that happens. Today only the
  project tier exists, and every file is read and compiled on each `list` or `run`.
- **Discovery that is frugal.** A manifest per tier (`patterns.lock.json`: name, file, checksum,
  compiled WQL, parameters) is rebuilt only when a file's checksum changes. `list` reads the
  manifests and nothing else, and `run` compiles nothing that has not changed.
- **The workflow.** There are four steps:
  - **author:** `pattern new` scaffolds a pattern from a WQL query that already works;
  - **check:** `pattern check` compiles it and runs it against the index, with the diagnostic it
    would give;
  - **run:** CLI, MCP and the dashboard;
  - **share:** copy it to the user tier, or commit it to the project.
- **Components.** The loader (files to specs), the manifest (cache and integrity), the compiler
  (exists), the runner (exists) and the surfaces (CLI, MCP, UI). Each has one job, so the workflow is
  a pipeline rather than one class.
- **What it costs.** Measure the time `list` and `run` take on 10, 100 and 1000 patterns, before and
  after.

```yojana:claim
kind: path
expression: docs/design/patterns.md
```

## Requirement: a design for corpus adapters as strategies chosen by policy {#req-corpus-design}

Answers #52 on `structural/src/corpus-adapter.ts` ("bad design - propose new design for feature by
thinking on lines of strategy or policy pattern").

Today `RouteEndpointCorpusAdapter` is one class that holds every framework's regexes. Its
`claim()` guesses from path words ("route", "api") and content words ("app."). Its `extract()`
runs Next.js, Laravel, Lumen, Express and Python one after another, and Laravel group prefixes were
added on top (Wave A). Each new framework makes every file pay for every other framework, and one
framework's regex can match another's code.

The deliverable is `docs/design/corpus-adapters.md`. Proposal to argue against:

- **Strategy.** One `RouteStrategy` per framework (`laravel`, `lumen`, `express`, `fastapi-flask`,
  `nextjs-app`), each with:
  - `detect(project)`: run once per index, from the manifests the project already has
    (`composer.json`, `package.json`, `pyproject.toml`, `app/` layout);
  - `extract(file)`: preferably a tree-sitter query through the structural layer, which already
    parses the file, rather than a line regex.
- **Policy.** A `CorpusPolicy` decides which strategies run on which files:
  - by default, the frameworks detected in the project;
  - overridden in `.anvesa/config.json` (`corpora.routes.frameworks`);
  - a strategy runs only on the languages and paths it declares.

  Docblock annotations become a second corpus under the same policy.
- **Extension.** A project adds a strategy the way it adds a channel: a module with a pinned
  checksum.
- **Checks.** A fixture project per framework, with the routes it must yield.

```yojana:claim
kind: path
expression: docs/design/corpus-adapters.md
```

## Requirement: research whether a small on-device model helps corpus inference {#req-edge-model-research}

Answers the second half of the #52 comment on `corpus-adapter.ts` ("also research if training a
small edge model would prove beneficial for intermediate inference").

The deliverable is `docs/research/edge-model-corpus.md`: a measured answer, not an opinion.

- **Question.** After the strategies above, which corpus decisions are still guesses? The two
  candidates:
  - whether an unknown framework's call is a route registration;
  - which handler a route resolves to through indirection.

  Does a small model (a classifier head on the anvesa-code-150m encoder that is already installed,
  or a tree-based model over syntax features) make those decisions better than rules, at a cost
  that suits indexing?
- **Method.**
  - Label route registrations in about 30 open repositories across the five frameworks, plus about
    10 repositories using frameworks the rules do not know.
  - Measure precision and recall of the rules, then of the model, per framework and on the unknown
    ones.
  - Measure indexing time and memory with the model on a CPU.
- **Bar.** Worth building only if it raises recall on unknown frameworks by a clear margin
  (proposed: 15 points) without lowering precision on known ones, and adds under 10% to indexing
  time. Otherwise the answer is "rules plus a strategy per framework", and the document says why.
- **Constraint.** Nothing in it uses a third-party hosted model or decision service: the model, if
  any, is trained and shipped as one of anvesa's own.

```yojana:claim
kind: path
expression: docs/research/edge-model-corpus.md
```
