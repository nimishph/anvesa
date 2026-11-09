/**
 * The encoders anvesa knows how to fetch and run, and how much machine each one needs.
 *
 * Tiers order by compute cost. Within the catalog that is also the order of measured code-search
 * quality (anvesa-gen-lab). Vectors are stored under the model's id, so two models can be held side
 * by side.
 */

import type { CardForm } from '@cntxt-labs/anvesa-dense';

export type { CardForm };

export type Tier = 'low' | 'medium' | 'high';

export const TIERS: readonly Tier[] = ['low', 'medium', 'high'];

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

/** The tokenizer every Ettin size shares (anvesa-code-1b, -400m and -150m publish the same file). */
const ETTIN_TOKENIZER: ModelFileSpec = {
  path: 'tokenizer.json',
  bytes: 3583387,
  sha256: '657af518d877b6422fa44277c008870520894bffcaea6490504ee426c57aa548',
};

/**
 * The anvesa-code encoders: Ettin-encoder (jhu-clsp, MIT) fine-tuned by anvesa-gen-lab on 105
 * MIT-licensed repositories, the 400m and 150m also learning from the 1B as a teacher; exported to
 * ONNX in fp32 with the weights in model.onnx_data. Mean pooling, 512 tokens, and symbol cards
 * embedded without their WQL path line. Numbers are anvesa-gen-lab's (2026-10-29): first stage with
 * the hub penalty and no ranker, on the corpus test set (1,710 generated queries, 57 repos, 13
 * languages) and the 241 hand-written bench queries; CPU time is one card on 12 threads. Each comes
 * with the learned ranker fit on its scores (ranker-noword.json, 20 features, no word overlap).
 */
const CODE_400M: ModelSpec = {
  id: 'anvesa-code-400m',
  tier: 'medium',
  repo: 'nimishph/anvesa-code-400m',
  model: {
    path: 'model.onnx',
    bytes: 798633,
    sha256: '018041c99d6572575a88330289dbab26d95b9514bb59625c731e6bf134e93310',
  },
  modelData: {
    path: 'model.onnx_data',
    bytes: 1579126784,
    sha256: 'd4155cb27211ff1c90d3dc1c2bcb13887ddc8a1bc78f4c93fea258161a25c75e',
  },
  tokenizer: ETTIN_TOKENIZER,
  ranker: {
    path: 'ranker-noword.json',
    bytes: 243592,
    sha256: 'e81c135ca4ff4decf37c1348b37f01feafb9203aabcc88fd180a2ee0d3d30670',
  },
  dimensions: 1024,
  maxTokens: 512,
  pooling: 'mean',
  cardForm: 'nopath',
  paramsM: 400,
  license: 'MIT',
  notes:
    'The recommended code model: 0.349 MRR on the corpus test set and 0.684 on the bench, level ' +
    'with the 1B (paired differences -0.003 and -0.001, both intervals around 0) at a quarter of ' +
    'its CPU time (98 ms a card) and about 1.6 GB. MiniLM scores 0.293 and 0.547.',
  summary: 'as good as the 1B at a quarter of its time',
};

const CODE_150M: ModelSpec = {
  id: 'anvesa-code-150m',
  tier: 'low',
  repo: 'nimishph/anvesa-code-150m',
  model: {
    path: 'model.onnx',
    bytes: 584370,
    sha256: '4e14bfb7b993bebe817e354559afe5d6971c4dbb4974f1168d847145b1c29de3',
  },
  modelData: {
    path: 'model.onnx_data',
    bytes: 596057088,
    sha256: '78c8202253b8d54565987e93a499e6c065be6d49018e0de2379876be6e975600',
  },
  tokenizer: ETTIN_TOKENIZER,
  ranker: {
    path: 'ranker-noword.json',
    bytes: 244225,
    sha256: '400012bb93db7c4a021e4a2ebd736d9a119532aa7b9a37126e09789063981e6e',
  },
  dimensions: 768,
  maxTokens: 512,
  pooling: 'mean',
  cardForm: 'nopath',
  paramsM: 150,
  license: 'MIT',
  notes:
    'For machines without a GPU: 40 ms a card on a CPU, about 0.6 GB. 0.301 MRR on the corpus ' +
    'test set and 0.626 on the bench: below the 400m (about -0.05 on both) but well above MiniLM ' +
    'on hand-written queries (0.547).',
  summary: 'the default; runs well on a CPU',
};

const CODE_1B: ModelSpec = {
  id: 'anvesa-code-1b',
  tier: 'high',
  repo: 'nimishph/anvesa-code-1b',
  model: {
    path: 'model.onnx',
    bytes: 1034044,
    sha256: 'df33320b7ea9a50823b04f5b189fa4077f72fa530274a36e9634d1e4e1cdeae1',
  },
  modelData: {
    path: 'model.onnx_data',
    bytes: 4112202752,
    sha256: '2bf8038ac17358a505091b27816beac37a32e64cf3d928212b36a634ef775805',
  },
  tokenizer: ETTIN_TOKENIZER,
  ranker: {
    path: 'ranker-noword.json',
    bytes: 244475,
    sha256: '7d49fa95580cb568be0bb1eb6105da9557bf91e3e4436dfbbc640d3efc2304ca',
  },
  dimensions: 1792,
  maxTokens: 512,
  pooling: 'mean',
  cardForm: 'nopath',
  paramsM: 1000,
  license: 'MIT',
  notes:
    '0.352 MRR on the corpus test set and 0.685 on the bench: no measurable gain over the 400m ' +
    'for four times its CPU time (373 ms a card) and about 4 GB. Index on a GPU ' +
    '(ANVESA_DEVICE=gpu) where there is one.',
  summary: 'best measured; needs a GPU',
};

/**
 * The built-in models by cost. Automatic choice is the low tier, anvesa-code-150m: it runs well on a
 * CPU and scores 0.626 MRR on anvesa-gen-lab's hand-written queries (MiniLM, the old default: 0.547).
 * The 400m (0.684) and the 1B (0.685) are used when named, or when they are all that is installed.
 */
export const BUILTIN_MODELS: Readonly<Record<Tier, ModelSpec>> = {
  low: CODE_150M,
  medium: CODE_400M,
  high: CODE_1B,
};

/** The tier automatic choice uses. */
export const DEFAULT_TIER: Tier = 'low';

/** Built in beyond the tiers. None at present. */
export const ADDITIONAL_MODELS: readonly ModelSpec[] = [];

export const ANVESA_CODE_MODELS: readonly ModelSpec[] = [CODE_400M, CODE_150M, CODE_1B];

/**
 * Models that were built in and are not any more, and what to use instead. On anvesa-gen-lab's 241
 * hand-written queries they scored at or below MiniLM (jina 0.533, gte-large 0.550, bge-m3 0.518,
 * MiniLM 0.547), against 0.626 for anvesa-code-150m and 0.684 for the 400m.
 */
export const RETIRED_MODELS: Readonly<Record<string, string>> = {
  'all-MiniLM-L6-v2': 'anvesa-code-150m',
  'all-MiniLM-L12-v2': 'anvesa-code-150m',
  'bge-small-en-v1.5': 'anvesa-code-150m',
  'gte-small': 'anvesa-code-150m',
  'gte-base': 'anvesa-code-150m',
  'jina-embeddings-v2-base-code': 'anvesa-code-150m',
  'bge-base-en-v1.5': 'anvesa-code-150m',
  'bge-large-en-v1.5': 'anvesa-code-400m',
};

/** Every built-in model, smallest download first. */
export const MODEL_CATALOG: readonly ModelSpec[] = [
  ...TIERS.map((tier) => BUILTIN_MODELS[tier]),
  ...ADDITIONAL_MODELS,
].sort((a, b) => weightBytes(a) - weightBytes(b));

/** The bytes of a model's weights: its ONNX file and, for a model over 2 GB, the external weights beside it. */
export function weightBytes(spec: ModelSpec): number {
  return spec.model.bytes + (spec.modelData?.bytes ?? 0);
}

export function builtinModel(id: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((spec) => spec.id === id);
}

/**
 * The built-in models, best for searching code first, by anvesa-gen-lab's measurements
 * (2026-10-29, MRR on 241 hand-written queries): anvesa-code-1b 0.685, -400m 0.684, -150m 0.626.
 * Nothing chooses a model by it; it only orders what is shown. Automatic choice stays the 150m.
 */
export const MODEL_RANKING: readonly string[] = [
  'anvesa-code-1b',
  'anvesa-code-400m',
  'anvesa-code-150m',
];

/** A model's place in `MODEL_RANKING`, from 1. Undefined for a model the user brought in. */
export function modelRank(id: string): number | undefined {
  const index = MODEL_RANKING.indexOf(id);
  return index === -1 ? undefined : index + 1;
}

/** Every built-in model, best first. A test holds the ranking to naming each one exactly once. */
export const MODELS_BY_RANK: readonly ModelSpec[] = MODEL_RANKING.flatMap((id) =>
  MODEL_CATALOG.filter((spec) => spec.id === id),
);

/**
 * Resident memory of this package running a model, after embedding a hundred lines of code, on
 * Windows x64: the 23 MB quantised MiniLM held 157 MB, the 436 MB bge-base 555 MB. (A whole
 * compiled program measured 362 and 811 MB in an earlier spike, which includes everything else
 * the program carries.)
 */
export const PEAK_RSS_MEASUREMENTS: readonly { modelMb: number; rssMb: number }[] = [
  { modelMb: 23, rssMb: 157 },
  { modelMb: 436, rssMb: 555 },
];

/**
 * What a model is expected to take, in megabytes, from its size on disk: the line through the
 * two measurements above. An estimate, used to choose a tier and to say so, never to refuse.
 */
export function estimatePeakRssMb(modelBytes: number): number {
  const [low, high] = PEAK_RSS_MEASUREMENTS as readonly [
    (typeof PEAK_RSS_MEASUREMENTS)[number],
    (typeof PEAK_RSS_MEASUREMENTS)[number],
  ];
  const slope = (high.rssMb - low.rssMb) / (high.modelMb - low.modelMb);
  const modelMb = modelBytes / 1024 / 1024;
  return low.rssMb + slope * (modelMb - low.modelMb);
}
