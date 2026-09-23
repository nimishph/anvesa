import type { Deadline } from '@cntxt-labs/anvesa-core';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import type { Embedder } from '@cntxt-labs/anvesa-dense';
import {
  BUILTIN_MODELS,
  builtinModel,
  chooseTier,
  estimatePeakRssMb,
  type HardwareProbe,
  type InstalledModel,
  installCustomModel,
  ModelCache,
  type ModelSpec,
  ModelUnavailableError,
  openLocalEmbedder,
  type Pooling,
  probeHardware,
  resolveModel,
  TIERS,
  type Tier,
  type TierChoice,
} from '@cntxt-labs/anvesa-embedder';
import type { ProjectConfig } from './config.ts';

export interface ModelRow {
  readonly id: string;
  readonly tier: Tier | undefined;
  readonly dimensions: number;
  readonly maxTokens: number;
  readonly sizeMb: number;
  readonly installed: boolean;
  readonly estimatedMemoryMb: number;
  readonly license: string;
  readonly notes: string;
}

const rowOf = async (cache: ModelCache, spec: ModelSpec): Promise<ModelRow> => ({
  id: spec.id,
  tier: spec.tier,
  dimensions: spec.dimensions,
  maxTokens: spec.maxTokens,
  sizeMb: Math.round(spec.model.bytes / 1024 / 1024),
  installed: (await cache.find(spec)) !== undefined,
  estimatedMemoryMb: Math.round(estimatePeakRssMb(spec.model.bytes)),
  license: spec.license,
  notes: spec.notes,
});

/** The built-in models, and the ones the user brought in, with which are installed in this cache. */
export async function listModels(cache: ModelCache): Promise<readonly ModelRow[]> {
  const rows: ModelRow[] = [];
  for (const tier of TIERS) rows.push(await rowOf(cache, BUILTIN_MODELS[tier]));
  for (const spec of await cache.customModels()) rows.push(await rowOf(cache, spec));
  return rows;
}

export interface InstallModelOptions {
  /** A directory (or, for a model brought in, the `.onnx` file) on this machine. */
  readonly from?: string;
  /** Fetch a built-in model's pinned files. Never done unless asked for. */
  readonly download?: boolean;
  /** For a model brought in: how it pools, when its own files do not say. */
  readonly pooling?: Pooling;
  /** For a model brought in: its window in tokens, when its own files do not say. */
  readonly maxTokens?: number;
  /** For a model brought in: accept files that differ from an earlier install of the id. */
  readonly replace?: boolean;
  readonly deadline?: Deadline;
  readonly onProgress?: (file: string, received: number, expected: number) => void;
}

/**
 * Install a model. A built-in id comes from a directory on this machine, or by downloading the
 * pinned files when `download` is set. Any other id is a model the user brings, from a directory
 * or an `.onnx` file with its `tokenizer.json`: its checksums are pinned at this first install.
 */
export async function installModel(
  cache: ModelCache,
  id: string,
  options: InstallModelOptions,
): Promise<InstalledModel> {
  const spec = builtinModel(id);
  if (!spec) {
    if (options.from === undefined) {
      throw new InvalidArgumentError(
        'model',
        `a built-in model (${TIERS.map((t) => BUILTIN_MODELS[t].id).join(', ')}), or a new name with --from <dir|file.onnx> to bring in your own`,
        id,
      );
    }
    const installed = await installCustomModel(cache, {
      id,
      from: options.from,
      ...(options.pooling ? { pooling: options.pooling } : {}),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.replace ? { replace: true } : {}),
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });
    return cache.require(installed);
  }
  if (options.from !== undefined) {
    return cache.installFromDirectory(
      spec,
      options.from,
      options.deadline ? { deadline: options.deadline } : {},
    );
  }
  return cache.download(spec, {
    allowNetwork: options.download === true,
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

/** Read every file of an installed model and check it against the checksums it is pinned to. */
export async function verifyModel(
  cache: ModelCache,
  id: string,
  deadline?: Deadline,
): Promise<InstalledModel> {
  const spec = builtinModel(id) ?? (await cache.findCustom(id));
  if (!spec) {
    throw new InvalidArgumentError(
      'model',
      `one of ${(await listModels(cache)).map((row) => row.id).join(', ')}`,
      id,
    );
  }
  return cache.verify(spec, deadline);
}

export interface ModelDoctor {
  readonly probe: HardwareProbe;
  readonly choice: TierChoice;
  readonly models: readonly ModelRow[];
  /** What would be used for this project right now, or why nothing can be. */
  readonly resolved:
    | { readonly id: string; readonly reason: string }
    | { readonly problem: string };
}

export async function doctorModels(cache: ModelCache, config: ProjectConfig): Promise<ModelDoctor> {
  const probe = probeHardware();
  const choice = chooseTier(probe);
  const models = await listModels(cache);
  try {
    const resolved = await resolveModel(cache, {
      ...(config.model === undefined ? {} : { model: config.model }),
      probe,
    });
    return { probe, choice, models, resolved: { id: resolved.spec.id, reason: resolved.reason } };
  } catch (failure) {
    if (failure instanceof ModelUnavailableError) {
      return { probe, choice, models, resolved: { problem: failure.message } };
    }
    throw failure;
  }
}

export interface OpenedEmbedder {
  readonly embedder: (Embedder & { dispose(): Promise<void> }) | undefined;
  /** Which model and why, or why there is none. */
  readonly reason: string;
}

/**
 * The embedder a project should use: the model named in its config, else the most capable
 * installed one the machine suits. `undefined` (with the reason) when no model is installed, so a
 * project can still be searched structurally.
 */
export async function openProjectEmbedder(
  config: ProjectConfig,
  cache: ModelCache = new ModelCache(),
): Promise<OpenedEmbedder> {
  try {
    const resolved = await resolveModel(cache, {
      ...(config.model === undefined ? {} : { model: config.model }),
    });
    return { embedder: await openLocalEmbedder(resolved.spec, { cache }), reason: resolved.reason };
  } catch (failure) {
    if (failure instanceof ModelUnavailableError)
      return { embedder: undefined, reason: failure.message };
    throw failure;
  }
}

export { ModelCache, modelsDirectory } from '@cntxt-labs/anvesa-embedder';
