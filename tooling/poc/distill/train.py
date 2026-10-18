"""Distil jina-embeddings-v2-base-code (on WQL-path cards) into a small modern encoder.

Runs on Colab (T4) or locally; every stage reads and writes <work>/data and <work>/out.

  python train.py queries  <work> [--n 20000]          LLM-written queries for cards (optional)
  python train.py teacher  <work>                      teacher vectors, hard negatives, teacher scores
  python train.py train    <work> --student ID [--lora R] [--epochs N] ...
  python train.py export   <work> --run NAME           ONNX + int8 + tokenizer.json, ready for anvesa
  python train.py eval     <work> --model ID|DIR       MRR on val pairs and commerce (any encoder)

The loss, per query with its positive and k hard negatives (mined by the teacher, same repo):
  InfoNCE over every candidate in the batch (positives and negatives of all queries)
  + lambda * KL(teacher || student) over the query's own k+1 candidates
so the student learns the teacher's ranking, not just "positive beats random".
"""
import argparse
import hashlib
import json
import math
import random
import re
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

TEACHER = "jinaai/jina-embeddings-v2-base-code"
TEACHER_REVISION = "516f4baf13dec4ddddda8631e019b5737c8bc250"  # its modeling code: jinaai/jina-bert-v2-qk-post-norm
GENERATOR = "Qwen/Qwen2.5-Coder-1.5B-Instruct"
GENERATOR_REVISION = "2e1fd397ee46e1388853d2af2c993145b0f1098a"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


# ---------------------------------------------------------------- queries (optional)

PROMPT = (
    "Below is a summary card of one symbol in a {lang} codebase: its kind and name, where it sits "
    "(an XPath-like path), its documentation if any, and its signature.\n\n{card}\n\n"
    "Write one short search query (4 to 12 words) that a developer who does not know this code would "
    "type to find it. Describe what it does or what it is for, in plain words. Do not use its name or "
    "the words of its name, and do not mention the language or the codebase.\n\n"
    "Good queries look like:\n"
    "how long to wait before retrying after a rate limit\n"
    "strip credentials when a redirect goes to another host\n"
    "validate that a string is a url\n\n"
    "Reply with the query only."
)
QUERY_SKIP_FILE = re.compile(r"(^|/)(tests?|__tests__|spec|testing|fixtures?|examples?|benchmarks?|bench|docs?)/"
                             r"|[._-](test|spec|bench)s?\.\w+$|(^|/)test_[^/]+$|_test\.\w+$", re.I)
BOILERPLATE = re.compile(r"\b(codebase|typescript|javascript|python|golang|rust|java|ruby|php|find (the )?\w+ (class|function|interface|type|method|variable))\b", re.I)


def query_worthy(card: dict) -> bool:
    """Cards a developer would search for: not tests or benchmarks, not a local inside a function."""
    lines = card["text"].splitlines()
    kind, path = lines[0].split(" ", 1)[0], lines[1] if len(lines) > 1 else ""
    depth = path.count("/") - path.startswith("/export")
    return not QUERY_SKIP_FILE.search(card["group"].split("#")[0]) and not (kind in ("variable", "constant", "field") and depth > 1)


def names_it(query: str, card: dict) -> bool:
    """The query gives the symbol away: its identifier, or every word of its name (`Zod Enum` for ZodEnum)."""
    q = query.lower()
    name = card["group"].split("#")[-1].split(".")[-1].lower()
    head = card["text"].splitlines()[0].split(" — ")
    words = head[1].lower().split() if len(head) > 1 else []
    return name in q or (len(words) > 1 and all(re.search(rf"\b{re.escape(w)}", q) for w in words))


def stage_queries(work: Path, n: int, batch: int, generator: str = GENERATOR, revision: str | None = GENERATOR_REVISION) -> None:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    data = work / "data"
    cards = [c for c in jsonl(data / "corpus.jsonl") if c["split"] != "test" and query_worthy(c)]
    langs = {json.loads(l)["repo"]: json.loads(l)["lang"]
             for p in (data / "cards").glob("*.jsonl") for l in p.read_text(encoding="utf-8").splitlines()[:1]}
    random.seed(11)
    random.shuffle(cards)
    # documented cards first: the generator writes far better queries when it can read what the symbol is for
    cards.sort(key=lambda c: c["text"] == c["bare"])
    cards = cards[:n]
    tok = AutoTokenizer.from_pretrained(generator, revision=revision, padding_side="left")
    lm = AutoModelForCausalLM.from_pretrained(generator, revision=revision, dtype=torch.float16 if DEVICE == "cuda" else torch.float32).to(DEVICE).eval()
    out, t = [], time.time()
    for i in range(0, len(cards), batch):
        chunk = cards[i : i + batch]
        prompts = [tok.apply_chat_template([{"role": "user", "content": PROMPT.format(lang=langs.get(c["repo"], "code"), card=c["text"][:1200])}],
                                           tokenize=False, add_generation_prompt=True) for c in chunk]
        enc = tok(prompts, return_tensors="pt", padding=True).to(DEVICE)
        with torch.no_grad():
            gen = lm.generate(**enc, max_new_tokens=32, do_sample=False, pad_token_id=tok.eos_token_id)
        for c, ids in zip(chunk, gen[:, enc["input_ids"].shape[1]:]):
            q = tok.decode(ids, skip_special_tokens=True).strip().strip('"').splitlines()[0] if ids.numel() else ""
            q = q.strip("`'\" ").rstrip(".")
            if 3 <= len(q.split()) <= 16 and not names_it(q, c) and not BOILERPLATE.search(q):
                out.append({"repo": c["repo"], "split": c["split"], "group": c["group"], "query": q,
                            "positive": c["text"], "source": "llm"})
        if i // batch % 20 == 0:
            print(f"  {i + len(chunk)}/{len(cards)} cards, {len(out)} queries kept, {time.time() - t:.0f}s", flush=True)
    write_jsonl(data / "pairs_llm.jsonl", out)
    for row in random.sample(out, min(8, len(out))):
        print(f"  Q: {row['query']}\n     {row['positive'].splitlines()[0][:100]}")


def all_pairs(data: Path) -> list[dict]:
    pairs = jsonl(data / "pairs.jsonl")
    if (data / "pairs_llm.jsonl").exists():
        pairs += jsonl(data / "pairs_llm.jsonl")
    return pairs


# ---------------------------------------------------------------- encoders

class Student(torch.nn.Module):
    """A Hugging Face encoder, pooled the way anvesa will pool its ONNX export."""

    def __init__(self, name: str, pooling: str = "mean", lora: int = 0):
        super().__init__()
        from transformers import AutoModel, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(name)
        self.net = AutoModel.from_pretrained(name)
        self.pooling = pooling
        if lora:
            from peft import LoraConfig, get_peft_model

            self.net = get_peft_model(self.net, LoraConfig(r=lora, lora_alpha=2 * lora, lora_dropout=0.05,
                                                           target_modules="all-linear"))
            self.net.print_trainable_parameters()

    def forward(self, texts: list[str], max_len: int) -> torch.Tensor:
        enc = self.tok(texts, padding=True, truncation=True, max_length=max_len, return_tensors="pt").to(DEVICE)
        states = self.net(input_ids=enc["input_ids"], attention_mask=enc["attention_mask"]).last_hidden_state
        if self.pooling == "cls":
            pooled = states[:, 0]
        else:
            m = enc["attention_mask"].unsqueeze(-1).to(states.dtype)
            pooled = (states * m).sum(1) / m.sum(1)
        return F.normalize(pooled.float(), dim=-1)

    @torch.no_grad()
    def encode(self, texts: list[str], max_len: int = 512, batch: int = 128) -> np.ndarray:
        self.eval()
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        chunks = []
        for i in range(0, len(order), batch):
            with torch.autocast(DEVICE, enabled=DEVICE == "cuda", dtype=torch.float16):
                chunks.append(self([texts[j] for j in order[i : i + batch]], max_len).cpu().numpy())
        flat = np.vstack(chunks)
        out = np.zeros_like(flat)
        out[order] = flat
        return out


def load_encoder(model: str):
    """Something with .encode(texts) -> unit vectors: the teacher, a trained run, or any HF / ST model."""
    path = Path(model)
    if (path / "student.json").exists():
        meta = json.loads((path / "student.json").read_text())
        return Student(str(path), meta["pooling"]).to(DEVICE)
    from sentence_transformers import SentenceTransformer

    st = SentenceTransformer(model, trust_remote_code=True, device=DEVICE,
                             **({"revision": TEACHER_REVISION} if model == TEACHER and TEACHER_REVISION else {}))
    st.max_seq_length = 512
    if DEVICE == "cuda":
        st.half()

    class Wrapped:
        def encode(self, texts, max_len=512, batch=128):
            return st.encode(texts, batch_size=batch, normalize_embeddings=True, convert_to_numpy=True,
                             show_progress_bar=False).astype(np.float32)

    return Wrapped()


# ---------------------------------------------------------------- evaluation

def mrr_groups(qv: np.ndarray, cv: np.ndarray, groups: list[str], relevant: list[set[str]]) -> float:
    sims = qv @ cv.T
    rr = []
    for qi, rel in enumerate(relevant):
        best: dict[str, float] = {}
        for g, s in zip(groups, sims[qi]):
            if s > best.get(g, -9):
                best[g] = float(s)
        order = sorted(best, key=lambda g: -best[g])
        rank = min((order.index(r) for r in rel if r in best), default=len(order))
        rr.append(1 / (rank + 1))
    return float(np.mean(rr))


def evaluate(enc, data: Path, max_val: int = 1500) -> dict:
    """commerce: the 43 hand-written queries (held out of everything). val: doc queries of the val
    repos, each searched among all of its repo's cards (full text, as anvesa stores them)."""
    commerce = json.loads((data / "commerce.json").read_text(encoding="utf-8"))
    result = {"commerce": mrr_groups(enc.encode([q["q"] for q in commerce["queries"]], 64),
                                     enc.encode(commerce["cards"]), commerce["groups"],
                                     [set(q["rel"]) for q in commerce["queries"]])}
    corpus = [c for c in jsonl(data / "corpus.jsonl") if c["split"] == "val"]
    pairs = [p for p in all_pairs(data) if p["split"] == "val"]
    random.Random(3).shuffle(pairs)
    for source in ("doc", "llm"):
        chosen = [p for p in pairs if p["source"] == source][:max_val]
        if not chosen:
            continue
        scores = []
        for repo in sorted({p["repo"] for p in chosen}):
            rp = [p for p in chosen if p["repo"] == repo]
            rc = [c for c in corpus if c["repo"] == repo]
            scores.append((len(rp), mrr_groups(enc.encode([p["query"] for p in rp], 64), enc.encode([c["text"] for c in rc]),
                                               [c["group"] for c in rc], [{p["group"]} for p in rp])))
        result[f"val_{source}"] = sum(n * s for n, s in scores) / sum(n for n, _ in scores)
    return result


# ---------------------------------------------------------------- teacher

def stage_teacher(work: Path, negatives: int, margin: float, llm_top: int = 10) -> None:
    data, out = work / "data", work / "out"
    out.mkdir(exist_ok=True)
    teacher = load_encoder(TEACHER)
    t = time.time()
    print("teacher, before any training:", json.dumps(evaluate(teacher, data)), flush=True)
    corpus = jsonl(data / "corpus.jsonl")
    pairs = [p for p in all_pairs(data) if p["split"] == "train"]
    # A doc query's positive has its doc taken out, so its negatives must too, or any negative whose
    # doc shares the query's words outranks it and the teacher's scores teach the wrong thing.
    train_repos = {p["repo"] for p in pairs}
    corpus = [c for c in corpus if c["repo"] in train_repos]
    def cached(name: str, texts: list[str], max_len: int = 512) -> np.ndarray:
        """Teacher vectors, kept in out/ so a change to how negatives are picked does not re-encode."""
        path = out / f"teacher_{name}.npy"
        key = out / f"teacher_{name}.key"
        digest = hashlib.sha256(json.dumps(texts).encode()).hexdigest()
        if path.exists() and key.exists() and key.read_text() == digest:
            return np.load(path)
        vectors = teacher.encode(texts, max_len)
        np.save(path, vectors)
        key.write_text(digest)
        return vectors

    full = cached("full", [c["text"] for c in corpus])
    bare = cached("bare", [c["bare"] for c in corpus])
    qv = cached("queries", [p["query"] for p in pairs], 64)
    pv = cached("positives", [p["positive"] for p in pairs])
    by_repo: dict[str, list[int]] = {}
    for i, c in enumerate(corpus):
        by_repo.setdefault(c["repo"], []).append(i)
    rows, skipped = [], []
    for i, p in enumerate(pairs):
        pool = by_repo[p["repo"]]
        cv, field = (bare, "bare") if p["source"] == "doc" else (full, "text")
        sims = cv[pool] @ qv[i]
        t_pos = float(pv[i] @ qv[i])
        # The hardest negatives the teacher still ranks below the positive. Ones it ranks above are
        # either unlabelled positives (an overload, a re-export) or the teacher's own mistakes;
        # either way its scores there would teach the student to contradict the label.
        ranked = [pool[j] for j in np.argsort(-sims)[:200] if corpus[pool[j]]["group"] != p["group"]]
        above = sum(1 for j in ranked if float(cv[j] @ qv[i]) >= t_pos - margin)
        top = [j for j in ranked if float(cv[j] @ qv[i]) < t_pos - margin][:negatives]
        # round-trip filter: an LLM query the teacher cannot find its own card for is too vague or wrong
        if len(top) < negatives or (p["source"] == "llm" and above >= llm_top):
            continue
        skipped.append(above)
        rows.append({"query": p["query"], "positive": p["positive"], "source": p["source"], "repo": p["repo"],
                     "negatives": [corpus[j][field] for j in top],
                     "t_pos": t_pos, "t_neg": [float(cv[j] @ qv[i]) for j in top]})
    write_jsonl(out / "teacher.jsonl", rows)
    first = np.mean([a == 0 for a in skipped])
    print(f"teacher: {len(rows)} of {len(pairs)} training queries kept, {negatives} hard negatives each; "
          f"the teacher ranks the positive first for {first:.0%}, median {np.median(skipped):.0f} cards above it "
          f"(skipped as negatives); {time.time() - t:.0f}s", flush=True)


# ---------------------------------------------------------------- training

def stage_train(work: Path, args) -> None:
    data, out = work / "data", work / "out"
    name = args.name or f"{args.student.split('/')[-1]}{'-lora' + str(args.lora) if args.lora else ''}"
    run = out / name
    run.mkdir(parents=True, exist_ok=True)
    rows = jsonl(out / "teacher.jsonl")
    student = Student(args.student, args.pooling, args.lora).to(DEVICE)
    params = [p for p in student.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
    steps = args.epochs * math.ceil(len(rows) / args.batch)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, s / max(1, int(0.06 * steps))) * max(0.0, (steps - s) / max(1, steps - int(0.06 * steps))))
    scaler = torch.amp.GradScaler(enabled=DEVICE == "cuda")
    history = [{"epoch": 0, **evaluate(student, data)}]
    print(f"{name}: before training {json.dumps(history[0])}", flush=True)
    step, t = 0, time.time()
    for epoch in range(1, args.epochs + 1):
        student.train()
        random.Random(epoch).shuffle(rows)
        for i in range(0, len(rows), args.batch):
            chunk = rows[i : i + args.batch]
            k = min(args.negatives, min(len(r["negatives"]) for r in chunk))
            cands = [r["positive"] for r in chunk] + [n for r in chunk for n in r["negatives"][:k]]
            with torch.autocast(DEVICE, enabled=DEVICE == "cuda", dtype=torch.float16):
                q = student([r["query"] for r in chunk], 64)
                c = student(cands, args.max_len)
            b = len(chunk)
            logits = q @ c.T / args.tau  # (b, b + b*k)
            info_nce = F.cross_entropy(logits, torch.arange(b, device=DEVICE))
            own = torch.cat([torch.arange(b, device=DEVICE).unsqueeze(1),
                             b + torch.arange(b, device=DEVICE).unsqueeze(1) * k + torch.arange(k, device=DEVICE)], 1)
            s_own = torch.gather(logits, 1, own)
            t_own = torch.tensor([[r["t_pos"]] + r["t_neg"][:k] for r in chunk], device=DEVICE) / args.tau_teacher
            kl = F.kl_div(F.log_softmax(s_own, 1), F.log_softmax(t_own, 1), log_target=True, reduction="batchmean")
            loss = info_nce + args.kl * kl
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            step += 1
            if step % 50 == 0:
                print(f"  epoch {epoch} step {step}/{steps} loss {loss.item():.3f} (nce {info_nce.item():.3f}, kl {kl.item():.3f}) "
                      f"{time.time() - t:.0f}s", flush=True)
        history.append({"epoch": epoch, **evaluate(student, data)})
        print(f"{name}: epoch {epoch} {json.dumps(history[-1])}", flush=True)
    net = student.net.merge_and_unload() if args.lora else student.net
    net.save_pretrained(run / "model")
    student.tok.save_pretrained(run / "model")
    meta = {"student": args.student, "pooling": args.pooling, "lora": args.lora, "args": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()}, "history": history}
    (run / "model" / "student.json").write_text(json.dumps(meta, indent=1))
    (run / "history.json").write_text(json.dumps(history, indent=1))


def stage_export(work: Path, run: str) -> None:
    from onnx_io import export_onnx

    folder = work / "out" / run
    meta = json.loads((folder / "model" / "student.json").read_text())
    # fp32 only: dynamic int8 took a trained Ettin student from 0.40 to 0.02 MRR
    onnx = folder / "onnx"
    export_onnx(str(folder / "model"), onnx, meta["pooling"], quantize=False)
    print(f"wrote {onnx}: install with\n  anvesa model install {run} --from {onnx} "
          f"--pooling {meta['pooling']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["queries", "teacher", "train", "export", "eval"])
    ap.add_argument("work", type=Path)
    ap.add_argument("--n", type=int, default=20000, help="queries: cards to write queries for")
    ap.add_argument("--gen-batch", type=int, default=64)
    ap.add_argument("--generator", default=GENERATOR, help="queries: the instruct model that writes them")
    ap.add_argument("--generator-revision", default=None, help="queries: defaults to the pinned one for the default generator")
    ap.add_argument("--llm-top", type=int, default=10, help="teacher: drop an LLM query unless its card is in the teacher's top N")
    ap.add_argument("--student", default="jhu-clsp/ettin-encoder-32m")
    ap.add_argument("--pooling", default="mean", choices=["mean", "cls"])
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank; 0 = full fine-tune")
    ap.add_argument("--name")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--negatives", type=int, default=7)
    ap.add_argument("--margin", type=float, default=0.02, help="teacher: negatives must score this far below the positive")
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--tau", type=float, default=0.05)
    ap.add_argument("--tau-teacher", type=float, default=0.05)
    ap.add_argument("--kl", type=float, default=1.0)
    ap.add_argument("--max-len", type=int, default=256)
    ap.add_argument("--run", help="export: the run's name under out/")
    ap.add_argument("--model", help="eval: an HF / sentence-transformers id, or a run's model dir")
    args = ap.parse_args()
    if args.stage == "queries":
        revision = args.generator_revision or (GENERATOR_REVISION if args.generator == GENERATOR else None)
        stage_queries(args.work, args.n, args.gen_batch, args.generator, revision)
    elif args.stage == "teacher":
        stage_teacher(args.work, args.negatives, args.margin, args.llm_top)
    elif args.stage == "train":
        stage_train(args.work, args)
    elif args.stage == "export":
        stage_export(args.work, args.run)
    else:
        print(json.dumps(evaluate(load_encoder(args.model), args.work / "data")))


if __name__ == "__main__":
    main()
