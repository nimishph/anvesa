/**
 * The encoders medha knows how to fetch and run, and how much machine each one needs.
 *
 * Tiers order by compute cost, not by retrieval quality: a bigger model is not automatically a
 * better one for code, and nothing here has been measured on code retrieval yet. That is what the
 * eval is for. Vectors are stored under the model's id, so two models can be held side by side.
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
}

/** Same tokenizer file for the two BGE models: one SHA-256 pinned once. */
const BGE_TOKENIZER: ModelFileSpec = {
  path: 'tokenizer.json',
  bytes: 711396,
  sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
};

export const BUILTIN_MODELS: Readonly<Record<Tier, ModelSpec>> = {
  low: {
    id: 'all-MiniLM-L6-v2',
    tier: 'low',
    repo: 'Xenova/all-MiniLM-L6-v2',
    model: {
      path: 'onnx/model_quantized.onnx',
      bytes: 22972370,
      sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
    },
    tokenizer: {
      path: 'tokenizer.json',
      bytes: 711661,
      sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
    },
    dimensions: 384,
    maxTokens: 256,
    pooling: 'mean',
    paramsM: 22,
    license: 'Apache-2.0',
    notes:
      'Runs anywhere, CPU only. An English sentence encoder whose vocabulary fragments ' +
      'identifiers; its 256-token window fits symbol cards (signature, documentation, path) ' +
      'but not raw function bodies.',
  },
  medium: {
    id: 'bge-base-en-v1.5',
    tier: 'medium',
    repo: 'Xenova/bge-base-en-v1.5',
    model: {
      path: 'onnx/model.onnx',
      bytes: 435811539,
      sha256: '9bc579acdba21c253c62a9bf866891355a63ffa3442b52c8a37d75b2ccb91848',
    },
    tokenizer: BGE_TOKENIZER,
    dimensions: 768,
    maxTokens: 512,
    pooling: 'cls',
    paramsM: 109,
    license: 'MIT',
    notes:
      'A strong general retriever; the 512-token window takes nearly every symbol card whole. ' +
      'English-centric: identifiers ride on word decomposition, not code training.',
  },
  high: {
    id: 'bge-large-en-v1.5',
    tier: 'high',
    repo: 'Xenova/bge-large-en-v1.5',
    model: {
      path: 'onnx/model.onnx',
      bytes: 1336854281,
      sha256: '69ed3f810d3b6d13f70dff9ca89966f39c0a0e877fb88211be7bcc070df2a2ce',
    },
    tokenizer: BGE_TOKENIZER,
    dimensions: 1024,
    maxTokens: 512,
    pooling: 'cls',
    paramsM: 335,
    license: 'MIT',
    notes:
      'The largest and slowest built-in. The extra parameters buy finer separation on large ' +
      'mixed corpora (code and prose); it is not a better code searcher by construction.',
  },
};

const MINILM_TOKENIZER: ModelFileSpec = BUILTIN_MODELS.low.tokenizer;

/**
 * Built-in models beyond the three that automatic choice picks from. They are offered by `init`
 * and by `--model <id>`, never chosen silently: which of them retrieves code best on a given
 * repository is for the eval to say. Files come from the same Hugging Face mirrors, pinned by size
 * and SHA-256 (the model hashes are the ones the hub publishes for each file).
 */
export const ADDITIONAL_MODELS: readonly ModelSpec[] = [
  {
    id: 'all-MiniLM-L12-v2',
    tier: undefined,
    repo: 'Xenova/all-MiniLM-L12-v2',
    model: {
      path: 'onnx/model_quantized.onnx',
      bytes: 34014366,
      sha256: 'f51725bc66b2bf5335cacb5c005763b57bcd741172372795819741cd945a9dd9',
    },
    tokenizer: MINILM_TOKENIZER,
    dimensions: 384,
    maxTokens: 256,
    pooling: 'mean',
    paramsM: 33,
    license: 'Apache-2.0',
    notes:
      'MiniLM with twice the layers of the low tier, quantised, still CPU-friendly. A modest step up ' +
      'in accuracy for about 10 MB more memory than all-MiniLM-L6-v2.',
  },
  {
    id: 'bge-small-en-v1.5',
    tier: undefined,
    repo: 'Xenova/bge-small-en-v1.5',
    model: {
      path: 'onnx/model_quantized.onnx',
      bytes: 34014426,
      sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
    },
    tokenizer: BGE_TOKENIZER,
    dimensions: 384,
    maxTokens: 512,
    pooling: 'cls',
    paramsM: 33,
    license: 'MIT',
    notes:
      'The small BGE retriever, quantised: a 512-token window (whole symbol cards) at low-tier cost. ' +
      'The best default for a laptop that cannot spare the base model.',
  },
  {
    id: 'gte-small',
    tier: undefined,
    repo: 'Xenova/gte-small',
    model: {
      path: 'onnx/model_quantized.onnx',
      bytes: 34014426,
      sha256: '18dec105109b6004369799ca4761fb8fb413c64172c02147bcfac186b5c5f6cb',
    },
    tokenizer: MINILM_TOKENIZER,
    dimensions: 384,
    maxTokens: 512,
    pooling: 'mean',
    paramsM: 33,
    license: 'MIT',
    notes: 'General text embeddings from Alibaba DAMO, small and quantised; a 512-token window.',
  },
  {
    id: 'gte-base',
    tier: undefined,
    repo: 'Xenova/gte-base',
    model: {
      path: 'onnx/model_quantized.onnx',
      bytes: 110083337,
      sha256: '699c5233f2ed9e7230af2d0cb7a50d364fa40d0f72f8312cad74d86a38676637',
    },
    tokenizer: MINILM_TOKENIZER,
    dimensions: 768,
    maxTokens: 512,
    pooling: 'mean',
    paramsM: 109,
    license: 'MIT',
    notes:
      'Base-size GTE, quantised: a quarter of the download of bge-base-en-v1.5 for a similar class ' +
      'of retrieval.',
  },
  {
    id: 'jina-embeddings-v2-base-code',
    tier: undefined,
    repo: 'jinaai/jina-embeddings-v2-base-code',
    model: {
      path: 'onnx/model_quantized.onnx',
      bytes: 161895621,
      sha256: 'ed45870251c9f0cf656e78aab0d37a23489066df8a222bb1c8caf8a45f2cb16d',
    },
    tokenizer: {
      path: 'tokenizer.json',
      bytes: 2561316,
      sha256: 'b01c78a902aa4facb2f47f95449f48e2f7bbfea5d2472ee2f6ce92323c6f86e5',
    },
    dimensions: 768,
    maxTokens: 1024,
    pooling: 'mean',
    paramsM: 161,
    license: 'Apache-2.0',
    notes:
      'Trained on code and docstrings in thirty programming languages, so identifiers are not ' +
      'fragmented the way an English sentence encoder does. Its window is 8192 tokens; 1024 is ' +
      'used here, which holds whole functions.',
  },
];

/** Every built-in model, smallest download first. */
export const MODEL_CATALOG: readonly ModelSpec[] = [
  ...TIERS.map((tier) => BUILTIN_MODELS[tier]),
  ...ADDITIONAL_MODELS,
].sort((a, b) => a.model.bytes - b.model.bytes);

export function builtinModel(id: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((spec) => spec.id === id);
}

/**
 * A model anvesa knows how to run but does not download: its weights are brought by the user
 * (`anvesa model install <id> --from <dir>`), and the install takes pooling, window and card form
 * from here instead of asking for them. The files are pinned at that first install, as for any
 * model brought in.
 */
export interface ModelRecipe {
  readonly id: string;
  readonly pooling: Pooling;
  readonly maxTokens: number;
  readonly cardForm?: CardForm;
  readonly paramsM: number;
  readonly license: string;
  /** Where the weights come from and how they become ONNX. */
  readonly source: string;
  readonly notes: string;
}

/** How anvesa-gen-lab made every anvesa-code size: the same data, recipe and export. */
const ANVESA_CODE_SOURCE = (size: string): string =>
  `Ettin-encoder-${size} (jhu-clsp, MIT) fine-tuned by anvesa-gen-lab on 105 MIT-licensed repositories ` +
  '(corpus_train.py; the smaller sizes also learn from the 1B fine-tune as a teacher); a Hugging Face ' +
  'Transformers ' +
  'folder exported to ONNX by onnx_export.py (model.onnx and model.onnx_data, fp32).';

/**
 * The anvesa-code encoders: one recipe at three sizes. Numbers are anvesa-gen-lab's (2026-10-29),
 * first stage with the hub penalty and no ranker, on the corpus test set (1,710 generated queries,
 * 57 repos, 13 languages) and the 241 hand-written bench queries; CPU time is one card on 12
 * threads. All three embed symbol cards without the WQL path line.
 */
export const MODEL_RECIPES: readonly ModelRecipe[] = [
  {
    id: 'anvesa-code-400m',
    pooling: 'mean',
    maxTokens: 512,
    cardForm: 'nopath',
    paramsM: 400,
    license: 'MIT',
    source: ANVESA_CODE_SOURCE('400m'),
    notes:
      'The recommended size: 0.349 MRR on the corpus test set and 0.684 on the bench, level with ' +
      'the 1B (paired differences -0.003 and -0.001, both intervals around 0), at half its CPU ' +
      'time (190 ms a card) and about 1.6 GB in fp32. MiniLM scores 0.293 and 0.547.',
  },
  {
    id: 'anvesa-code-150m',
    pooling: 'mean',
    maxTokens: 512,
    cardForm: 'nopath',
    paramsM: 150,
    license: 'MIT',
    source: ANVESA_CODE_SOURCE('150m'),
    notes:
      'For machines without a GPU: 69 ms a card on a CPU, about 0.6 GB. 0.301 MRR on the corpus ' +
      'test set and 0.626 on the bench: below the 400m (about -0.05 on both) but well above ' +
      'MiniLM on hand-written queries (0.547).',
  },
  {
    id: 'anvesa-code-1b',
    pooling: 'mean',
    maxTokens: 512,
    cardForm: 'nopath',
    paramsM: 1000,
    license: 'MIT',
    source: ANVESA_CODE_SOURCE('1B'),
    notes:
      '0.352 MRR on the corpus test set and 0.685 on the bench: no measurable gain over the 400m ' +
      'for twice its CPU time (407 ms a card) and about 4 GB in fp32. Index on a GPU ' +
      '(ANVESA_DEVICE=gpu) where there is one.',
  },
];

export function modelRecipe(id: string): ModelRecipe | undefined {
  return MODEL_RECIPES.find((recipe) => recipe.id === id);
}

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
