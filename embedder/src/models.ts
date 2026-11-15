/**
 * The encoders anvesa knows how to fetch and run, and how much machine each one needs.
 *
 * Tiers order by compute cost. Within the catalog that is also the order of measured code-search
 * quality (anvesa-gen-lab). Vectors are stored under the model's id, so two models can be held side
 * by side.
 */

import type { ModelSpec, Tier } from './model-spec.ts';
import { MODEL_CONFIGS } from './models.generated.ts';
import { buildRegistry } from './registry.ts';

export type { CardForm, ModelFileSpec, ModelSpec, Pooling, Tier } from './model-spec.ts';

export const TIERS: readonly Tier[] = ['low', 'medium', 'high'];

/**
 * The built-in models, read from `embedder/models/<id>.json` through the registry (see
 * `registry.ts`). The anvesa-code encoders are Ettin-encoder (jhu-clsp, MIT) fine-tuned by
 * anvesa-gen-lab; each file's notes give the measurements behind its place in the catalog.
 */
const REGISTRY = buildRegistry(MODEL_CONFIGS);

/**
 * The built-in models by cost. Automatic choice is the low tier, anvesa-code-150m: it runs well on a
 * CPU and scores 0.626 MRR on anvesa-gen-lab's hand-written queries (MiniLM, the old default: 0.547).
 * The 400m (0.684) and the 1B (0.685) are used when named, or when they are all that is installed.
 */
export const BUILTIN_MODELS: Readonly<Record<Tier, ModelSpec>> = REGISTRY.byTier;

/** The tier automatic choice uses. */
export const DEFAULT_TIER: Tier = 'low';

/**
 * Open-licence models anvesa can fetch and pin besides its own: listed by `model list`, installed
 * with `model install <id> --download`, used only when named. Never chosen automatically.
 */
export const OPEN_MODELS: readonly ModelSpec[] = REGISTRY.open;

/** Built in beyond the tiers: the open models. */
export const ADDITIONAL_MODELS: readonly ModelSpec[] = OPEN_MODELS;

/** Where a model comes from, as `model list` groups them. */
export type ModelFamily = 'anvesa-code' | 'open' | 'custom';

export function modelFamily(id: string): ModelFamily {
  return REGISTRY.configs.find((config) => config.spec.id === id)?.family ?? 'custom';
}

export const ANVESA_CODE_MODELS: readonly ModelSpec[] = REGISTRY.anvesaCode;

/**
 * Models that were built in and are not any more, and what to use instead: each replacement's
 * config lists the ids it took over (`retired`).
 */
export const RETIRED_MODELS: Readonly<Record<string, string>> = REGISTRY.retired;

/** Every built-in model: anvesa's own smallest first (so the default leads), then the open ones. */
export const MODEL_CATALOG: readonly ModelSpec[] = [
  ...TIERS.map((tier) => BUILTIN_MODELS[tier]).sort((a, b) => weightBytes(a) - weightBytes(b)),
  ...[...ADDITIONAL_MODELS].sort((a, b) => weightBytes(a) - weightBytes(b)),
];

/** The bytes of a model's weights: its ONNX file and, for a model over 2 GB, the external weights beside it. */
export function weightBytes(spec: ModelSpec): number {
  return spec.model.bytes + (spec.modelData?.bytes ?? 0);
}

export function builtinModel(id: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((spec) => spec.id === id);
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
