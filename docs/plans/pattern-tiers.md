---
id: plan/pattern-tiers
status: draft
---

# Patterns in tiers, found by file name

Builds the design in `docs/design/patterns.md`. Each requirement is one step of its "Order of
work" and can ship as its own PR.

## Requirement: a loader and a resolver; the file name is the pattern's name {#req-pattern-loader}

`retriever/src/patterns/loader.ts` reads one tier's folder: one named file for `run`, or every
file in parallel for `list`, and checks each against its file name. `retriever/src/patterns/resolver.ts`
holds the loaders in tier order and is the only place that knows which tier wins.
`PatternRunner` keeps `run` and no longer reads files. A file whose `name` is not its file name is
listed as invalid with the name it should have.

```yojana:claim
kind: path
expression: retriever/src/patterns/loader.ts
```

```yojana:claim
kind: path
expression: retriever/src/patterns/resolver.ts
```

```yojana:claim
kind: text
expression: /readdirSync|readFile\(/ in retriever/src/pattern-runner.ts
expect: false
```

## Requirement: the user tier, and tier:name {#req-pattern-user-tier}

`~/.anvesa/patterns/<name>.json` is read after the project's. `pattern list` shows each pattern's
tier and what it shadows; `pattern run user:<name>` reaches past a project pattern.

```yojana:claim
kind: text
expression: /shadows/ in retriever/src/patterns/resolver.ts
```

## Requirement: a schema, and new, check and copy {#req-pattern-workflow}

`schemas/pattern.v1.json` describes a pattern file. `pattern new` scaffolds one from flags and
prints its WQL, `pattern check` runs it and reports the WQL, the hit count and the diagnostic, and
`pattern copy` moves one between tiers.

```yojana:claim
kind: path
expression: schemas/pattern.v1.json
```

```yojana:claim
kind: text
expression: /async check\(/ in retriever/src/pattern-runner.ts
```

## Requirement: bundled patterns {#req-pattern-bundled}

`retriever/patterns/*.json`, imported by a generated index that a test compares to the folder, is
the last tier.

```yojana:claim
kind: path
expression: retriever/patterns
```

## Requirement: a patterns view in the dashboard {#req-pattern-dashboard}

A read-only list (name, tier, description, shadowing) and a box to run one.

```yojana:claim
kind: text
expression: api/patterns in ui/src/server.ts
```
