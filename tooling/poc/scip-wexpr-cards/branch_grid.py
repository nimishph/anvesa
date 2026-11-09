"""Index commerce with the poc/scip-wexpr-cards branch under each experimental config, then score
the symbol vectors anvesa stored against the 43 queries (same set as the earlier PoCs).

usage: python branch_grid.py <worktree> <fixture> <scip-file> <runs-dir> <out.json>
"""
import json
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from embed import Encoder

WT, FIXTURE, SCIP, RUNS, OUT = (Path(a) for a in sys.argv[1:6])
MODELS = ["all-MiniLM-L6-v2", "jina-embeddings-v2-base-code"]
P = {"alpha": 0.3, "edges": ["calls"]}
CONFIGS = {
    "base": {},
    "exact": {"exactBatches": True},
    "exact+path-words": {"exactBatches": True, "cardPath": "words"},
    "exact+path-wql": {"exactBatches": True, "cardPath": "wql"},
    "exact+prop(ast)": {"exactBatches": True, "propagate": P},
    "exact+prop(scip)": {"exactBatches": True, "scip": "index.scip", "propagate": P},
    "exact+prop(scip+types)": {"exactBatches": True, "scip": "index.scip",
                               "propagate": {"alpha": 0.3, "edges": ["calls", "references:type"]}},
    "exact+path-words+prop(ast)": {"exactBatches": True, "cardPath": "words", "propagate": P},
    "exact+path-words+prop(scip)": {"exactBatches": True, "cardPath": "words", "scip": "index.scip", "propagate": P},
    "path-wql": {"cardPath": "wql"},
    "prop(ast)": {"propagate": P},
    "path-wql+prop(ast)": {"cardPath": "wql", "propagate": P},
    "exact+path-wql+prop(ast)": {"exactBatches": True, "cardPath": "wql", "propagate": P},
    "exact+path-wql+prop(scip)": {"exactBatches": True, "cardPath": "wql", "scip": "index.scip", "propagate": P},
}
QUERIES = json.loads((Path(__file__).parent / "queries.json").read_text())


def index(name: str, model: str, experimental: dict) -> tuple[Path, list[str], float]:
    run = RUNS / f"{model}__{name}".replace("(", "_").replace(")", "_").replace("+", "_")
    if run.exists():
        shutil.rmtree(run)
    shutil.copytree(FIXTURE, run, ignore=shutil.ignore_patterns(".anvesa", ".git"))
    shutil.copy(SCIP, run / "index.scip")
    (run / ".anvesa").mkdir()
    config = {"model": model, **({"experimental": experimental} if experimental else {})}
    (run / ".anvesa" / "config.json").write_text(json.dumps(config))
    t = time.time()
    out = subprocess.run([shutil.which("bun") or "bun", "run", str(WT / "cli/src/bin.ts"), "index"], cwd=run,
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise SystemExit(f"{name} {model} failed:\n{out.stdout}\n{out.stderr}")
    notes = [l for l in (out.stdout + out.stderr).splitlines() if "experimental" in l]
    return run / ".anvesa" / "index.db", notes, time.time() - t


def ranks(db: Path, qv: np.ndarray) -> list[int]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = con.execute(
        "select c.group_key, v.vector, v.dims from card_vectors v join cards c on c.channel=v.channel and c.id=v.id "
        "where v.channel='symbols'").fetchall()
    groups = [g for g, _, _ in rows]
    vecs = np.stack([np.frombuffer(b, np.float32, count=d) for _, b, d in rows])
    sims = qv @ vecs.T
    out = []
    for qi, q in enumerate(QUERIES):
        best = {}
        for g, s in zip(groups, sims[qi]):  # a symbol scores as its best card
            best[g] = max(best.get(g, -9), float(s))
        order = sorted(best, key=lambda g: -best[g])
        missing = [r for r in q["rel"] if r not in best]
        assert not missing, f"{db}: no card for {missing}"
        out.append(min(order.index(r) for r in q["rel"]) + 1)
    return out


results = {}
for model in MODELS:
    qv = Encoder(model).embed([q["q"] for q in QUERIES], batch=1)
    results[model] = {}
    for name, experimental in CONFIGS.items():
        db, notes, seconds = index(name, model, experimental)
        r = ranks(db, qv)
        results[model][name] = {"ranks": r, "notes": notes, "seconds": round(seconds, 1)}
        a = np.array(r)
        print(f"{model[:12]:12} {name:30} MRR={np.mean(1 / a):.3f} R@1={np.mean(a <= 1):.2f} "
              f"R@5={np.mean(a <= 5):.2f} ({seconds:.0f}s)", flush=True)
OUT.write_text(json.dumps(results, indent=1))
