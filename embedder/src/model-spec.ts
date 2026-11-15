/** The shape of a model spec: shared by the registry, the cache and the catalog. */

import type { CardForm } from '@cntxt-labs/anvesa-dense';

export type { CardForm };

export type Tier = 'low' | 'medium' | 'high';

export type Pooling =
  /** Average of the token states over the real (unpadded) tokens. */
  | 'mean'
  /** The state of the first token, `[CLS]`. */
  | 'cls';

/** One file of a model, pinned by its exact size and SHA-256. */
export interface ModelFileSpec {
  /** Path inside the upstream repository. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ModelSpec {
  /** Stable id, used in config, on disk, and as the model key of stored vectors. */
  readonly id: string;
  readonly tier: Tier | undefined;
  /** Upstream repository the files come from. */
  readonly repo: string;
  /**
   * The upstream commit the files are fetched at. Absent: `main`, for repositories anvesa
   * publishes. A model from someone else's repository is pinned, so a later push there cannot turn
   * an install into a checksum failure.
   */
  readonly revision?: string;
  readonly model: ModelFileSpec;
  /**
   * The weights of a model too large for one ONNX file (over 2 GB), kept beside it under the name
   * the model refers to them by. Absent for a model that is one file.
   */
  readonly modelData?: ModelFileSpec;
  readonly tokenizer: ModelFileSpec;
  /**
   * The learned ranker fit on this encoder's scores (an XGBoost JSON model), which reorders the top
   * of symbol search. Absent: symbols are ranked by the hub-penalised first stage alone.
   */
  readonly ranker?: ModelFileSpec;
  /** Declared output size. The loader reads the real one from the model and refuses a mismatch. */
  readonly dimensions: number;
  /** Input window, in tokens, special tokens included. */
  readonly maxTokens: number;
  readonly pooling: Pooling;
  /** How cards are reshaped before this model embeds them. Absent: as indexed. */
  readonly cardForm?: CardForm;
  /** Parameters, in millions: the honest proxy for compute cost. Unknown for a model brought in. */
  readonly paramsM: number | undefined;
  readonly license: string;
  readonly notes: string;
  /** What the model is good for, in a few words, for a table row. Built-in models have one. */
  readonly summary?: string;
}
