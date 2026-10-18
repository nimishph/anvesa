"""Clone each repo in repos.json, index it with anvesa (WQL-path cards), and write its symbol cards.

usage: python export_cards.py <anvesa-worktree> <work-dir> [--only name,name]

Cards are only stored once embedded, so each repo is indexed with all-MiniLM-L6-v2; the vectors are
thrown away. Out: <work-dir>/data/cards/<repo>.jsonl and <work-dir>/data/manifest.json.

A card's text is: head line, WQL path line, doc (when there is one), signature (when there is one).
Each record splits it into those parts, so a query can be made from the doc and matched to the
card without it.
"""
import json
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
WT, WORK = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
BUN = shutil.which("bun") or "bun"
CONFIG = {"model": "all-MiniLM-L6-v2", "experimental": {"cardPath": "wql"}}


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def split(text: str, attrs: dict) -> dict | None:
    lines = text.split("\n")
    if len(lines) < 2 or not lines[1].startswith("/"):
        return None
    head, path, rest = lines[0], lines[1], lines[2:]
    signature = attrs.get("signature")
    if signature and rest and rest[-1] == signature:
        rest = rest[:-1]
    else:
        signature = None
    doc = "\n".join(rest).strip()
    if (attrs.get("hasDoc") == "true") != bool(doc):
        return None
    return {"head": head, "path": path, "doc": doc, "signature": signature or ""}


def export(repo: dict, manifest: dict) -> None:
    name = repo["url"].rstrip("/").split("/")[-1]
    if ONLY and name not in ONLY:
        return
    src = WORK / "repos" / name
    if not src.exists():
        out = run(["git", "clone", "--depth", "1", "--quiet", repo["url"], str(src)], WORK)
        if out.returncode != 0:
            print(f"{name}: clone failed: {out.stderr.strip()}", flush=True)
            return
    sha = run(["git", "rev-parse", "HEAD"], src).stdout.strip()
    anvesa = src / ".anvesa"
    if anvesa.exists():
        shutil.rmtree(anvesa)
    anvesa.mkdir()
    (anvesa / "config.json").write_text(json.dumps(CONFIG))
    t = time.time()
    out = run([BUN, "run", str(WT / "cli/src/bin.ts"), "index"], src)
    if out.returncode != 0:
        print(f"{name}: index failed:\n{out.stdout[-2000:]}\n{out.stderr[-2000:]}", flush=True)
        return
    rows = sqlite3.connect(f"file:{anvesa / 'index.db'}?mode=ro", uri=True).execute(
        "select id, group_key, card from cards where channel='symbols'").fetchall()
    kept, dropped, seen = [], 0, set()
    for card_id, group, raw in rows:
        card = json.loads(raw)
        if group in seen:  # a long card packed into several parts: keep the first
            continue
        seen.add(group)
        parts = split(card["text"], card["attrs"])
        if parts is None:
            dropped += 1
            continue
        kept.append({"repo": name, "lang": repo["lang"], "split": repo["split"], "id": card_id,
                     "group": group, "kind": card["attrs"].get("kind", ""), "file": card["source"]["path"],
                     "text": card["text"], **parts})
    target = WORK / "data" / "cards" / f"{name}.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(json.dumps(k) + "\n" for k in kept), encoding="utf-8")
    manifest[name] = {**repo, "commit": sha, "cards": len(kept), "unparsed": dropped,
                      "with_doc": sum(1 for k in kept if k["doc"]), "index_seconds": round(time.time() - t, 1)}
    print(f"{name:12} {len(kept):6} cards  {manifest[name]['with_doc']:6} with doc  "
          f"{dropped:4} unparsed  {manifest[name]['index_seconds']:7.1f}s", flush=True)


def main() -> None:
    (WORK / "repos").mkdir(parents=True, exist_ok=True)
    path = WORK / "data" / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(path.read_text()) if path.exists() else {}
    for repo in json.loads((HERE / "repos.json").read_text())["repos"]:
        export(repo, manifest)
        path.write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
