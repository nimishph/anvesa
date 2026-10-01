# Reciprocal Rank Fusion (RRF)

Reciprocal Rank Fusion (RRF) is the mathematical core Anvesa uses to blend heterogeneous search results into a single, unified ranking.

---

## The Multi-Lane Problem

In code search, different retrieval methods output incomparable scores:
- **Dense semantic search** outputs cosine similarities between `-1.0` and `1.0`.
- **Structural AST matching** produces boolean hits or AST depth matches without continuous scores.
- **Documentation search** scores term matches or BM25 frequencies.

Directly adding or multiplying these raw scores is fundamentally flawed because one lane's scale inevitably drowns another.

---

## The RRF Formula

Instead of combining raw scores, RRF combines **rank positions**:

$$\text{RRF Score}(d) = \sum_{l \in \text{Lanes}} \frac{w_l}{k + \text{rank}_l(d)}$$

Where:
- $w_l$ is the lane weight (default `1.0`).
- $\text{rank}_l(d)$ is the 1-based position of candidate $d$ in lane $l$.
- $k$ is the smoothing constant (default `k = 60`).

### Why $k = 60$?
The constant $60$ prevents the absolute top hit of one lane from overwhelmingly dominating candidates that appear consistently near the top of several independent lanes:
- An item that is **#2 in dense** and **#1 in structural** outscores an item that is **#1 in dense** but missing from structural.

---

## Score Interpretation

When examining search results in Anvesa:

1. **`score` (Fused RRF Score):**
   - Represents relative ranking position across lanes for this specific query.
   - **Never compare `score` across different queries.** A score of `0.032` on query A and `0.032` on query B does not mean they are equally confident.
2. **`bestScore` (Raw Cosine Similarity):**
   - The highest real cosine similarity (0.0 to 1.0) reported by a semantic lane.
   - Use `bestScore` to determine whether a match is genuinely relevant or just the best of a poor set.

---

## Lane Filtering Best Practice

To omit irrelevant channels (like documentation or generated mocks), **prefer boolean exclusion over tiny weights**:

```sh
# Recommended: completely excludes docs from consideration
anvesa search "auth handler" --exclude docs

# Or in .anvesa/config.json:
{
  "search": {
    "excludeLanes": ["docs"]
  }
}
```
Setting `weight = 0.001` still allows noise to leak into the tail; `--exclude` cleanly drops the lane.
