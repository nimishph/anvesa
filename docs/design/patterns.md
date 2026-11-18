# Patterns: where they live, how they are found, how they run

Status: proposal, for the maintainer to decide. Answers the review on #52
(`retriever/src/pattern-runner.ts`): a frugal system design for the `pattern` feature, covering
where pattern files sit on an end user's machine and how the pattern workflow is put together.

## Where things stand

A pattern is a JSON file (`PatternSpec`, `structural/src/pattern/schema.ts`): a target (`function`,
`class`, …), optional scope, filters and parameters, and a description. `compilePattern` turns it
into WQL; the runner binds the parameters, runs the query and adds a diagnostic when nothing
matched for a reason it can name.

Today:

- **One tier.** Only the project's `.anvesa/patterns/*.json` is read. Nothing ships with anvesa,
  and a person cannot keep patterns of their own across projects.
- **Everything is loaded, every time.** `PatternRunner.inspect()` reads, parses, validates and
  compiles every file on each `pattern list`, and `pattern run <name>` goes through the same full
  load to find one pattern, because a pattern's name is inside the file, not its file name.
- **One class does it all.** `PatternRunner` finds the files, validates them, settles duplicate
  names, compiles, binds and runs. The CLI (`extend:pattern`) and MCP (`pattern_list`,
  `pattern_run`) call it; the dashboard has no patterns view.
- **No authoring help.** A person writes the JSON by hand, from `anvesa primer patterns`, and learns
  it is wrong from `pattern list`'s invalid section. There is no JSON schema for editors.

## What it costs today

Measured on Windows 11, Bun, warm file cache, 20 runs each, the pattern files being small
realistic specs. `run` is measured with the query stubbed out, so it is only the overhead before
the query starts.

| patterns | `list` | `run` (before the query) |
| ---: | ---: | ---: |
| 10 | 2.7 ms | 2.1 ms |
| 100 | 16.9 ms | 14.6 ms |
| 1000 | 166 ms | 157 ms |

Where the time goes, at 1000 files:

| step | time |
| --- | ---: |
| list the folder | 1.4 ms |
| read every file, one at a time with `await` (what the runner does) | 161 ms |
| read every file, all at once (`Promise.all`) | 28 ms |
| `stat` every file | 54 ms |
| parse and compile every spec | 10 ms |
| read one 1000-entry manifest | 2.3 ms |
| read, parse and compile one file | 0.13 ms |

Three things follow:

1. **Compiling is cheap.** It is 6% of the total. A cache of compiled WQL saves almost nothing.
2. **The cost is serial reads.** Reading the same files in parallel is 6× faster, with no cache.
3. **A checked manifest is not frugal.** A lockfile that is trusted only after checking each
   file's checksum, or even its size and mtime, has to `stat` (54 ms) or read (28 ms) every file
   anyway, which costs as much as just reading them. An unchecked manifest is cheap (2.3 ms) but
   goes stale the moment someone edits a file in their editor, which is exactly how patterns are
   written.

After step 1 (below), measured the same way:

| patterns | `list` | `run` (before the query) |
| ---: | ---: | ---: |
| 10 | 1.6 ms | 0.3 ms |
| 100 | 5.2 ms | 0.3 ms |
| 1000 | 38 ms | 0.3 ms |

So this proposal **does not** include the `patterns.lock.json` the plan sketched. It gets the same
result more simply: `run` reads one file, and `list` reads all of them in parallel.

## Where patterns live, and which wins

Three tiers, the same order grammars and model configs already use:

| tier | where | who writes it | shared by |
| --- | --- | --- | --- |
| `project` | `<project>/.anvesa/patterns/<name>.json` | the team, committed | everyone on the project |
| `user` | `~/.anvesa/patterns/<name>.json` | the person | every project on that machine |
| `bundled` | `retriever/patterns/<name>.json`, compiled into the binary | anvesa | every install |

- **The file name is the pattern's name.** `<name>.json` holds the pattern called `<name>`, the
  rule model configs already follow (`~/.anvesa/models/<id>.json`). That is what makes `run` read
  one file per tier instead of all of them. A file whose `name` differs from its file name is
  invalid, and `list` says so. Names are `[a-z0-9][a-z0-9-]*`, so a name never reaches a path.
- **Project shadows user, user shadows bundled.** `pattern run handlers` takes the first tier that
  has `handlers.json`. `pattern list` shows one row per name, with its tier, and says when it
  shadows another (`handlers  project  (shadows user)`).
- **`tier:name` reaches past shadowing.** `pattern run user:handlers` runs the user's even though the
  project has one. A bare name is never ambiguous, because shadowing settles it, so the prefix is
  only needed for that.
- **Two files, one name, one tier** cannot happen once the file name is the name, which removes
  today's rule that neither of two clashing files runs.
- **The bundled tier** is built in the same way as the model registry: a generated index imports
  each `retriever/patterns/*.json`, a test fails when the folder and the index disagree, and a
  compiled binary needs no folder at run time. It starts small (a few that work in every
  language: exported functions with no callers, classes with no methods, …) and grows only when a
  pattern has earned its place in a project first.

## Finding them, frugally

- **`run <name>`** reads `<name>.json` from the project tier, then the user tier, then the bundled
  index, and stops at the first one that exists. One `stat`-and-read per tier at most, about 0.1 ms,
  whatever the number of patterns.
- **`list`** lists the three folders, reads every file in parallel, then parses and validates each
  one. 1000 patterns: about 40 ms instead of 166 ms. Invalid files are listed with the reason,
  never dropped.
- **No cache, no lockfile.** There is nothing to rebuild, nothing to go stale, and no new file
  format. If patterns ever reach the tens of thousands, a cache keyed on the folder's listing can
  be added then, behind the loader, without changing anything else.

## The workflow

| step | command | what it does |
| --- | --- | --- |
| author | `pattern new <name> [--user]` | writes `<name>.json` in the project tier (or the user's), from flags (`--kind function --starts-with handle --within class`), and prints the WQL it compiles to |
| check | `pattern check <name> [param=val…]` | validates and compiles it, runs it against the index, and prints the WQL, the hit count and the diagnostic it would give; exits non-zero when invalid |
| run | `pattern run <name>`, MCP `pattern_run`, the dashboard | as today, plus the tier lookup |
| share | `pattern copy <name> --to user\|project` | copies it between tiers; committing the project tier is how a team shares one |

Notes:

- **Authoring starts from flags, not from WQL.** The plan suggested scaffolding a pattern from a
  WQL query that already works. That is compiling backwards: WQL can say far more than a pattern
  spec, so most queries have no pattern form. Instead, `pattern new` prints the WQL its spec
  compiles to, and the person compares it with the query they had.
- **`check` is `run` with more said.** It is the same code path, and it reports the compiled WQL
  and the diagnostic even when there are hits, so an author sees what the pattern does before
  relying on it. Among those warnings is every field the compiler does not know: a misspelt
  `nameStartWith` is otherwise ignored, and the pattern quietly matches more than it should. It is
  a warning, not a rejection, so a file written for a later version still loads.
- **A JSON schema, `schemas/pattern.v1.json`,** gives editors completion and errors as the person
  types, the way `config.v1.json` and `model.v1.json` do. `pattern new` writes its `$schema`.
- **The dashboard** gets a read-only list (name, tier, description, shadowing) and a run box. It
  is the last step and can wait.

## Components

The workflow becomes a pipeline of small pieces, each with one job. Only the first two are new; the
rest exist and lose the jobs they should not have.

```
 tier folders + bundled index
          │
   ┌──────▼──────┐   files → specs, with each invalid file and why
   │   loader    │   (retriever/src/patterns/loader.ts)
   └──────┬──────┘
   ┌──────▼──────┐   tier order, shadowing, tier:name
   │  resolver   │   (retriever/src/patterns/resolver.ts)
   └──────┬──────┘
   ┌──────▼──────┐   spec → WQL, parameters, diagnostics
   │  compiler   │   (structural/src/pattern/compiler.ts, exists)
   └──────┬──────┘
   ┌──────▼──────┐   bind, corpus filter, query, diagnose
   │   runner    │   (retriever/src/pattern-runner.ts, exists, loses the loading)
   └──────┬──────┘
          │
   CLI · MCP · dashboard
```

- **loader:** given a tier and a folder (or the bundled index), it reads one named file or all of
  them, checks each against the schema and its file name, and returns specs and invalid files. It
  knows nothing about other tiers.
- **resolver:** holds the loaders in tier order. `find(name)` asks each in turn; `inventory()`
  merges their lists and marks shadowing. This is the only place tier precedence lives.
- **compiler:** unchanged.
- **runner:** takes a resolved spec, so it no longer reads files. `PatternRunner.inspect()`,
  `list()` and `get()` move to the resolver; the runner keeps `run()`.
- **surfaces:** CLI and MCP call the resolver and the runner and own nothing else, which is how the
  CLI registry (#58) already structures commands.

## What changes for whom

- **A project with patterns today:** each file must be renamed to its pattern's name. `pattern
  list` names every file that does not match and the name it should have, so the move is one
  `list` and a few renames. No other change.
- **MCP clients:** `pattern_list` returns the tier and shadowing too; `pattern_run` accepts
  `tier:name`. Both are additions.
- **The JSON output of `pattern list`:** each pattern gains `tier` and `shadows`. Additive.

## Order of work

1. Loader and resolver, project tier only, file name = name, parallel `list`. Measure again.
2. The user tier and `tier:name`.
3. `schemas/pattern.v1.json`, `pattern new`, `pattern check`, `pattern copy`.
4. The bundled tier and its generated index, with its first patterns.
5. The dashboard view.

Each step stands on its own and can ship as its own PR.

## Decisions for the maintainer

1. **Lockfile or not.** This proposal drops `patterns.lock.json` on the measurements above. Keep
   it only if it is wanted for something else (pinning a shared pattern set by checksum, say).
2. **File name = pattern name.** It makes `run` cost one read, and it means renaming existing
   pattern files once. The alternative keeps the full load on every `run`.
3. **Authoring from flags rather than from WQL**, as argued above.
4. **Whether to ship bundled patterns at all**, and which ones first.
