# Command audit (0.8.0-alpha.3 → Wave C)

Every command `anvesa --help` lists, checked against the code, the primer (`anvesa primer`), the
agent skill (`skills/anvesa/SKILL.md`) and the MCP server. Done for
[plan/cli-polish-and-open-issues](plans/cli-polish-and-open-issues.md), requirement
`req-command-audit`, on 2026-11-13.

## How it was checked

- **Documented examples, run.** Every `anvesa …` line in the skill and the primer (67 at the start)
  was run against an indexed scratch project: 21 files of `retriever/src`, a Laravel routes file and
  the README, embedded with gte-modernbert-base. Placeholders were filled with names that exist.
- **WQL, parsed and run.** Every WQL fragment the two guides show (25) was run with `anvesa query`.
- **MCP, compared.** The parameters of every tool `createMcpServer` registers were compared with the
  skill's MCP section.
- **Guarded now.** `cli/src/docs-drift.test.ts` repeats the last three checks on every test run,
  over the primer, the skill and the README: every command named, every `anvesa <command>` real,
  every WQL example parsing with real attributes, every MCP tool documented with its parameters.

## What the guides got wrong (before)

| Where | Documented | Reality | Now |
| --- | --- | --- | --- |
| primer, skill | `@name=~"…"` | only `~=` parsed | `=~` is accepted as the same operator |
| primer | `//class/method` | only `>` was a child axis | `/` is accepted as the child axis |
| primer | `@visibility="public"` | no such attribute | removed; the attribute list is in both guides |
| skill | `@export`, `@async`, `@deprecated` | no such attributes | replaced with a real example |
| (#49) | `[@kind="function"]` | `@kind` is the grammar node type | explained in both guides |
| skill | `pattern run <name> [--param=val]` | `key=value` | fixed |
| skill (MCP) | `diagnose { query, expect }` | `{ query, path, depth? }` | fixed |
| skill (MCP) | `pattern_run { name, params? }` | `{ name, args?, limit?, cursor? }` | fixed |
| skill (MCP) | 12 tools | 18 (`status`, `index`, `primer`, `show_in_ui`, `retrieve_<channel>` missing) | all 18, with all parameters |
| primer | "settle cleans up after file moves" | settle acts on manifest changes; moves are `index`'s | fixed |
| primer | C# "none: train one" | C# mapping is bundled | fixed |
| primer | lanes "MiniLM, BGE" | anvesa-code models | fixed |
| MCP `primer` tool | topic list hard-coded (6) | 11 topics | derived from the primer |
| (#51) | `workspace.json` federation format | not documented anywhere | `anvesa primer federation`, skill §11 |

After the fixes, 89 documented examples run. 70 succeed. The other 19 fail only because of the
scratch project: it has no patterns, no Python samples and no federation, or the example is a
heading (`anvesa fragments`) or names a model that is not installed, where the error is the
intended one.

## Per command

Primer and Skill say whether the guide names the command; MCP names the tool when there is one.

| Command | Primer | Skill | MCP | Gaps found | Status |
| --- | --- | --- | --- | --- | --- |
| `init` | overview | — | — | an existing config never got `$schema` | fixed (Wave A) |
| `status` | overview | — | `status` | — | ok |
| `ui` | overview | — | `show_in_ui` | plain-language search fell back to demo data (#47); snippets showed markup (#48); no settings view | #47, #48 fixed (Wave A); settings: Wave D |
| `where` | overview | — | — | — | ok |
| `index` | indexing | §1 | `index` | no progress per shard on a sharded project (#26.4) | open |
| `fragments` | indexing | — | — | `disable` left `shards/` behind; settle's purpose misdocumented; `clusters` tier over-splits small repos | disable and docs fixed; over-split open |
| `federation` | federation | §11 | — | format undocumented; scores lost; unknown `--repo` silent | fixed |
| `search` | overview, fusion | §2, §4 | `search` | `--federated` results showed ~0.02 scores | fixed. `--scope` already filters by path (#26.5); a fragment filter does not exist |
| `retrieve` | overview | §9 | `retrieve_<channel>` | `--federated` failed on a remote-only channel | refused with a clear error |
| `query` | wql | §3 | `query` | doc forms rejected (#49); no freshness warning; `--limit -1` read as an unknown option; `--federated` ignored | fixed |
| `diagnose` | grammars | §7 | `diagnose` | MCP parameter misnamed in the skill | fixed |
| `pattern` | patterns | §9 | `pattern_list`, `pattern_run` | parameters not escaped; no description accepted; duplicates; unknown args ignored; empty-list error read "expected one of ," | fixed (Wave A, Wave C) |
| `callers`/`callees`/`neighbors` | graph | §5 | yes | ambiguous names list candidates (works as documented) | ok |
| `dependents` | graph | §5 | `dependents` | — | ok |
| `explain` | graph | §7 | `explain` | — | ok |
| `map` | graph | §5 | `repomap` | `--budget` ignored; missing dir gave "0 files"; `--depth` counted from root | fixed |
| `routes` | graph | §6 | `routes` | Laravel group prefixes dropped (#46) | fixed (Wave A) |
| `channel` | channels | §9 | — | built-ins could be shadowed or removed; unknown remove succeeded; module edits needed a version bump (#50) | fixed |
| `grammar` | grammars | — | — | — | ok |
| `mapping` | grammars | §8 | — | — | ok |
| `model` | models | §10 | — | no `use`; open models not listed | fixed (Wave B) |
| `redteam` | grammars | — | — | — | ok |
| `primer` | (itself) | §12 | `primer` | 6 topics; most commands had none | 11 topics |
| `telemetry` | telemetry | — | — | notice shown once only | Wave D |
| `issue` | grammars | §7 | — | — | ok |
| `mcp serve` | overview | MCP section | — | — | ok |

## Not fixed in Wave C

- **Unreadable `.git` crashes with EACCES (#51).** Not reproduced. Every read under `.git` found is
  already guarded. Windows has no `chmod 000`, and WSL here runs the Windows `bun`. It needs a
  Linux or macOS run to find the failing call.
- **`fragments propose --tier clusters` over-splits small repositories (#51).** It needs a minimum
  fragment size, and choosing one is a design decision. It only matters past the 500 MB threshold
  the docs give.
- **Per-shard index progress (#26.4).**
- **MCP `search` has no federation parameters.** Federated search is CLI-only.
