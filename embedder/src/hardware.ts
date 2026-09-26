import { readFileSync } from 'node:fs';
import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import {
  BUILTIN_MODELS,
  estimatePeakRssMb,
  MODEL_CATALOG,
  type ModelSpec,
  TIERS,
  type Tier,
} from './models.ts';

export interface HardwareProbe {
  readonly platform: string;
  readonly arch: string;
  readonly cores: number;
  readonly totalMemoryMb: number;
  /** Memory a new process can actually use now, cache that can be dropped included. */
  readonly availableMemoryMb: number;
}

const MB = 1024 * 1024;

/**
 * What the machine has. Only measured facts: an accelerator is never assumed from the platform
 * (that guess picks a model the machine cannot run), so this reports none until a session on one
 * has really been created, which is not yet supported.
 */
export function probeHardware(): HardwareProbe {
  return {
    platform: platform(),
    arch: arch(),
    cores: cpus().length,
    totalMemoryMb: totalmem() / MB,
    availableMemoryMb: availableMemoryBytes() / MB,
  };
}

/** `MemAvailable` on Linux, where `freemem` counts reclaimable cache as used. */
function availableMemoryBytes(): number {
  if (platform() !== 'linux') return freemem();
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return match?.[1] ? Number(match[1]) * 1024 : freemem();
  } catch {
    // A restricted container may not expose it: fall back to the portable figure.
    return freemem();
  }
}

export interface TierChoice {
  readonly tier: Tier;
  readonly spec: ModelSpec;
  /** Estimated peak memory of the chosen model, in megabytes. */
  readonly estimatedPeakMb: number;
  /** The memory the model was allowed to use, in megabytes. */
  readonly budgetMb: number;
  /** Whether even the chosen model is expected to fit. The lowest tier is chosen regardless. */
  readonly fits: boolean;
  /** Why, in a sentence a `doctor` command can print. */
  readonly reason: string;
}

export interface ChooseOptions {
  /**
   * How much of the available memory the encoder may use. A policy for the caller to set: the
   * rest is for the editor, the browser and the indexer itself. Defaults to one half.
   */
  readonly memoryFraction?: number;
  /** Leave out models above this many million parameters, when the machine has few cores. */
  readonly maxParamsM?: number;
}

const DEFAULT_MEMORY_FRACTION = 0.5;

/**
 * The most capable built-in model whose expected peak memory fits the share of available memory
 * it may take. The lowest tier is the floor: it is what runs where nothing else does, so it is
 * returned with `fits: false` and said so, rather than refusing to work.
 */
export function chooseTier(probe: HardwareProbe, options: ChooseOptions = {}): TierChoice {
  const fraction = options.memoryFraction ?? DEFAULT_MEMORY_FRACTION;
  const budgetMb = probe.availableMemoryMb * fraction;
  const candidates = [...TIERS].reverse().map((tier) => {
    const spec = BUILTIN_MODELS[tier];
    return { tier, spec, estimatedPeakMb: estimatePeakRssMb(spec.model.bytes) };
  });
  const cap = options.maxParamsM;
  const allowed =
    cap === undefined
      ? candidates
      : candidates.filter((candidate) => (candidate.spec.paramsM ?? 0) <= cap);

  const fitting = allowed.find((candidate) => candidate.estimatedPeakMb <= budgetMb);
  const floor = candidates.at(-1) as (typeof candidates)[number];
  const chosen = fitting ?? floor;
  const fits = fitting !== undefined;
  const memory = `${Math.round(probe.availableMemoryMb)} MB available, ${Math.round(budgetMb)} MB allowed`;
  return {
    tier: chosen.tier,
    spec: chosen.spec,
    estimatedPeakMb: chosen.estimatedPeakMb,
    budgetMb,
    fits,
    reason: fits
      ? `${chosen.spec.id} is expected to peak near ${Math.round(chosen.estimatedPeakMb)} MB (${memory})`
      : `even ${chosen.spec.id}, expected near ${Math.round(chosen.estimatedPeakMb)} MB, is over the allowance (${memory}); using it anyway as the smallest available`,
  };
}

/** One built-in model, as `init` shows it for this machine. */
export interface ModelAdvice {
  readonly spec: ModelSpec;
  /** Expected peak memory while embedding, in megabytes. */
  readonly estimatedPeakMb: number;
  readonly downloadMb: number;
  /** Expected to fit in the share of available memory the encoder may use. */
  readonly fits: boolean;
  /** The one to propose. */
  readonly recommended: boolean;
}

/** Few cores make embedding slow, so a big model is not proposed however much memory there is. */
function paramsCapFor(cores: number): number | undefined {
  if (cores <= 2) return 40;
  if (cores <= 4) return 120;
  return undefined;
}

/**
 * Every built-in model ranked for this machine, and which one to propose. The proposal is the most
 * capable of the three standard tiers that fits in memory and is not too heavy for the cores; the
 * other models are offered as alternatives with the same facts. Only measured things decide: memory
 * available and cores, never a guessed accelerator.
 */
export function adviseModels(
  probe: HardwareProbe,
  options: ChooseOptions = {},
): {
  readonly recommended: ModelAdvice;
  readonly models: readonly ModelAdvice[];
  readonly reason: string;
} {
  const cap = options.maxParamsM ?? paramsCapFor(probe.cores);
  const choice = chooseTier(probe, {
    ...options,
    ...(cap === undefined ? {} : { maxParamsM: cap }),
  });
  const budgetMb = choice.budgetMb;
  const models = MODEL_CATALOG.map((spec): ModelAdvice => {
    const estimatedPeakMb = estimatePeakRssMb(spec.model.bytes);
    return {
      spec,
      estimatedPeakMb,
      downloadMb: (spec.model.bytes + spec.tokenizer.bytes) / (1024 * 1024),
      fits: estimatedPeakMb <= budgetMb,
      recommended: spec.id === choice.spec.id,
    };
  });
  const recommended = models.find((model) => model.recommended) as ModelAdvice;
  const limited =
    cap === undefined
      ? ''
      : `; ${probe.cores} cores, so models above ${cap}M parameters are not proposed`;
  return { recommended, models, reason: `${choice.reason}${limited}` };
}
