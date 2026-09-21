import { readFile } from 'node:fs/promises';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import { openOnnx } from './backend.ts';
import { ModelCache } from './cache.ts';
import { batchTokensFor, LocalEmbedder } from './encoder.ts';
import { ModelUnavailableError } from './errors.ts';
import { chooseTier, type HardwareProbe, probeHardware } from './hardware.ts';
import { BUILTIN_MODELS, builtinModel, type ModelSpec, TIERS } from './models.ts';
import { tokenizerFromJson } from './tokenizer.ts';

export interface OpenOptions {
  readonly cache?: ModelCache;
  /** Threads for one operator. Unset lets the runtime use every core. */
  readonly threads?: number;
  /**
   * Memory one batch may use for activations, in bytes. Unset, a tenth of what the machine has
   * available: the model's own weights are already resident, and this is the part that scales
   * with how many texts are embedded together.
   */
  readonly batchMemoryBytes?: number;
  readonly probe?: HardwareProbe;
}

const BYTES_PER_MB = 1024 * 1024;
/** Share of available memory a batch's activations may take when the caller does not say. */
const DEFAULT_BATCH_MEMORY_SHARE = 0.1;

/**
 * Open an installed model as an `Embedder`. The tokenizer is read from the model's own files, the
 * runtime is started, and one text is embedded to check the model really produces the number of
 * dimensions it is declared to: a mismatch is refused here, not discovered as corrupt search.
 */
export async function openLocalEmbedder(
  spec: ModelSpec,
  options: OpenOptions = {},
): Promise<LocalEmbedder> {
  const cache = options.cache ?? new ModelCache();
  const installed = await cache.require(spec);
  const tokenizer = tokenizerFromJson(
    await readFile(installed.tokenizerPath, 'utf8'),
    installed.tokenizerPath,
  );
  const backend = await openOnnx({
    modelId: spec.id,
    modelPath: installed.modelPath,
    ...(options.threads === undefined ? {} : { threads: options.threads }),
  });

  const probe = options.probe ?? probeHardware();
  const budget =
    options.batchMemoryBytes ?? probe.availableMemoryMb * BYTES_PER_MB * DEFAULT_BATCH_MEMORY_SHARE;
  const embedder = new LocalEmbedder({
    id: spec.id,
    dimensions: spec.dimensions,
    maxTokens: spec.maxTokens,
    pooling: spec.pooling,
    tokenizer,
    backend,
    maxBatchTokens: batchTokensFor(spec.dimensions, budget),
  });
  try {
    await embedder.embed(['dimension probe']);
  } catch (failure) {
    await embedder.dispose();
    throw failure;
  }
  return embedder;
}

export interface Resolution {
  readonly spec: ModelSpec;
  /** How it was decided, for a `doctor` or `status` line. */
  readonly reason: string;
}

/**
 * Which installed model to use. A named model is used if it is installed. Otherwise the most
 * capable built-in the machine is expected to hold, or, if that one is not installed, the most
 * capable installed one below it: a smaller model that is here beats a larger one that is not.
 */
export async function resolveModel(
  cache: ModelCache,
  options: {
    readonly model?: string;
    readonly probe?: HardwareProbe;
    readonly memoryFraction?: number;
  } = {},
): Promise<Resolution> {
  if (options.model !== undefined) {
    const spec = builtinModel(options.model);
    if (!spec) {
      throw new InvalidArgumentError(
        'model',
        `one of ${TIERS.map((tier) => BUILTIN_MODELS[tier].id).join(', ')}`,
        options.model,
      );
    }
    await cache.require(spec);
    return { spec, reason: `${spec.id} was asked for by name` };
  }

  const choice = chooseTier(options.probe ?? probeHardware(), {
    ...(options.memoryFraction === undefined ? {} : { memoryFraction: options.memoryFraction }),
  });
  const wantedIndex = TIERS.indexOf(choice.tier);
  const order = TIERS.slice(0, wantedIndex + 1).reverse();
  for (const tier of order) {
    const spec = BUILTIN_MODELS[tier];
    if (await cache.find(spec)) {
      return {
        spec,
        reason:
          tier === choice.tier
            ? choice.reason
            : `${choice.spec.id} suits this machine but is not installed; using ${spec.id}, which is`,
      };
    }
  }
  throw new ModelUnavailableError(
    choice.spec.id,
    `no built-in model is installed in ${cache.root}`,
    {
      context: { searched: order.map((tier) => cache.directoryOf(BUILTIN_MODELS[tier].id)) },
    },
  );
}
