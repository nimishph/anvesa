# Symbol search with the Ettin fine-tune, a hub penalty and a learned ranker (experimental)

The setup anvesa-gen-lab measured best on 2026-10-28, behind `experimental.learnedRanker`:

| piece | what it does |
| --- | --- |
| encoder `ettin-code-1b` | Ettin-encoder-1B (MIT) fine-tuned on 105 MIT-licensed repositories. Mean pooling, L2-normalised, 512 tokens, no prefix. It embeds symbol cards without their WQL path line (`cardForm: "nopath"`); the stored card keeps it. |
| hub penalty | A symbol scores as its best card's `cos(query, card) - 0.3 x mean`, where `mean` is the card's mean cosine to its 10 nearest cards (itself left out). Measured at index time into `card_hub`. |
| learned ranker | An XGBoost LambdaMART model reorders the top 30 symbols from cheap features: the first-stage score and its gap to the top, the first card's cosine and hub penalty, BM25 of the card, query-word overlap with the name, path and card, kind, documentation, card length, path depth, same-file count, query length. Evaluated in TypeScript from the model's JSON. |

No intent cards. Results (anvesa-gen-lab `results/ettin-corpus/summary.md`): on the corpus test set (1,710 queries,
57 repositories, 13 languages) this scores 0.445 MRR, against 0.293 for MiniLM with the hub penalty; on the
241-query bench, 0.688 with a ranker cross-validated by repository.

## Use it

1. Get the ONNX export (anvesa-gen-lab `colab_ettin.py`, notebook `4_ship`): a folder with `model.onnx`,
   `model.onnx_data` (the weights, about 4 GB in fp32) and `tokenizer.json`, and the ranker
   `ranker-ettin-corpus.json`.
2. Install the model. The id `ettin-code-1b` is a known recipe, so pooling, window and card form need no flags:

   ```bash
   anvesa model install ettin-code-1b --from path/to/onnx
   ```

3. In `.anvesa/config.json`:

   ```json
   {
     "model": "ettin-code-1b",
     "experimental": {
       "cardPath": "wql",
       "learnedRanker": { "model": ".anvesa/ranker-ettin-corpus.json" }
     }
   }
   ```

   `cardPath: "wql"` makes the stored cards the ones the ranker was trained on (two features read the card as
   indexed, path line included). `hub` (default 0.3) and `depth` (default 30) can be set; without `model` the
   hub-penalised first stage ranks alone.

4. `anvesa index`, then search as usual. A 1B-parameter encoder is slow on a CPU: index on a GPU where there is
   one (`ANVESA_DEVICE=gpu`).

## Limits

- Only the symbols lane of `search` is ranked this way, and only with one index database (not with fragments).
  Conjunction searches and `retrieve` still use plain cosine.
- The hub means are recomputed over every symbol card whenever the symbol cards change: quadratic in the number of
  cards, and done at the end of `anvesa index`.
- Parity with the Python port is tested on a fixture written by anvesa-gen-lab `ranker_fixture.py` from
  `corpus_bench.py` itself (`retriever/src/learned-ranker.test.ts`). With real vectors a cosine can differ from
  numpy's in its last bit, which rarely flips a tree split.
