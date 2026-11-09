import { describe, expect, test } from 'bun:test';
import type { InstalledModel } from './cache.ts';
import { ModelCache } from './cache.ts';
import { ModelUnavailableError } from './errors.ts';
import type { HardwareProbe } from './hardware.ts';
import {
  BUILTIN_MODELS,
  estimatePeakRssMb,
  type ModelSpec,
  TIERS,
  type Tier,
  weightBytes,
} from './models.ts';
import { resolveModel } from './open.ts';

/** Reports exactly the given tiers as installed, with no files on disk at all. */
class FakeCache extends ModelCache {
  readonly #installed: ReadonlySet<Tier>;

  constructor(installed: readonly Tier[]) {
    super('/unused');
    this.#installed = new Set(installed);
  }

  override async find(spec: ModelSpec): Promise<InstalledModel | undefined> {
    if (spec.tier === undefined || !this.#installed.has(spec.tier)) return undefined;
    return { id: spec.id, directory: '', modelPath: '', tokenizerPath: '' };
  }
}

/** A probe whose memory alone drives `chooseTier` to `tier`. */
function probeFor(tier: Tier): HardwareProbe {
  // chooseTier budgets half of available memory by default: 20% over this tier's expected peak
  // clears it and not the tier above, whose model is more than twice the size.
  const peakMb = estimatePeakRssMb(weightBytes(BUILTIN_MODELS[tier]));
  return {
    platform: 'linux',
    arch: 'x64',
    cores: 8,
    totalMemoryMb: 999_999,
    availableMemoryMb: (peakMb * 1.2) / 0.5,
  };
}

describe('choosing a built-in model automatically', () => {
  test('the default, anvesa-code-150m, even when everything is installed and the machine is roomy', async () => {
    const cache = new FakeCache(['low', 'medium', 'high']);
    const resolved = await resolveModel(cache, { probe: probeFor('high') });
    expect(resolved.spec.id).toBe('anvesa-code-150m');
  });

  test('a larger installed tier, when nothing at or below the suited one is installed', async () => {
    const cache = new FakeCache(['high']);
    const resolved = await resolveModel(cache, { probe: probeFor('low') });
    expect(resolved.spec.id).toBe(BUILTIN_MODELS.high.id);
    expect(resolved.reason).toContain('larger than expected to fit comfortably');
  });

  test('the closer of two larger installed tiers is preferred', async () => {
    const cache = new FakeCache(['medium', 'high']);
    const resolved = await resolveModel(cache, { probe: probeFor('low') });
    expect(resolved.spec.id).toBe(BUILTIN_MODELS.medium.id);
  });

  test('nothing installed at all is refused, listing every tier it looked in', async () => {
    const cache = new FakeCache([]);
    const failure = await resolveModel(cache, { probe: probeFor('medium') }).catch((e) => e);
    expect(failure).toBeInstanceOf(ModelUnavailableError);
    expect(failure.context?.searched).toHaveLength(TIERS.length);
  });
});

describe('a model that is no longer built in', () => {
  test('is refused by name with what replaced it', async () => {
    const failure = await resolveModel(new FakeCache(['medium']), {
      model: 'bge-base-en-v1.5',
    }).catch((e) => e);
    expect(failure.message).toContain('anvesa-code-150m');
    expect(failure.message).toContain('no longer built in');
  });
});
