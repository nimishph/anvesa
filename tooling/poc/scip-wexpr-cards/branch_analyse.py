"""Bootstrap comparisons for branch_grid.json: every config against base, and the pairs that
isolate one change each. A CI that excludes 0 is marked *."""
import json
import sys

import numpy as np

R = json.load(open(sys.argv[1]))
rng = np.random.default_rng(0)
PAIRS = [
    ("c2 exact batches", "base", "exact"),
    ("b path words", "exact", "exact+path-words"),
    ("b path wql", "exact", "exact+path-wql"),
    ("b path wql (no exact)", "base", "path-wql"),
    ("c1 propagate, AST graph", "exact", "exact+prop(ast)"),
    ("c1 propagate (no exact)", "base", "prop(ast)"),
    ("a SCIP graph vs AST graph", "exact+prop(ast)", "exact+prop(scip)"),
    ("a +type edges", "exact+prop(scip)", "exact+prop(scip+types)"),
    ("b+c1 wql + prop", "base", "exact+path-wql+prop(ast)"),
    ("b+c1 wql + prop (no exact)", "base", "path-wql+prop(ast)"),
    ("a+b+c1 wql + prop(scip)", "base", "exact+path-wql+prop(scip)"),
]


def compare(a, b):
    a, b = np.array(a), np.array(b)
    d = 1 / b - 1 / a
    boots = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(10000)]
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return d.mean(), lo, hi, int((b < a).sum()), int((b > a).sum())


for model, runs in R.items():
    print(f"\n== {model}")
    base = runs["base"]["ranks"]
    print(f"  {'config':30} {'MRR':>6} {'R@1':>5} {'R@5':>5}   dMRR vs base [95% CI]   better/worse")
    for name, run in sorted(runs.items(), key=lambda kv: -np.mean(1 / np.array(kv[1]["ranks"]))):
        r = np.array(run["ranks"])
        m, lo, hi, up, down = compare(base, r)
        star = "*" if lo > 0 or hi < 0 else " "
        print(f"  {name:30} {np.mean(1 / r):6.3f} {np.mean(r <= 1):5.2f} {np.mean(r <= 5):5.2f}   "
              f"{m:+.3f} [{lo:+.3f}, {hi:+.3f}]{star}  {up}/{down}")
    print("  -- one change at a time")
    for label, x, y in PAIRS:
        if x in runs and y in runs:
            m, lo, hi, up, down = compare(runs[x]["ranks"], runs[y]["ranks"])
            star = "*" if lo > 0 or hi < 0 else " "
            print(f"  {label:30} {m:+.3f} [{lo:+.3f}, {hi:+.3f}]{star}  {up}/{down}   ({x} -> {y})")
