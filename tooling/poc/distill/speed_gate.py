"""Speed gate for student candidates: export each to ONNX, quantize to int8 as anvesa's built-ins are,
and time it on CPU the way anvesa embeds (its tokenizer, batches of 32, one thread pool), next to the
installed all-MiniLM-L6-v2. Zero-shot MRR on commerce too, for the ones that are already embedders.

usage: python speed_gate.py <cards.db> <commerce-wql.db> <out-dir> [hf-id ...]
  cards.db        an anvesa index whose symbol cards are timed (e.g. anvesa's own source)
  commerce-wql.db commerce indexed with cardPath "wql", scored with queries.json
"""
import json
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from onnx_io import OnnxEncoder, export_onnx, pooling_of  # noqa: E402

CARDS, COMMERCE, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
CANDIDATES = sys.argv[4:] or [
    "jhu-clsp/ettin-encoder-17m",
    "jhu-clsp/ettin-encoder-32m",
    "jhu-clsp/ettin-encoder-68m",
    "ibm-granite/granite-embedding-small-english-r2",
    "ibm-granite/granite-embedding-english-r2",
    "Alibaba-NLP/gte-modernbert-base",
]
QUERIES = json.loads((Path(__file__).parent / "queries.json").read_text())


def texts(db: Path, with_groups: bool = False):
    rows = sqlite3.connect(f"file:{db}?mode=ro", uri=True).execute(
        "select group_key, card from cards where channel='symbols'").fetchall()
    if with_groups:
        return [g for g, _ in rows], [json.loads(c)["text"] for _, c in rows]
    return [json.loads(c)["text"] for _, c in rows]


def mrr(enc: OnnxEncoder, groups: list[str], cards: list[str]) -> float:
    sims = enc.embed([q["q"] for q in QUERIES], batch=1) @ enc.embed(cards, batch=1).T
    rr = []
    for qi, q in enumerate(QUERIES):
        best: dict[str, float] = {}
        for g, s in zip(groups, sims[qi]):
            best[g] = max(best.get(g, -9.0), float(s))
        order = sorted(best, key=lambda g: -best[g])
        rr.append(1 / (min(order.index(r) for r in q["rel"]) + 1))
    return float(np.mean(rr))


def main() -> None:
    big = texts(CARDS)
    sample = sorted(big, key=len)[::6]
    groups, commerce = texts(COMMERCE, with_groups=True)
    models = Path.home() / ".anvesa" / "models" / "all-MiniLM-L6-v2"
    rows = [("all-MiniLM-L6-v2 (installed)", OnnxEncoder(models / "model.onnx", models / "tokenizer.json", "mean", 256), True)]
    for hf in CANDIDATES:
        folder = OUT / hf.replace("/", "__")
        if not (folder / "model.int8.onnx").exists():
            export_onnx(hf, folder)
        pool = pooling_of(hf)
        rows.append((hf, OnnxEncoder(folder / "model.int8.onnx", folder / "tokenizer.json", pool, 512),
                     "embedding" in hf))
    result = {}
    for name, enc, zero_shot in rows:
        enc.embed(sample[:32])
        t = time.time()
        enc.embed(sample, batch=32)
        secs = (time.time() - t) * len(big) / len(sample)
        score = mrr(enc, groups, commerce) if zero_shot else None
        result[name] = {"seconds": secs, "params_m": enc.params_m, "onnx_mb": enc.size_mb, "mrr": score}
        print(f"{name:48} {enc.params_m:6.0f}M {enc.size_mb:6.0f}MB  {secs:7.1f}s for {len(big)} cards"
              + (f"  zero-shot MRR {score:.3f}" if score is not None else ""), flush=True)
    (OUT / "speed_gate.json").write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
