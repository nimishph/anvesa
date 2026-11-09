"""Turn exported cards into training data.

usage: python make_pairs.py <work-dir> <commerce-wql.db>

Writes <work-dir>/data/:
  corpus.jsonl   every card, full text and without its doc ("bare"), by repo: what negatives come from
  pairs.jsonl    (query, positive) from documentation: the query is the doc's first sentence and the
                 positive is the same card *without* its doc, so matching it means understanding the
                 name, path and signature, not copying words back
  commerce.json  the hand-labelled test set: commerce's WQL-path cards and the 43 queries
"""
import json
import random
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

WORK, COMMERCE = Path(sys.argv[1]), Path(sys.argv[2])
DATA = WORK / "data"
QUERIES = json.loads((Path(__file__).parent / "queries.json").read_text())
SKIP = re.compile(r"^(@|todo|fixme|deprecated|internal|license|copyright|see |http|#|```|-|\*|\|)", re.I)
NOISE = re.compile(r"https?://|license|copyright|eslint|ts-ignore|noqa|biome-ignore", re.I)
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec|testing|fixtures?|examples?|benchmarks?)/|[._-](test|spec)s?\.\w+$|(^|/)test_[^/]+$|_test\.\w+$", re.I)


def is_query_source(card: dict) -> bool:
    """Documented symbols worth a query: not in tests or examples, not a local variable."""
    if TEST_FILE.search(card["file"]):
        return False
    depth = card["path"].count("/") - card["path"].startswith("/export")
    return not (card["kind"] in ("variable", "constant", "field") and depth > 1)


def first_sentence(doc: str) -> str | None:
    text = re.sub(r"`([^`]*)`", r"\1", doc.strip())
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.split(r"(?<=[.!?])\s|\n\s*\n|\n(?=[@:A-Z][a-z]*[: ])", text, maxsplit=1)[0]
    text = " ".join(text.split()).rstrip(".")
    words = text.split()
    if SKIP.match(text) or NOISE.search(text) or not 4 <= len(words) <= 40:
        return None
    return text


def without_doc(card: dict) -> str:
    return "\n".join(x for x in (card["head"], card["path"], card["signature"]) if x)


def main() -> None:
    random.seed(7)
    corpus, pairs = [], []
    for path in sorted((DATA / "cards").glob("*.jsonl")):
        cards = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        corpus += [{"repo": c["repo"], "split": c["split"], "group": c["group"], "text": c["text"],
                    "bare": without_doc(c)} for c in cards]
        seen = Counter(first_sentence(c["doc"]) for c in cards if c["doc"])
        for c in cards:
            query = first_sentence(c["doc"]) if c["doc"] and is_query_source(c) else None
            if query is None or seen[query] > 1:  # the same doc on several symbols names none of them
                continue
            pairs.append({"repo": c["repo"], "split": c["split"], "group": c["group"], "query": query,
                          "positive": without_doc(c), "source": "doc"})
    rows = sqlite3.connect(f"file:{COMMERCE}?mode=ro", uri=True).execute(
        "select group_key, card from cards where channel='symbols'").fetchall()
    commerce = {"groups": [g for g, _ in rows], "cards": [json.loads(c)["text"] for _, c in rows], "queries": QUERIES}
    (DATA / "corpus.jsonl").write_text("".join(json.dumps(r) + "\n" for r in corpus), encoding="utf-8")
    (DATA / "pairs.jsonl").write_text("".join(json.dumps(r) + "\n" for r in pairs), encoding="utf-8")
    (DATA / "commerce.json").write_text(json.dumps(commerce), encoding="utf-8")
    by = Counter((p["split"]) for p in pairs)
    print(f"corpus {len(corpus)} cards; pairs {len(pairs)} ({dict(by)}); commerce {len(commerce['cards'])} cards")
    for p in random.sample(pairs, 6):
        print(f"\n  Q: {p['query']}\n  +: {p['positive'][:160]!r}")


if __name__ == "__main__":
    main()
