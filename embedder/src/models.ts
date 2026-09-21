/**
 * The encoders code-lens knows how to fetch and run, and how much machine each one needs.
 *
 * Tiers order by compute cost, not by retrieval quality: a bigger model is not automatically a
 * better one for code, and nothing here has been measured on code retrieval yet. That is what the
 * eval is for. Vectors are stored under the model's id, so two models can be held side by side.
 */

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
  readonly tokenizer: ModelFileSpec;
  /** Declared output size. The loader reads the real one from the model and refuses a mismatch. */
  readonly dimensions: number;
  /** Input window, in tokens, special tokens included. */
  readonly maxTokens: number;
  readonly pooling: Pooling;
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

export function builtinModel(id: string): ModelSpec | undefined {
  return TIERS.map((tier) => BUILTIN_MODELS[tier]).find((spec) => spec.id === id);
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
