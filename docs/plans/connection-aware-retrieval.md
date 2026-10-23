---
id: plan/connection-aware-retrieval
status: draft
---

# Next steps: a faster encoder, a generation lab, and connection-aware retrieval

This round of brainstorming had three targets: lower indexing time, better encoding, better
relevancy. Two pieces of work came out of it, and both point to the same next step.

- **Distillation PoC** (`tooling/poc/distill/`, branch `poc/distill-encoder`). It distils
  jina-v2-code on WQL-path cards (commerce MRR 0.775) into an Ettin student small enough to index
  as fast as MiniLM (0.649). The pipeline runs locally and on Colab. The training run itself has
  not happened yet.
- **Generation lab** (`E:\AI projects\sutras\anvesa-gen-lab`, its own repository). It asks small
  local models (qwen2.5-coder 1.5B and 3B, through Ollama) 18 questions about ky, httpx and gin.
  Each question is graded against facts read off the code, under four context conditions with one
  12k-character budget.

What the lab showed:

| model | condition | facts correct | all facts | facts in context |
|---|---|---|---|---|
| 1.5B | none | 0.43 | 0.11 | — |
| 1.5B | grep | 0.60 | 0.39 | 0.79 |
| 1.5B | anvesa cards | 0.46 | 0.22 | 0.50 |
| 1.5B | anvesa hits → source | **0.78** | **0.56** | **0.89** |
| 3B | none | 0.49 | 0.22 | — |
| 3B | grep | 0.70 | 0.56 | 0.79 |
| 3B | anvesa cards | 0.53 | 0.28 | 0.50 |
| 3B | anvesa hits → source | **0.81** | **0.61** | **0.89** |

1. **anvesa is good at finding the place; the card is a poor thing to read.** Cards are summaries
   for embedding (name, path, doc, signature). The values a question asks about live in the
   source behind them.
2. **The answer is often one connection away from the best hit.** These are the misses that are left:
   - **ky:** the readme's `retry` section is split into parts. Search returned part 10, while
     part 1 holds the defaults (0.66 → 0.89 facts in context once the lab read the whole
     section).
   - **gin, unmatched routes** (0 in every condition):
     - Search ranks `TestNoRoute` and `TestMethodNotAllowedNoRoute` above the `NoRoute` method
       they test.
     - The answer is on two call lines of `handleHTTPRequest` (gin.go:782, :788), which calls
       `serveError(c, http.StatusNotFound, default404Body)`. The graph has that edge
       (`anvesa callers serveError`).
     - The constant itself sits in a Go `var ( … )` block and is not a symbol at all:
       `//*[@name="default404Body"]` matches nothing.

The retriever already holds the connections:
- `calls` and `calls:name` from the linker;
- `imports`, `references` and `references:type` from SCIP;
- the containment tree behind WQL;
- PageRank in `repomap.ts`.

One experiment already uses them for search: `experimental.propagate` (`retriever/src/experimental.ts`).
It mixes each symbol's vector with the mean of its neighbours' vectors, `unit(raw + alpha *
mean(neighbours))`, over configured edge kinds plus containment. Otherwise search ranks each
card on its own, and what it returns is the card, never what is connected to it. Closing that gap
is what this plan calls **connection-aware retrieval**.

## Track A: finish the distillation PoC

## Requirement: the student is trained and measured on commerce {#req-distill-run}

Run `distill.ipynb` on a Colab T4 with the bundle from `bundle.py`:
- Qwen2.5-Coder-3B queries, with the teacher round-trip filter (`--llm-top 10`).
- Three students: ettin-17m, ettin-32m, and ettin-32m with LoRA 16.

Report commerce MRR, val doc MRR and val LLM MRR against MiniLM 0.649, gte-small+WQL 0.700 and
jina+WQL 0.775.

Before the 20k-query run, check a sample of 50 of the 3B model's queries by eye. The 1.5B
generator's first queries mostly restated the symbol's name.

```yojana:claim
kind: text
expression: /quantize=False/ in tooling/poc/distill/train.py
```

## Requirement: speed is re-timed in fp32 {#req-distill-fp32-timing}

The speed gate measured int8, but students must ship fp32 (dynamic int8 took ettin-17m from 0.40
to 0.02 MRR).
- Re-time MiniLM, ettin-17m and ettin-32m in fp32 on the same 3,698 cards.
- Re-check granite-small-r2's zero-shot score, which was also int8.
- Add `--fp32` to `speed_gate.py`.

```yojana:claim
kind: text
expression: /--fp32/ in tooling/poc/distill/speed_gate.py
```

## Requirement: a student ships only if it clears the gate {#req-distill-gate}

To become a recommended model, a student must:
- score at least 0.70 commerce MRR (gte-small+WQL's score);
- index anvesa's own cards in no more than 1.25× MiniLM's fp32 time;
- not lower the lab's `anvesa-code` facts-in-context score below MiniLM's.

Otherwise it stays a PoC result, written up in `tooling/poc/distill/README.md`.

## Track B: make the lab a regression harness

## Requirement: enough questions to tell conditions apart {#req-lab-tasks}

18 questions is too few: one question moves a mean by 0.05. Grow the set to at least 60 over at
least 6 repos, including Rust and Java. Each new question:
- gets its facts read off the code at the pinned commit;
- comes with facts a wrong answer cannot match by accident;
- names its gold files.

Add question types beyond "what is the default", since connection-aware retrieval targets them:
- **flow:** "what happens when X fails";
- **where to change:** "where would I add a header to every retry";
- **who uses:** "which code paths call X".

## Requirement: the lab compares encoders as well as conditions {#req-lab-encoders}

`prepare.py --model` and `--wql` already re-index the repos. Run the grid for:
- MiniLM, with and without WQL-path cards;
- the distilled student, once it exists.

That makes the lab the downstream check for Track A, not just commerce MRR.

## Requirement: retrieval is measured without a model {#req-lab-retrieval-only}

`ctx_facts` (the share of facts present in the context) needs no LLM, and it is what most
retrieval changes should move.
- Add a `--retrieval-only` mode to `run.py`, so a ranking change can be checked in seconds before
  spending GPU time.
- Keep LLM runs for changes to how context is packed.

## Track C: fix what the lab exposed

## Requirement: documentation results carry their line span {#req-doc-lines}

Section cards record only `attrs.section` (`dense/src/transformers/docs.ts`). Give every doc card
the section's `startLine` and `endLine`, and give each part its own lines within them. A search
hit on part 10 then says where the section starts, and a client can read it all without
re-parsing headings the way the lab does.

```yojana:claim
kind: text
expression: /startLine/ in dense/src/transformers/docs.ts
```

## Requirement: search can return source, not only cards {#req-search-source}

Make the lab's `anvesa-code` condition a first-class output, so every agent and plugin gets it
without re-implementing it:
- `search --source`, and the same option on the MCP tool;
- code hits return `line..endLine` of source, with a few lines before;
- doc hits return their whole section;
- an overall `--budget` in characters or tokens is filled in rank order.

## Requirement: Go package-level variables are symbols {#req-go-var-blocks}

`structural/src/mappings/go.json` maps `const_spec` but has no `var_spec`, so no Go `var` is a
symbol. gin's `default404Body` (in a `var ( … )` block in gin.go) has no card and cannot be found.
- Map `var_spec` to `variable`, with its identifier as the name, inside blocks as well.
- Check the other mappings for the same gap with module-level values: Python, Rust `static`, and
  Java fields.

```yojana:claim
kind: text
expression: /"var_spec"/ in structural/src/mappings/go.json
```

## Track D: connection-aware retrieval (brainstorm)

The premise: a question is answered by a small connected piece of the code, not by one card. The
best-ranked card is usually inside that piece, but the answer-bearing lines are often one edge
away: the call site, the constant it reads, the part 1 of its section, the code a test exercises.
Retrieval that knows the connections can reach those lines.

### The connections anvesa has, or could have

| connection | source today | confidence |
|---|---|---|
| containment: a symbol's parent, children and siblings | the W-expression tree (WQL) | exact |
| parts of one card group (section part 1…n, symbol parts) | `cardId` `~n`, `collapse` groups | exact |
| calls, resolved | linker, through scope and imports | exact or inferred |
| calls, by name | linker | a guess |
| imports and re-exports | linker | exact |
| references to values and types | SCIP ingestion | exact |
| test → the code it exercises | `calls` out of a test file | derived |
| doc → code: a section names an identifier | not yet: match `` `code` `` spans and headings to symbols | heuristic |
| co-change: files changed in the same commits | not yet: git history | statistical |
| cross-repo | federation plus SCIP symbols | exact where SCIP exists |

### Ideas, cheapest first

**D0. Measure what exists: `experimental.propagate`.** It needs only a config change, so measure it
before building anything:
- run commerce and the lab's retrieval-only mode at a few `alpha` values (0.1, 0.25, 0.5);
- try `calls` alone, then with `references` (where SCIP is ingested).

It works at embedding level, so it can lift a card that sits next to relevant ones. It cannot put
the neighbour's lines into the context, which is where D1 and D2 come in. Its result is also the
first evidence for D6.

**D1. Sibling parts.** When a hit is part *n* of a group, pull in part 1 (or the whole group,
within budget). This is exactly the ky miss. It needs no new data, only `collapse` groups at
packing time.

**D2. Connection-aware context packing.** Ranking is unchanged; what is sent changes. For each
top hit, spend part of the budget on its one-hop neighbourhood:
- the definitions of the constants and fields it references (`references`, or identifiers
  resolved in scope);
- for a function hit, its callers' call lines with ±3 lines (`CallerRef.callLines` already
  exists);
- its callees' signatures, without their bodies.

This is the gin miss: a `serveError` hit brings lines 782 and 788, which name `default404Body`.
It can be measured directly as a new lab condition, `anvesa-graph`.

**D3. Test → subject redirect.** When a test ranks high, it is evidence about the code it calls.
Follow `calls` out of the test to symbols in non-test files, and promote them just above the
test. Keep the test as supporting context instead of the answer. gin's `TestNoRoute` →
`NoRoute`, `handleHTTPRequest`.

**D4. A graph lane in the fusion.** Add a lane whose ranking is graph proximity to the other
lanes' top k. Score each node by the edges into it from seeds, weighted by:
- the seed's fused score;
- the edge's confidence (`calls` above `calls:name`);
- the node's inverse degree, so `Logger` and `utils` do not win by being everywhere.

It fuses through RRF like any other lane, with a weight (`--weight graph=<n>`, `--exclude
graph`). It brings in what no text lane ranked but several hits point at.

**D5. Personalised PageRank from the seeds.** D4 taken further: run `repomap.ts`'s PageRank
personalised to the seed hits, for 2–3 hops with damping. It finds the centre of the region the
hits fall in, for example the function the hits all call. It is more expensive and harder to
explain than D4. Try it only if D4 shows the effect is real.

**D6. Connection-enriched cards** (index time). `propagate` (D0) mixes neighbours into the vector;
this puts them into the text instead. Add a neighbourhood line to each symbol card,
such as `called by handleHTTPRequest; calls serveError; reads default404Body`, so the embedding
itself knows the connections. Costs:
- a card changes when a neighbour does (the linker already knows which files to re-link);
- the extra line dilutes short cards.

This is also a distillation question: the teacher and the student can be trained on enriched
cards. Do this one last, after D2–D4 show which connections carry signal.

**D7. Neighbourhood units.** Retrieve a small subgraph as one unit (a function, the constants it
reads, its direct callers' call lines), the way a card group is one unit today. Fusion then ranks
units, not cards. This is the end state D2 approximates at packing time.

**D8. Intent routing.** Some questions are graph questions in disguise:
- "who calls", "what uses", "what breaks if" are a walk over callers and dependents;
- "what is the default" points at constants and config objects;
- "what happens when X fails" points at error paths and the `catch` and `if err` branches under X.

Detect the form cheaply (patterns, or a tiny classifier) and choose an expansion, or a WQL
conjunction (`search … where //function`), rather than one ranking for all questions.

**D9. Doc ↔ code links.** Link a doc section to the symbols it names in backticks or headings,
and a symbol back to the sections that name it. A doc hit then brings the defining code; a code
hit brings the section that documents its defaults (ky's readme lists them more plainly than
normalize.ts).

### Risks to design around

- **Hubs.** Unweighted expansion pulls in `Logger`, `utils` and error types for every question.
  Weight by inverse degree, and cap expansion per hit.
- **Guessed edges.** `calls:name` is a guess. Down-weight it, and never let it alone introduce a
  file that no lane ranked.
- **Budget.** Expansion competes with the next-ranked hit for context. Compare at a fixed budget,
  always (the lab already does).
- **Latency.** Graph lookups are SQLite reads and should be cheap, but D5 is iterative. Search is
  0.8s today; budget no more than +150 ms for D2–D4.
- **Evaluation leakage.** Lab questions were written knowing where answers live. Add new questions
  blind, before trying a connection idea on them.

## Requirement: the existing propagation experiment is measured {#req-propagate-measured}

Before any new connection work, measure `experimental.propagate` (D0):
- on commerce MRR and the lab's facts in context;
- at `alpha` 0.1, 0.25 and 0.5;
- with `calls` alone, and with `calls` plus `references` where a SCIP index is ingested.

Record the numbers in this plan. They decide whether D6 is worth its index-format cost.

## Requirement: D1 and D2 are tried in the lab first {#req-graph-packing}

Add an `anvesa-graph` lab condition with sibling parts (D1) and one-hop packing (D2), using
`anvesa callers`, `callees` and `neighbors` at first, so nothing in anvesa changes until it shows
a gain. It must:
- beat `anvesa-code` on facts in context at the same budget;
- reach `gin-not-found`;
- not lose on any question `anvesa-code` already answers.

If it does, move it into `search --source` (#req-search-source).

## Requirement: D3 and D4 are measured on commerce and the lab {#req-graph-ranking}

Ranking changes are measured on both commerce MRR (43 queries) and the lab's facts in context.
Implement test → subject (D3) and the graph lane (D4) behind an `experimental` flag, the way
`cardPath` is. Keep one only if it improves both without slowing search by more than 150 ms.

```yojana:claim
kind: text
expression: /graphLane/ in retriever/src/config.ts
```

## Requirement: D6 waits for evidence {#req-enriched-cards}

Connection-enriched cards change the index format and the distillation corpus. Start only after
#req-propagate-measured, #req-graph-packing and #req-graph-ranking show which edge kinds carry
signal. Then:
- export enriched cards with `export_cards.py`;
- re-train the student on them;
- compare on commerce and the lab.

## Track E: a learned ranker, fed and governed by medha

Gen-lab results (MiniLM, 241 queries, 8 repos; first stage = card + intent cards at weight 0.5, no path
line, hub 0.3, MRR 0.566). Each reorders the first stage's top 30:

| Reorders the top 30 | MRR | vs first stage | CPU cost per query |
| --- | --- | --- | --- |
| Small cross-encoders (MiniLM-L6/L12, mxbai-xsmall, bge-base) | 0.51–0.52 | −0.04 to −0.06 | 0.8–3 s |
| mxbai-rerank-base-v2 | 0.615 | +0.049 | ~42 s (1 thread) |
| Qwen3-Reranker-0.6B | 0.658 | +0.092 | ~46 s (1 thread) |
| **XGBoost over cheap features** (ltr.py) | **0.613** | **+0.047** | **< 1 ms** |
| XGBoost + Qwen3 score as a feature | 0.678 | +0.112 | as Qwen3 |

The tree ranker matches the best affordable cross-encoder at almost no cost. Its weak point is
data: it trains on the 241 bench queries. Medha already records what happened to the things an
agent uses, so it can supply real labels (E2) and decide which ranker to trust (E3).

## Requirement: a tree ranker reorders the top results, behind a flag {#req-ltr-ranker}

Port ltr.py's features and an exported XGBoost model to the retriever, behind an `experimental`
flag the way `cardPath` is:
- The features are computed in TypeScript from what search already has: first-stage scores,
  BM25 on card and intent text, name, path and kind, same-file count and call degree.
- The trees are evaluated in plain TypeScript from the exported JSON, with no ONNX runtime.
- It ships only if it improves gen-lab MRR and commerce MRR, and adds no more than 5 ms.
- `--explain` names the features that moved a hit.

```yojana:claim
kind: text
expression: /learnedRanker/ in retriever/src/config.ts
```

## Requirement: anvesa records what happened to its results, in medha {#req-ltr-episodes}

After a search, record a medha episode for each shown hit an agent acted on:
- **applied:** the agent opened or edited it;
- **skipped:** a hit ranked above an applied one that it passed over;
- nothing for hits below the last one used, which are unknown rather than negative.

The episode carries the query, the ranker version, each hit's rank and its feature vector, so a
ranker can be retrained without re-running search. Episodes stay in the local medha log; they leave
the machine only through medha's own sync, which is opt-in.

## Requirement: the ranker retrains from usage {#req-ltr-from-usage}

`anvesa rank train` fits a new ranker from medha episodes, with the bench queries as a floor:
- Use only queries with at least one applied hit.
- Weight each label by medha's Wilson lower bound, so a pattern seen twice counts for less than one
  seen two hundred times.
- Report the new ranker on the bench before it is used, next to the current one.

## Requirement: medha decides which ranker is trusted {#req-ltr-governed}

Each trained ranker is a medha entity:
- It starts on **probation** and is used on a share of searches.
- Its guard: bench MRR no lower than the current ranker's, and an applied rate in live use at
  least as high, by Wilson lower bound.
- It becomes **trusted** (the default) only after the guard passes.
- If it starts losing, it is **quarantined** and search falls back to the previous trusted ranker,
  or to the first stage.

`medha show` explains why a ranker is where it is.

## Order

1. **Now, no GPU:**
   - #req-doc-lines, #req-go-var-blocks: small product fixes.
   - #req-lab-retrieval-only, then #req-propagate-measured (config only).
   - #req-graph-packing (D1 and D2 in the lab).
2. **In parallel, on Colab:** #req-distill-run, then #req-distill-fp32-timing and #req-distill-gate.
3. **Next:**
   - #req-lab-tasks: blind questions first, then flow, where-to-change and who-uses questions.
   - #req-search-source.
   - #req-graph-ranking.
   - #req-ltr-ranker, then #req-ltr-episodes (both are useful alone).
4. **After episodes accumulate:** #req-ltr-from-usage, then #req-ltr-governed.
5. **Later:** #req-lab-encoders with the student; #req-enriched-cards.
