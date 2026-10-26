---
id: plan/query-optimizer
status: draft
---

# A query optimizer: from what a developer types to WQL ∧ natural language

Today a conjunction (`retriever/src/conjunction.ts`) only exists when the user writes it:
`'save user && //function'`, `'… where //class//method'`. The idea here is that anvesa writes it
for them. It would split the query into a structural part (a WQL path, a `--scope`, a graph
expansion) and a natural-language part for the dense lane, so that the right symbol reaches the
candidate list more often (recall@10/30) at no cost to precision.

This plan is mostly a **hypothesis to test**. Nothing gets built until the hypothesis holds. The
first requirements measure it, and later ones only proceed when the measurements pass.

## The hypothesis, split into parts that can each fail

"A query decomposed into WQL ∧ NL retrieves better" is really four claims. Each needs its own
test, and each has its own kill criterion.

| | claim | test | it fails if |
|---|---|---|---|
| **H1 headroom** | a *correct* structural constraint lifts recall@10/30 and MRR | oracle constraints: simulated from gold, then hand-written WQL run through anvesa (#req-qopt-oracle) | the hand-written WQL oracle gains < +0.02 R@10 over the first stage |
| **H2 predictability** | the constraint can be obtained at query time, from the query, the index or the user, accurately enough | per-predictor accuracy against the break-even curve (#req-qopt-break-even) | no predictor clears break-even on the queries it fires on |
| **H3 safety** | a wrong or empty constraint costs (almost) nothing | count of queries whose gold leaves the top 10/30, wrong-constraint control | any variant pushes gold out of the top 30 on > 1% of bench queries |
| **H4 cost** | the optimizer fits interactive search on a laptop CPU | p50/p95 added latency on the lab repos | > 30 ms p95 for the default path |

Two controls separate "the conjunction helps" from "more information helps":

- **Same hint, as text.** Append the extracted hint to the NL query instead (`… method`,
  `… in storage/`). If that gains as much, the conjunction machinery is not what helps.
- **Same hint, as a ranker feature.** Give "matches rewrite *i*" to the XGBoost ranker
  (`ltr.py`) instead of filtering. A soft, learned use of the same signal is the strongest
  alternative to a hard WQL filter.

Two negative controls bound the cost:

- **A wrong constraint of the same selectivity.** A random other kind, or a random other
  directory with a similar share of cards. It measures what a confident mistake costs.
- **Abstain.** The optimizer leaves the query untouched. Any variant must beat this on the
  queries it changes, not just on average.

## What was measured already (2026-10-26, no inference)

Everything below ran in the gen-lab on the **stored** ettin-1b-full vectors
(`Encoder("stored:ettin-1b-full")`, card only, hub 0.3, no path line). That reproduces the logged
run exactly: MRR 0.672, R@10 0.900, R@30 0.979 on the 241 queries. Only numpy reordering ran on
top of it; there was no embedding and no model inference. The scripts are `qopt_sim.py`,
`qopt_prf.py` and `qopt_noise.py` in the session notes folder `query-optimizer-sims/`. #req-qopt-oracle
moves them into the lab.

**Oracle headroom (H1, simulated).** Each variant puts the cards that satisfy the gold's own
kind / directory / file first and keeps the rest after, so nothing is dropped:

| constraint (from gold) | MRR | R@10 | R@30 | median share of cards kept |
|---|---|---|---|---|
| none (first stage) | 0.672 | 0.900 | 0.979 | 1.00 |
| kind (`//method`, `//class`, …) | 0.719 | 0.950 | 0.992 | 0.67 |
| directory (`--scope`) | 0.726 | 0.959 | 0.988 | 0.18 |
| kind + directory | 0.779 | 0.983 | 0.996 | — |
| file | 0.821 | 1.000 | 1.000 | — |

Kind alone and directory alone each improved 54 queries, made none worse, and moved 12 and 14
queries into the top 10. So the headroom is real and large, comparable to the whole
ranker-plus-intent-cards stack (0.663 → 0.705).

**But the bench queries almost never state the structure.** They were written as natural
language, as tasks, behaviours and symptoms:

- 5 of 241 queries carry an identifier-like token (`GraphQL`, `baseUrl`, `NaN`, `host`).
  Boosting symbols whose name contains it changed nothing, because those queries were already
  answered.
- 21 queries contain a kind word, and only 6 of those match the gold's kind. The rest are English:
  "decode into a **struct**", "raise my own exception **type**", "a non-standard http **method**",
  "build a schema **class** at runtime" (gold is a function). Trusting these words as filters
  dropped MRR to 0.639 overall, and on those 21 queries from 0.587 to 0.216 (12 fell out of the
  top 10).
- 16 queries match a relation word, and every one is a false positive ("**use** gson", "every
  **call** of a method"). The bench has no who-calls / who-uses questions.

**Inferring structure from the first stage's own top hits does not work either.** A majority vote
of the top 5/10's kind, directory or file, used to reorder the top 30, scored MRR 0.55–0.65 in
every setting. Even with a 60% agreement threshold it did not beat 0.672. The constraint has to
come from information the dense ranking does not already have.

**Break-even accuracy (H2).** In this curve the oracle constraint is replaced by a wrong one with
probability *p*:

| applied as | kind: MRR at p = 0 / .1 / .2 / .3 | dir: MRR at p = 0 / .1 / .2 / .3 |
|---|---|---|
| matches first, whole list | .719 / .649 / .578 / .516 | .726 / .653 / .582 / .519 |
| matches first, top 30 only | .718 / .677 / .639 / .601 | .724 / .697 / .673 / .652 |

As a filter over the whole list, a predictor must be right about **93%** of the time on the
queries it fires on just to break even on MRR. Reordering only inside the top 30 relaxes that to
~89% for kind and ~80% for directory, and R@10 holds up to p ≈ 0.3. These are the bars any
rewriter in this plan must clear. They argue for soft use and abstention by default.

### What this means for the design

1. The optimizer's value is on **queries that carry structure**. The bench has almost none of
   those, and real developer queries often do (`where is UserRepo.save`, `tests for
   parseConfig`, `who calls serveError`, `handler for POST /cart`). The plan needs a second query
   set phrased that way (#req-qopt-dev-queries). Otherwise it measures the optimizer on queries
   it should leave alone.
2. On pure-NL queries the right move is **abstain**. Explicit-cue rules must be neutral on the
   current bench, and that is a test.
3. A constraint must be **soft or confined to the top k** unless its source is near-certain (the
   user typed `//class`, or an identifier names exactly one symbol in the index).

## What the optimizer could extract

Examples are from the bench, or rephrased from bench gold the way a developer would type them.

| signal | surface cue | becomes | bench example | trust |
|---|---|---|---|---|
| **identifier** | camelCase, snake_case, `Foo.bar`, backticks, `bar()` | `//*[@name="X"]`, or `[contains(@name,"x")]` for fragments | `retrofit-base-url-slash` names `baseUrl`; rephrased: "`SetEnvPrefix` with an empty prefix" | high, **if the index has a symbol by that name** (check the symbol table before using it) |
| **kind** | "the class that…", "method on …", "function to…" | `//class`, `//class//method`, `//function` | `flysystem-read-only` (gold a class), rephrased "the adapter class that throws on every write" | low in NL (6/21 right); high when the kind word is followed by a name ("class Foo") |
| **test intent** | "test for X", "spec of X" | constrain to test paths (`--scope` the test dirs), or exclude them when there is no test word | the gin `NoRoute` miss: `TestNoRoute` outranks `NoRoute` | high, symmetric: no "test" word → down-weight test files |
| **route** | "handler for GET /x", an HTTP verb + path | `anvesa routes` lookup, then that symbol | commerce route handlers (`app/**/route.ts`) | high when a route table exists |
| **path / module** | a word that names a directory or file **in this index** ("in the ftp adapter", "storage drivers") | `--scope <dir>`, or `[contains(@path,"ftp")]` | `flysystem-ftp-reconnect`, `unstorage-mount` (oracle dir: 20 → 6) | medium; must match the index's path vocabulary, never a guessed path |
| **container** | "X on Y", "Y's X" | `//*[@name="Y"]//method` | "`validate` on `Schema`" | medium |
| **relation** | "who calls X", "what uses Y", "implementations of Z", "subclasses of" | `callers` / `callees` / `dependents` / SCIP `references:type`, then seed graph expansion (plan/connection-aware-retrieval, track D) | none in the bench; needs who-uses questions (#req-lab-tasks) | high when X resolves to a symbol |
| **language / framework** | "in the Go code", "the Rust side", "Django view" | include-by-extension; framework → route table or naming conventions | federation/multi-language repos | medium |
| **what stays NL** | the behaviour: "throws on every write", "reconnect when dropped", "trailing characters after a value" | the dense lane's query (and BM25) | most of the 241 | — |

Extraction removes the structural words from the NL part only when they are pure syntax ("the
class that" → dropped). Content words stay ("adapter", "ftp"), because the dense lane uses them
too. Removing words would be an ablation.

## How to combine the parts

| mode | what it does | when | recall risk |
|---|---|---|---|
| **hard filter** (today's conjunction) | dense results kept only if they match the WQL, after a fetch of `max(10·depth, 500)` | the user wrote the WQL; an identifier that resolves to exactly one symbol | high: a wrong guess removes the gold |
| **pre-filter in the scan** | the WQL match set becomes the dense store's card filter (`cardFilter`), so the best *matching* cards are kept, not the best 500 then filtered | hard mode, large repos (retrofit: 3,476 cards) | same as hard, but no loss from the fetch cut |
| **soft boost** | matching cards get +w on the fused score; nothing is removed | default for predicted constraints | low; w tuned by leave-one-repo-out |
| **confined reorder** | matches first, only within the top k (30) | when the predictor's confidence is high | bounded: gold beyond k is untouched, and R@30 cannot drop |
| **multiple rewrites, fused** | run the literal query plus 1–3 rewrites and fuse them with RRF; the literal list is always one input | a tagger or LLM with uncertain output | low; costs one extra structural run per rewrite, and the dense query is shared |
| **as ranker features** | "matches rewrite *i*", "constraint source", "predictor confidence" go to the XGBoost ranker over the top 30 | once #req-ltr-ranker ships | lowest; learns how much to trust each source |

**Fallback rules (H3):**
- WQL that fails to parse, or matches nothing, is dropped silently and the query runs as typed.
- A WQL that matches more than ~60% of cards is not worth applying, so it is dropped too.
- A hard constraint whose match set has no overlap with the literal query's top 30 is demoted to soft.
- The literal query is always in the fused set.
- The rewrite is printed (`searched as: …`), and a flag turns it off.

## Ways to build the rewriter, cheapest first

| # | builder | query-time cost on a laptop CPU | training data | expected reach |
|---|---|---|---|---|
| B1 | **rules + index vocabulary**: regex for identifiers, backticks, `X.y`, "test for", HTTP verb + path, "class/method/function `<Name>`"; a cue counts only if it resolves in the index (symbol table, directory names, route table) | < 1 ms plus one symbol-table lookup | none; a hand-written cue list | explicit-cue queries only; must be neutral on the NL bench |
| B2 | **index-grounded lexical matcher**: BM25 / trigram over symbol names and path segments, so "ftp adapter" → `src/Ftp/` | ~1–5 ms | none | path and fragment hints that rules miss |
| B3 | **a small probability-emitting network** (the preferred builder, #req-qopt-tagger): a gate p(decomposable) that decides "pure NL, leave it alone" vs "decomposable", plus heads for what to extract (kind, identifier spans, relation, area). Calibrated, so each probability maps onto the break-even curve. Runs in-process (ONNX), so the query never leaves the machine | < 1 ms on its own; ~0 extra if it reads the query embedding the dense lane already computes | synthetic positives (structure injected into NL queries and intent texts), hard negatives (English kind words), the dev query set; trained on Colab | the gate also governs B1/B2: rules propose, the gate decides. Must clear ~89% / ~80% accuracy where it fires |
| B4 | **small LLM writing WQL**, constrained decoding to the WQL grammar, given a compact outline of the repo (top directories, top class names); validated by running the WQL; 1–3 candidates fused | 200–1500 ms for a 0.5–1.5B model on CPU; too slow for interactive by default | few-shot prompts; optionally a LoRA on (query, oracle WQL) pairs from #req-qopt-oracle, on Colab | the broadest; only for `anvesa ask`, agents, or an opt-in `--rewrite` |
| B5 | **learning from logs**: which rewrites led to a used result (medha episodes, #req-ltr-episodes), feeding B3's labels and the ranker | none at query time beyond B3 | accumulated usage | per-repo adaptation |

B3's embedding-head variant is cheap, but it reads the same vector the dense ranking uses, which
is why PRF failed. It may learn the same blind spots. The control is to compare it with a head
that reads only the query text (character n-grams).

## Evaluation in the gen-lab

- **Runs.** Each variant adds a row to `results/*.jsonl` in the `bench.py score --out` format
  (`rank`, `first_rank`) and is compared with `bench.py compare` (paired, per query, bootstrap CI
  on ΔMRR). The comparison also reports ΔR@10 and ΔR@30, and the counts of *into top 10* and *out
  of top 10/30*.
- **Two first stages.** ettin-1b-full card-only (the headroom above), and the shipped stack
  (card + intent, hub 0.3, XGBoost@30, MRR 0.705). A gain that vanishes under the ranker is not
  worth shipping.
- **Two query sets.**
  - The 241 bench queries, where the expectation is *neutral*, and any loss is a bug.
  - The dev query set (#req-qopt-dev-queries), where the expectation is a gain.
  - Report each set separately and never pooled.
- **Oracle.** Simulated oracle constraints (done above). Then hand-written WQL for a sample: the
  best WQL a developer who knows the repo would write without knowing the answer, run through
  `anvesa query` on the lab clones, so the structural lane's real kinds and mappings are used,
  not card kinds.
- **Queries to watch.**
  - *Helped* by the oracle: `unstorage-mount` (20 → 1 with kind), `unstorage-mask-parent`
    (41 → 3), `retrofit-skip-executor` (17 → 1), `retrofit-plain-string` (139 → 17 kind, → 11 kind
    + dir), `flysystem-subfolder` (116 → 13 / 7), `flysystem-read-only` (15 → 3 / 1),
    `marshmallow-context` (115 → 3 with dir), `commerce-32` (22 → 3 with dir).
  - *Hurt* by naive kind rules: `marshmallow-from-dict` and `marshmallow-inherit` ("class" in the
    query, gold a function: 1 → 571), `retrofit-custom-verb` ("http method": 1 → 2665),
    `viper-default-type` and `viper-unmarshal` ("type", "struct": 1–2 → 57–58), `serde_json-typed`
    (3 → 193), `retrofit-create-service` ("interface": 3 → 117).
  - *Untouched* even by the oracle: `marshmallow-unknown-fields`, `serde_json-raw`,
    `flysystem-ftp-reconnect`, `unstorage-discard` (208 → 42 at best). These are encoder or card
    problems, not structure problems.

## Risks

- **Over-constraining.** Kind words in NL are English, not syntax (see above); hard filters turn a
  rank-1 hit into rank 571. Mitigation: index-grounded cues only, soft or top-k use, abstain by
  default.
- **Valid but wrong WQL.** It parses, matches a plausible set, and excludes the gold, which is
  the worst case because nothing signals it. Mitigation: the literal query is always fused, plus
  the overlap check and the wrong-constraint control in every evaluation.
- **Language mappings.**
  - In C/C++ the outline's functions are unnamed in places, so `[@name=…]` misses them.
  - C# properties are not outline symbols.
  - Go `var ( … )` blocks are not symbols (#req-go-var-blocks).
  - Go methods and package functions share a symbol in some cards.
  - Card kinds (`type`, `struct`) do not line up one-to-one with WQL tags across languages.
  - Mitigation: a per-language table of which kinds the optimizer may emit; no kind constraint
    where the mapping is weak.
- **Latency.** Each rewrite costs a structural run (WQL over every outline). B1–B3 stay under a
  few ms; B4 is far over the interactive budget and stays opt-in.
- **Bench mismatch.** The bench is NL by construction, so a gain on a dev set written by the same
  people who know the answers can be circular. Mitigation: the dev queries are written from the
  task, before looking at search output, and some are taken from real usage (episodes).
- **User trust.** A silent rewrite that loses a result is worse than no optimizer. The rewrite
  must be shown and easy to turn off.

## Requirement: the oracle headroom is measured before anything is built {#req-qopt-oracle}

The simulated numbers above become a lab script, `qopt.py` in the gen-lab, that reproduces them
from stored vectors. Then a sample of ~60 queries (all 24 first-stage misses at 10, plus ~36
hits, spread over the 8 repos) gets a hand-written oracle WQL, stored next to each query as
`wql = "…"` in `bench/<repo>.toml`. That WQL is the best one a developer who knows the repo's
layout would write, without looking at the gold. Each is run through `anvesa query` on the lab
clone and combined with the first stage in each mode (hard, pre-filter, soft, top-30, fused).

Done when:
- the report gives MRR / R@10 / R@30 per mode, with paired CIs against the first stage, on both
  first stages;
- it gives the into/out-of-top-10 counts;
- it lists the oracle WQLs that matched nothing or excluded the gold, by language.

H1 holds if the hand-written oracle gains ≥ +0.02 R@10 on the sample in some mode. If it does not,
stop here and record why.

## Requirement: the break-even curve is part of every predictor's report {#req-qopt-break-even}

`qopt.py` reports, for kind, directory and identifier constraints, the noisy-oracle curve (MRR
and R@10 vs error rate *p*), per combination mode. Each predictor's report then gives three
numbers: how often it fires, how accurate it is where it fires, and where that accuracy lands on
the curve.

A predictor proceeds only if its measured accuracy is above break-even for the mode it would use.

## Requirement: a query set phrased the way developers type {#req-qopt-dev-queries}

About 120 queries over the 8 bench repos, with the same `gold` / `also` labels and new `style`
values:
- `ident`: names or fragments of identifiers;
- `kind`: "the class that…" where it is true;
- `scoped`: names an area of the repo;
- `test`: asks for a test;
- `route`: names an HTTP route;
- `relation`: who calls / uses / implements.

Written from the task without looking at search output. Some are rephrasings of existing bench
queries, linked by id, so the same need can be compared in NL and in developer shorthand. Where
#req-lab-tasks adds who-uses questions, those count here too.

## Requirement: conjunctions never lose what the literal query found {#req-qopt-safe-combine}

The retriever gains the combination modes above for *derived* conjunctions:
- soft boost, top-k reorder, and fused rewrites, alongside today's hard filter;
- hard mode pre-filters inside the dense scan rather than filtering a fetched 500.

The fallback rules hold:
- an empty, unparseable or near-universal WQL runs the query as typed;
- the literal query is always one of the fused inputs.

User-written conjunctions keep today's hard semantics.

Done when, on the bench, no optimizer variant moves a gold hit out of the top 30 on more than 1%
of queries (H3), and a test covers each fallback.

```yojana:claim
kind: path
expression: retriever/src/query-optimizer.ts
```

```yojana:claim
kind: text
expression: /soft|topK|fuse/ in retriever/src/conjunction.ts
```

## Requirement: rule-based extraction, grounded in the index {#req-qopt-rules}

B1 and B2: identifiers, backticked spans, `X.y`, `X()`, "test(s) for X", HTTP verb + path, "class
/ method / function `<Name>`", and words that name a directory or file in this index.

A cue becomes a constraint only if it resolves against this index:
- a symbol with that name or fragment;
- a path segment;
- a route.

Bare English kind words ("type", "struct", "method", "interface") are not cues on their own.

Done when:
- on the 241 bench queries the rules fire on ≤ 5% of queries and the paired ΔMRR is not
  significantly negative;
- on the dev query set they gain R@10 with a CI excluding 0;
- the added latency is < 5 ms p95.

## Requirement: the rewrite is visible and can be turned off {#req-qopt-explain}

Search output says what was searched when it differs from what was typed (`searched as: save user
&& //class[@name="UserRepo"]//method`). JSON output carries the rewrite and each part's source.
`--literal` (and a config key) turns the optimizer off.

```yojana:claim
kind: text
expression: literal in cli/src/commands.ts
```

## Requirement: predicted constraints reach the ranker as features {#req-qopt-ltr-features}

Once #req-ltr-ranker exists, each rewrite contributes features for every top-30 candidate:
- whether it matches the rewrite's WQL;
- the constraint's source (user, rule, tagger, LLM);
- the predictor's confidence;
- the match set's size as a share of the repo.

Measured with `ltr.py`'s leave-one-repo-out, against the same rewrites applied as soft boosts.
This is the "same hint as feature" control from the hypothesis.

## Requirement: a small network says, with a probability, whether a query is pure or decomposable {#req-qopt-tagger}

B3, the preferred builder: a tiny network that runs in-process and is fast and private (ONNX,
well under 1 ms on a laptop CPU, a few MB at most, no LLM, no network). It emits calibrated
probabilities, not labels:

- **Gate.** p(decomposable). Below the threshold the query runs exactly as typed. On the 241 NL
  bench queries it should be low for ≥ 95% of them.
- **Heads**, read only when the gate fires:
  - p(kind = k) over ~10 outline kinds;
  - per-token p(identifier) spans, kept only if the span resolves in the index;
  - p(relation ∈ {calls, called-by, uses, implements, tests});
  - area, scored per candidate directory as p(dir | query, dir name) rather than over a fixed
    label set, since directories differ per repo.

How the probabilities are used:
- Each emitted constraint carries its probability into the combination mode. It is applied
  hard only above the break-even accuracy for that mode (#req-qopt-break-even): ~0.93 for the
  whole list, ~0.89 (kind) / ~0.80 (area) for top-30 reorder. Below that it becomes a soft boost
  with weight scaled by p, or a ranker feature (#req-qopt-ltr-features).
- The gate also governs B1/B2: a rule-found cue becomes a constraint only if the gate agrees.
  That is what keeps "decode into a **struct**" pure.

Labels: a query is decomposable when the structure is stated in it, not when the gold happens to
have a kind. Training data, built and trained on Colab:
- positives by injecting structure into NL queries and intent-card texts: a real identifier, a
  real directory, "class `<Name>`", "tests for `<fn>`", "who calls `<fn>`";
- hard negatives: NL that uses kind words as English (the 15 bench cases above and generated
  ones);
- the dev query set's training split. Evaluation is leave-one-repo-out.

There are two inputs to compare:
- the dense query embedding, ~0 extra cost but possibly redundant with the ranking (as the
  top-k vote was);
- a text-only encoder over character n-grams / hashed word pieces.

Done when:
- the gate's AUROC and calibration (ECE, reliability plot) are reported on the bench and the
  dev set;
- each head's accuracy where it fires clears #req-qopt-break-even for the mode it drives;
- leave-one-repo-out ΔMRR on the bench is ≥ 0 and ΔR@10 on the dev set has a CI excluding 0;
- p95 latency on the laptop CPU is < 2 ms.

## Requirement: an LLM rewriter, constrained and validated, as an opt-in {#req-qopt-llm}

B4: a 0.5–1.5B model on Colab first. It gets the query and a compact repo outline (top
directories, top classes) and writes 1–3 WQL candidates under a grammar constraint (a GBNF / regex
grammar derived from `structural/src/wql.ts`). Each candidate is validated by running it, and
discarded if it is empty or near-universal. The survivors are fused with the literal query.

Measured on both query sets against B1 + B2, with CPU latency timed on the laptop in fp32 and q4.
It may only be an opt-in `--rewrite` or an `anvesa ask` / agent step unless its p95 is under the
interactive budget.

## Requirement: relation queries go to the graph {#req-qopt-relations}

"who calls X", "what uses Y", "implementations of Z", "tests for X" resolve X against the symbol
table. Then they answer from `callers` / `callees` / `dependents` / SCIP `references:type`, with
the relation's targets seeded into search (plan/connection-aware-retrieval, track D). If X does
not resolve, the query runs as NL.

Measured on the dev set's `relation` and `test` styles. The gin unmatched-routes case (`NoRoute`
vs `TestNoRoute`, `callers serveError`) is a named test.

## Requirement: per-language limits on what the optimizer emits {#req-qopt-languages}

A table, in code, of which constraint kinds the optimizer may emit per language, derived from the
mappings' real coverage. Initially:
- no `[@name]` on C/C++ functions;
- no property kind for C#;
- no constant/variable kind for Go var blocks until #req-go-var-blocks.

The oracle run (#req-qopt-oracle) lists the WQL that failed by language. That list is the
evidence for each row.

## Requirement: the optimizer ships on by default only through a gate {#req-qopt-gate}

On by default only if all of these hold:
- on the dev query set, R@10 gains with a paired CI excluding 0 over the shipped first stage (with
  the ranker);
- on the bench, ΔMRR is not significantly negative and H3 holds;
- the added p95 latency is < 30 ms on the lab repos (H4).

Otherwise it stays behind a flag, and the report says which part of the hypothesis failed.

## Order

1. **Now, no GPU:**
   - #req-qopt-oracle: move the simulation scripts into the lab, write the oracle WQL sample, run
     it through `anvesa query`.
   - #req-qopt-break-even.
   - #req-qopt-dev-queries (writing only).
2. **If H1 holds:** #req-qopt-safe-combine, #req-qopt-rules, #req-qopt-explain,
   #req-qopt-languages. All are cheap and local.
3. **With #req-ltr-ranker:** #req-qopt-ltr-features.
4. **Once the dev query set exists:** #req-qopt-tagger, the probability-emitting gate and heads
   (train on Colab). Then #req-qopt-llm (Colab, opt-in) only if headroom remains.
5. **With #req-lab-tasks and track D:** #req-qopt-relations.
6. #req-qopt-gate before any default-on.
