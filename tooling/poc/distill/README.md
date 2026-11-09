# Distillation PoC: jina-v2-code (WQL path) → a small modern encoder

Goal: index as fast as all-MiniLM-L6-v2 does today, but rank like jina-v2-code on WQL-path cards.

| model (anvesa ONNX, commerce, 43 queries) | MRR |
|---|---|
| all-MiniLM-L6-v2 (default today) | 0.649 |
| gte-small + WQL path | 0.700 |
| jina-v2-code + WQL path (**teacher**) | 0.775 |

## Pipeline

Local (needs bun, git, Python with torch/transformers/sentence-transformers):

```
python export_cards.py <anvesa-worktree> <work>          # clone repos.json, index each with anvesa, dump WQL-path cards
python make_pairs.py <work> <commerce-wql index.db>       # corpus, doc-derived pairs, commerce test set
python bundle.py <work>                                    # -> <work>/distill_bundle.zip
```

Colab (T4), `distill.ipynb`; every stage is resumable and writes to `WORK` on Drive:

1. `train.py queries`: Qwen2.5-Coder-1.5B-Instruct writes a search query per card. There are only about 200 usable doc pairs per repo, and they read like docs rather than like what people type.
2. `train.py teacher`: jina-v2-code embeds every card, full and without its doc. It mines hard negatives from the same repo and records the teacher's scores. Negatives the teacher scores within `--margin` of the positive are dropped as likely false negatives.
3. `train.py train`: loss = InfoNCE over the in-batch candidates (τ = 0.05) + λ·KL(teacher ‖ student) over each query's own candidates.
4. `train.py export`: fp32 ONNX (`input_ids`, `attention_mask` → `last_hidden_state`); anvesa does the pooling.

Install a result: `anvesa model install <name> --from <dir with model.onnx + tokenizer.json> --pooling mean`.

## Choices

**Students: Ettin** (`jhu-clsp/ettin-encoder-17m` and `-32m`, MIT). These are ModernBERT-recipe encoders (RoPE, GeGLU, 8k context, modern data). The size was picked by a CPU indexing-time gate (`speed_gate.py`) on anvesa's 3,698 cards:

| model | params | time (int8) | zero-shot MRR |
|---|---|---|---|
| all-MiniLM-L6-v2 | 23M | 42 s | 0.656 |
| ettin-encoder-17m | 17M | 41 s | — |
| ettin-encoder-32m | 32M | 84 s | — |
| ettin-encoder-68m | 68M | 216 s | — |
| granite-embedding-small-english-r2 | 48M | 141 s | 0.591 |
| gte-modernbert-base | 149M | 617 s | — |
| granite-embedding-english-r2 | 149M | 947 s | 0.646 |

On ORT CPU, ModernBERT-family models are slower than BERT models of the same size: ORT's fused attention targets BERT, and the Ettin models are deeper. Only 17m and 32m fit the indexing-time goal. These times are for int8; fp32, which the students must ship as (see below), is about 20% slower on the 17m model.

**Full fine-tune by default; LoRA as a comparison.** `--lora R` wraps the student with PEFT `LoraConfig(r=R, lora_alpha=2R, lora_dropout=0.05, target_modules="all-linear")`. Before export the adapter is merged (`merge_and_unload`). At 17–32M parameters a full fine-tune is cheap and usually better. LoRA becomes interesting for shipping per-language or per-repo adapters on one base.

**Repos** (`repos.json`): 19 small, well-documented libraries in 7 languages. ky, httpx, gin and gson are the validation split. Commerce is the test set and is never trained on.

## Findings so far

- **Do not quantize these students to int8.** Dynamic int8 took the trained ettin-17m from 0.402 to 0.019 MRR; the MatMul-only, per-channel and u8 variants scored 0.02–0.14. fp32 ONNX reproduces the PyTorch score exactly.
- Smoke test: ettin-17m, 558 doc pairs from 3 repos, 2 epochs on a GTX 1050. Commerce MRR went 0.111 → 0.403; held-out docs went 0.414 → 0.776 (teacher 0.822). The training works, but it needs the full data and the LLM queries to approach the teacher.
- Teacher scores had to be computed on doc-free negatives as well as doc-free positives. Otherwise the teacher ranked the positive first for only 27% of the doc pairs.
