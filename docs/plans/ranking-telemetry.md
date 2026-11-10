---
id: plan/ranking-telemetry
status: draft
---

# Telemetry for two-stage symbol search

Symbol search runs in two stages: every symbol card scored by cosine less a hub penalty, then the top
30 reordered by the learned ranker that came with the encoder. Only the second stage is shown
(`retriever/src/learned-ranker.ts`, `docs/learned-ranker.md`). Both stages are already recorded for
every search and handed to `RetrieverOptions.onRanking`, with the hub step's card count and time
after each index run. Nothing sends them anywhere yet: the telemetry subsystem is still open
(nimishph/anvesa#35).

This plan uses that data to answer two questions that are open today:

1. **Does the second stage earn its place in real use?** It was measured on generated queries
   (+0.02 MRR on every size) and on 241 hand-written ones (within noise). Real queries are neither.
2. **When does the hub step cost too much?** It is exact on every repository and quadratic in the
   symbol cards of each model. A 1,631-card repository is cheap; a 50,000-card monorepo may not be.
   Whether large repositories need an approximate hub step should be decided from measurements, not
   guessed.

Telemetry keeps #35's guarantees: no file paths, code, query text or symbol names. What leaves the
machine is `summarizeStages` of a search, and counts and times in buckets.

## Requirement: both stages are recorded for every symbol search {#req-stages-recorded}

Every symbol search on one index database records the first stage's top `depth` with their scores,
the ranker's order of them (when there is a ranker), and how long each stage took, and passes them to
`onRanking`. The user sees only the second stage's order.

```yojana:claim
kind: text
expression: /this\.#tell\(\{ kind: 'search'/ in retriever/src/retriever.ts
```

```yojana:claim
kind: text
expression: export function summarizeStages in retriever/src/learned-ranker.ts
```

## Requirement: the hub step reports what it measured and what it cost {#req-hub-cost-recorded}

Each index run that measures the hub means again reports how many symbol cards it measured, the time
spent on the hub means alone, and the time for the whole update (`HubReport`).

```yojana:claim
kind: text
expression: export interface HubReport in retriever/src/learned-ranker.ts
```

## Requirement: telemetry carries the stage summary of each search {#req-telemetry-search-stages}

Once #35 is merged, the CLI and MCP server give `onRanking` a function that records, for each
`search` event, `summarizeStages` of it: whether the ranker ran, whether it changed the top result,
where the result shown first stood in the first stage, the overlap of the two top 10s, and each
stage's time in `durationBucket`s. Nothing else from the event leaves the machine; a test checks that
no symbol, path or query text is in what is sent.

```yojana:claim
kind: text
expression: summarizeStages in cli/src/**/*.ts
```

## Requirement: telemetry carries the hub step's cost {#req-telemetry-hub-cost}

For each `index` event, telemetry records the symbol card count (`countBucket`, with buckets that go
past 100,000 cards) and the hub step's time (`durationBucket`, with buckets that go past a minute).
The buckets reach `100000+` cards and `120000+` ms (#35), far enough to show where the quadratic step
starts to hurt.

```yojana:claim
kind: text
expression: hubMs in cli/src/**/*.ts
```

## Requirement: a decision on the hub step for large repositories {#req-hub-decision}

After at least four weeks of telemetry from at least 50 distinct sessions that indexed over 20,000
symbol cards, decide between:

- **keep it exact** everywhere, if the hub step stays under 10% of index time at p95;
- **an approximate hub step** (nearest neighbours from a sample or an index) above a card count read
  from the data, if it does not; checked against the exact one on the bench (MRR within 0.005) before
  it ships.

The decision, its numbers and the threshold (if any) are written into this plan.

## Requirement: a decision on the second stage from real use {#req-ranker-decision}

From the same telemetry, report how often the ranker changes the top result, and how far the result
shown first moves. If the medha episodes of connection-aware retrieval (#req-ltr-episodes in
`plan/connection-aware-retrieval`) are in place by then, compare how often a shown top result is
acted on with and without a reordered top. The second stage stays the default unless this shows it
doing harm.
