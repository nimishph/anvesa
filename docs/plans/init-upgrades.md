# Plan: re-running `init` to deliver what an upgrade brings

Applies to both `medha init` and `anvesa init`. The same file lives in both repositories; keep
them in step.

## Goal

After someone upgrades medha or anvesa, running `init` again in a project should be the one step
that brings the project up to what the new version offers: new generated guidance, newly
recommended setup, new integrations. It must be safe to run any number of times, never destroy
data, and never overwrite what a person wrote.

## Principles

1. **Idempotent.** A second run with nothing new to do changes no byte on disk and says so.
2. **Data is never touched by a re-run.** Only an explicit flag (`--recreate` in medha, `--force`
   in anvesa) replaces stores or user-edited files.
3. **Ownership is explicit.** A file is either the user's (created once, then kept) or generated
   (owned by the tool, refreshed freely). Mixed files, such as `AGENTS.md`, mark the tool-owned part
   with begin/end markers; everything outside the markers belongs to the user.
4. **Say what changed and why.** A re-run reports each step: `created`, `updated (was v0.7.1)`,
   `current`, `skipped (reason; how to do it later)`. `--json` carries the same, so hosts can act on it.
5. **Ask, don't switch.** A new recommendation (a better encoder, a new MCP client) is offered the
   way first-run setup offers it. A choice the user already made is never silently changed.
6. **Headless stays headless.** Off a terminal, a re-run does nothing that needs consent (no
   downloads) unless `--yes` is passed; medha's init stays fully non-interactive.

## Where things stand

| | anvesa | medha (TS CLI) | medha (Rust port) |
| --- | --- | --- | --- |
| Second `init` | Re-runnable: scaffold files kept, setup offers what is still missing | Was an error (`CLI_ALREADY_INITIALIZED`); **now a refresh** | Prints "already initialized", exit 0, does nothing |
| Agent section | **Added** | **Added** | Not yet |
| Knows the version it last ran | Only through the agent-section marker | Only through the agent-section marker | No |

## Phase 1 — the agent section (this change)

`init` keeps a short "how to use this tool" section in the project's agent instruction file:

- **Targets.** `--agents-file <path>` names the file (created if missing). Otherwise every existing
  `AGENTS.md` and `CLAUDE.md` at the project root, skipping a `CLAUDE.md` that is only
  `@AGENTS.md` (or is the same file through a symlink), so an agent never reads the section twice.
  With neither present, `AGENTS.md` is created. `--no-agents-file` writes nothing.
- **Markers.** `<!-- <tool>:begin v<version> — managed by \`<tool> init\`; … -->` and
  `<!-- <tool>:end -->`. The version in the begin marker is what lets a later run say
  `updated (was v0.6.0)`. Both tools use the same shape, so their sections coexist in one file.
- **Upsert.** Replace the marked block in place, or append it after a blank line. CRLF files stay
  CRLF. An unchanged block is not rewritten.
- **medha re-run.** With an existing `config.json` and no `--recreate`: store and config are left
  alone, preflight runs against them, generated project files (the agent section) are refreshed,
  and the report says `status: "existing"`. A drifting `--config` is still `CLI_REGISTRY_DRIFT`; a
  `--namespace`/`--no-namespace` on an initialized home asks for `--recreate` instead of being
  silently ignored. The `memory` backend writes no section (nothing persists).
- Code: `cli/src/agent-instructions.ts`, identical in both repos (keep in step), and the
  section text beside each `init`.

## Phase 2 — an init stamp

Record which version last ran `init` for the project, so a re-run (and other commands) can tell an
upgrade from a repeat.

- **Where.** A small generated file, `.anvesa/init.json` and `.medha/init.json`:
  `{ "version": "0.8.0", "steps": { "<step-id>": "<version that last ran it>" } }`.
  Separate from `config.json`, because anvesa's config schema is closed
  (`additionalProperties: false`) and medha's `config.json` is a strict, layout-versioned file whose
  keys are validated; neither should grow bookkeeping.
- **Committed.** It sits beside `config.json`, which is meant to be committed. A teammate on an
  older binary then gets a clear "this project was set up by anvesa 0.8.0; you have 0.7.1".
- **Missing stamp** means "before stamps existed": treat as version `0.0.0`, so every step that
  applies is considered.

## Phase 3 — upgrade steps

A registry of idempotent steps, each tagged with the version that introduced it:

```ts
interface InitStep {
  readonly id: string;            // stable, e.g. 'agent-section', 'mcp-claude-code'
  readonly since: string;         // first version that ships it
  readonly title: string;         // one line for "new in 0.8.0: …"
  readonly needsConsent: boolean; // downloads, editing files outside the tool's home
  run(ctx: StepContext): Promise<StepResult>; // must be safe to run when already done
}
```

`init` runs every step on a first run. On a re-run it runs every step (they are idempotent), and
headlines those whose `since` is newer than the stamp as **new in this version**. Consent-needing
steps follow the existing setup rules: ask on a terminal, `--yes` accepts, otherwise report how to
do it later. Results go into the report and the stamp is written last, only for steps that
succeeded.

Candidate steps, beyond the agent section:

- **anvesa:** offer parsers for languages that gained grammar support; offer a better default
  encoder when the recommendation table changes (offer only — the configured `model` stays); add new
  default ignore patterns to `.anvesaignore` inside a marked block; refresh the `mcp` client
  registration when the server's arguments change.
- **medha:** refresh `.medha/README.md` and `.medha/.gitignore` (generated files, see below);
  `mcp config` registration for clients that are configured but stale; a `config.json`
  `layoutVersion` migration, when one ships, as an explicit step that writes a backup first.

**Generated whole files** (`.medha/README.md`, `.medha/.gitignore`): write a content hash in a
header comment. On a re-run, replace the file only when its body still matches its hash (nobody
edited it); otherwise leave it, write the new version beside it as `<name>.new`, and report that.

## Phase 4 — nudges from other commands

`status`, `index`, `show`, `mcp serve` and friends compare the stamp with the running version. When
the binary is newer and there are unrun steps, print one line on stderr (never into `--json`
stdout, never on MCP stdio): `note: anvesa 0.8.0 has new setup for this project (agent section,
python parser); run \`anvesa init\``. When the stamp is newer than the binary, say so once.
`status --json` carries `{ initVersion, pendingSteps }` for hosts.

## Phase 5 — previews and parity

- `init --dry-run` lists what a re-run would change, writing nothing (anvesa already parses
  `--dry-run`).
- The medha Rust port mirrors the TS behaviour: refresh on an existing home, the agent section, the
  stamp. anvesa's Rust CLI has no `init`; nothing to do there until it grows one.
- The release checklist gains "does this release add an init step?" and the changelog groups such
  steps under **Run `init` again to get**.

## Testing

- Unit: upsert (append, replace, CRLF, user text above and below untouched, unchanged → no write),
  target selection (none, one, both, `@AGENTS.md` import, symlink, named path).
- CLI: first run, second run byte-identical, run over a fixture from an older version (old markers,
  old stamp) reports `updated (was v…)` and the new steps.
- medha: a re-run keeps every recorded episode; `--recreate` is still the only wipe.

## Open questions

1. Should `init` create `AGENTS.md` when neither file exists, or only report the suggestion? This
   change creates it; a project that dislikes it passes `--no-agents-file` (a future
   `agents: false` setting could make that sticky).
2. Should the stamp be committed (team-wide nudge) or ignored (per machine)? This plan says
   committed.
3. Should a nudge ever run steps automatically (for example the agent section, which needs no
   consent), or always wait for `init`? This plan says always wait.
