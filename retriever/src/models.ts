import type { Deadline } from '@sutras/code-lens-core';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import type { Embedder } from '@sutras/code-lens-dense';
import {
  BUILTIN_MODELS,
  builtinModel,
  chooseTier,
  estimatePeakRssMb,
  type HardwareProbe,
  type InstalledModel,
  ModelCache,
  ModelUnavailableError,
  openLocalEmbedder,
  probeHardware,
  resolveModel,
  TIERS,
  type Tier,
  type TierChoice,
} from '@sutras/code-lens-embedder';
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

/** The built-in models, and which are installed in this cache. */
export async function listModels(cache: ModelCache): Promise<readonly ModelRow[]> {
  const rows: ModelRow[] = [];
  for (const tier of TIERS) {
    const spec = BUILTIN_MODELS[tier];
    rows.push({
      id: spec.id,
      tier,
      dimensions: spec.dimensions,
      maxTokens: spec.maxTokens,
      sizeMb: Math.round(spec.model.bytes / 1024 / 1024),
      installed: (await cache.find(spec)) !== undefined,
      estimatedMemoryMb: Math.round(estimatePeakRssMb(spec.model.bytes)),
      license: spec.license,
      notes: spec.notes,
    });
  }
  return rows;
}

/**
 * Install a built-in model, from a directory on this machine, or by downloading the pinned files
 * when `download` is set. Neither is done unless asked for.
 */
export async function installModel(
  cache: ModelCache,
  id: string,
  options: {
    readonly from?: string;
    readonly download?: boolean;
    readonly deadline?: Deadline;
    readonly onProgress?: (file: string, received: number, expected: number) => void;
  },
): Promise<InstalledModel> {
  const spec = builtinModel(id);
  if (!spec) {
    throw new InvalidArgumentError(
      'model',
      `one of ${TIERS.map((t) => BUILTIN_MODELS[t].id).join(', ')}`,
      id,
    );
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

export { ModelCache, modelsDirectory } from '@sutras/code-lens-embedder';
