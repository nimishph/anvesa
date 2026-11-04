# PoC: SCIP edges, W-expression paths in cards, graph propagation, exact batches

Four experiments behind `experimental` in `.anvesa/config.json`. Each is off when absent.

| Switch | What it does |
| --- | --- |
| `scip: "index.scip"` | A SCIP index's references replace the linker's call edges (`calls`, `calls:name`, `calls:unresolved`); references to types become `references:type`. Import and external edges stay. Ids stay anvesa's; a SCIP symbol is matched to a symbol by file, line and name. Turning it off needs `anvesa index --force` to bring the linker's edges back. |
| `cardPath: "words" \| "wql"` | The symbol card gains its enclosing W-expression nodes: `in export, class config loader`, or `/export/class[@name="ConfigLoader"]/method[@name="ConfigLoader.load"]`. Changes the transformer version, so cards are rebuilt. |
| `propagate: { alpha, edges }` | Each searched symbol vector becomes `unit(raw + alpha * mean(neighbours))`, neighbours by the edge kinds given (default `calls`) and containment. Raw vectors are kept (`card_vectors_raw`, migration 10), so it never compounds and turns off without re-embedding. |
| `exactBatches: true` | The encoder batches only texts of one length. Padding moves a vector even when masked (cos 0.990 for MiniLM, 0.996 for jina against the same text alone), so today a card's vector depends on its batch, and differs from how a query (always alone) is embedded. |

## Results

`commerce` fixture (171 symbol cards), 43 hand-written queries with known answers, symbol lane only,
scored on the vectors anvesa stored. MRR, with the change against `base` (today) and a 95% bootstrap
interval; `*` = the interval excludes 0. Reproduce with `branch_grid.py` then `branch_analyse.py`.

| Config | MiniLM-L6 | jina-v2-code |
| --- | --- | --- |
| base (today) | 0.648 | 0.691 |
| exact batches | 0.627 (−0.021 *) | 0.701 (+0.010) |
| path words | 0.656 (+0.008) | 0.721 (+0.030) |
| path wql | 0.679 (+0.031) | **0.783 (+0.092 \*)** |
| propagate, AST graph | 0.670 (+0.021) | 0.721 (+0.030 \*) |
| exact + propagate, AST graph | 0.678 (+0.029 \*) | 0.726 (+0.035 \*) |
| exact + propagate, SCIP graph | 0.677 (+0.029 \*) | 0.726 (+0.035 \*) |
| exact + propagate, SCIP graph with type edges | 0.649 (+0.001) | 0.706 (+0.015) |
| path wql + propagate | 0.687 (+0.038) | 0.773 (+0.082 \*) |
| exact + path words + propagate | **0.688 (+0.040)** | 0.732 (+0.041 \*) |

One change at a time:

- **SCIP instead of the AST call graph: no difference** for propagation (−0.001 and 0.000). Within
  this repo the linker already finds the same call edges; SCIP's extra is type references.
- **Type edges hurt**: −0.028 (MiniLM) and −0.020 \* (jina, 0 queries better, 7 worse).
- **W-expression path, WQL form: the largest gain, on the code model** (+0.092 \*, R@1 0.56 → 0.70).
  On MiniLM it is not distinguishable from noise. Most symbols here are top-level, so the path is
  mostly `/export/function[@name="X"]`: the gain likely comes from the identifier in code syntax,
  not from nesting. Unproven; a repo with deep nesting would tell.
- **Propagation helps both models** (MiniLM +0.051 \* over exact batches; jina +0.030 \*), and
  does not stack with the WQL path on jina.
- **Exact batches make vectors deterministic but do not improve retrieval**: −0.021 \* on MiniLM,
  +0.010 on jina. Determinism and quality are separate questions.

Limits: one small repo, 43 queries; intervals are wide, and a few queries move a whole point.

## Found on the way

- scip-typescript does not set the `import` role on imported names, so imports looked like
  file-level calls. The overlay skips references on import lines (from the W-expression).
- A `"use cache"` directive is taken as `getProduct`'s documentation (existing behaviour, not changed here).
