import { describe, expect, test } from 'bun:test';
import {
  adviseModels,
  chooseTier,
  type HardwareProbe,
  parseVmStat,
  probeHardware,
} from './hardware.ts';
import {
  BUILTIN_MODELS,
  builtinModel,
  DEFAULT_TIER,
  estimatePeakRssMb,
  MODEL_CATALOG,
  MODEL_RANKING,
  MODELS_BY_RANK,
  modelRank,
  TIERS,
  weightBytes,
} from './models.ts';

const machine = (availableMemoryMb: number): HardwareProbe => ({
  platform: 'linux',
  arch: 'x64',
  cores: 8,
  totalMemoryMb: availableMemoryMb * 2,
  availableMemoryMb,
});

describe('memory estimates', () => {
  test('pass through the two measurements they are drawn from', () => {
    expect(Math.round(estimatePeakRssMb(23 * 1024 * 1024))).toBe(157);
    expect(Math.round(estimatePeakRssMb(436 * 1024 * 1024))).toBe(555);
  });

  test('grow with the size of the model', () => {
    const [low, medium, high] = TIERS.map((tier) =>
      estimatePeakRssMb(weightBytes(BUILTIN_MODELS[tier])),
    );
    expect(low).toBeLessThan(medium as number);
    expect(medium).toBeLessThan(high as number);
  });
});

describe('choosing a tier from the machine', () => {
  test('by default every machine gets anvesa-code-150m, however much it could hold', () => {
    const choice = chooseTier(machine(32 * 1024));
    expect(choice.tier).toBe(DEFAULT_TIER);
    expect(choice.fits).toBe(true);
    expect(choice.reason).toContain('anvesa-code-150m');
  });

  test('allowed bigger tiers, a generous machine gets the most capable model', () => {
    const choice = chooseTier(machine(32 * 1024), { maxTier: 'high' });
    expect(choice.tier).toBe('high');
    expect(choice.reason).toContain('anvesa-code-1b');
  });

  test('a constrained machine gets a smaller one, chosen by the estimate and the allowance', () => {
    // Half of 4000 MB is 2000: room for the 400m (about 1,590), not for the 1B (about 3,915).
    expect(chooseTier(machine(4000), { maxTier: 'high' }).tier).toBe('medium');
    // Half of 1500 MB is 750: room for the 150m (about 683) only.
    expect(chooseTier(machine(1500), { maxTier: 'high' }).tier).toBe('low');
  });

  test('the share of memory the encoder may take is the caller’s to set', () => {
    expect(chooseTier(machine(4000), { maxTier: 'high', memoryFraction: 0.2 }).tier).toBe('low');
    expect(chooseTier(machine(4000), { maxTier: 'high', memoryFraction: 0.9 }).tier).toBe('medium');
  });

  test('when nothing fits the smallest is used anyway, and the answer says it did not fit', () => {
    const choice = chooseTier(machine(100));
    expect(choice.tier).toBe('low');
    expect(choice.fits).toBe(false);
    expect(choice.reason).toContain('over the allowance');
  });

  test('a machine is never promoted on a guess: the probe carries no accelerator claim', () => {
    const probe = probeHardware();
    expect(Object.keys(probe).sort()).toEqual([
      'arch',
      'availableMemoryMb',
      'cores',
      'platform',
      'totalMemoryMb',
    ]);
  });
});

describe('the probe', () => {
  test('reports real, sensible numbers for this machine', () => {
    const probe = probeHardware();
    expect(probe.cores).toBeGreaterThan(0);
    expect(probe.totalMemoryMb).toBeGreaterThan(0);
    expect(probe.availableMemoryMb).toBeGreaterThan(0);
    expect(probe.availableMemoryMb).toBeLessThanOrEqual(probe.totalMemoryMb);
  });
});

describe('available memory on macOS', () => {
  // A 16 GB Apple Silicon machine with about half its memory reclaimable: `freemem` said 135 MB.
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                8640.',
    'Pages active:                            401264.',
    'Pages inactive:                          389120.',
    'Pages speculative:                         4816.',
    'Pages throttled:                              0.',
    'Pages wired down:                        152390.',
    'Pages purgeable:                          21077.',
  ].join('\n');

  test('counts free, speculative and inactive pages, which the system hands out on demand', () => {
    expect(parseVmStat(vmStat)).toBe((8640 + 389120 + 4816) * 16384);
    expect((parseVmStat(vmStat) as number) / (1024 * 1024)).toBeGreaterThan(6000);
  });

  test('output it cannot read is no measurement, not zero', () => {
    expect(parseVmStat('')).toBeUndefined();
    expect(parseVmStat('Pages free: 10.')).toBeUndefined();
  });
});

describe('the built-in catalogue', () => {
  test('every model is pinned by size and a SHA-256, and found by id', () => {
    for (const tier of TIERS) {
      const spec = BUILTIN_MODELS[tier];
      expect(spec.model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.tokenizer.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.model.bytes).toBeGreaterThan(0);
      expect(builtinModel(spec.id)).toBe(spec);
    }
    expect(builtinModel('nope')).toBeUndefined();
  });

  test('every tier averages its token states; the code encoders embed cards without the path line', () => {
    for (const tier of TIERS) expect(BUILTIN_MODELS[tier].pooling).toBe('mean');
    for (const tier of TIERS) expect(BUILTIN_MODELS[tier].cardForm).toBe('nopath');
  });
});

describe('the built-in catalog and what init proposes', () => {
  const probeOf = (cores: number, availableMemoryMb: number): HardwareProbe => ({
    platform: 'linux',
    arch: 'x64',
    cores,
    totalMemoryMb: availableMemoryMb * 2,
    availableMemoryMb,
  });

  test('every model has a unique id, pinned files and a declared window', () => {
    const ids = MODEL_CATALOG.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
    for (const spec of MODEL_CATALOG) {
      expect(spec.model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.tokenizer.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(weightBytes(spec)).toBeGreaterThan(1_000_000);
      expect(spec.dimensions).toBeGreaterThan(0);
      expect(spec.maxTokens).toBeGreaterThanOrEqual(128);
      expect(builtinModel(spec.id)).toBe(spec);
    }
    expect(ids).toContain('anvesa-code-1b');
  });

  test('the ranking names every built-in model once, best measured first, each with a summary', () => {
    expect([...MODEL_RANKING].sort()).toEqual(MODEL_CATALOG.map((spec) => spec.id).sort());
    expect(MODELS_BY_RANK.map((spec) => spec.id)).toEqual([...MODEL_RANKING]);
    expect(modelRank('anvesa-code-1b')).toBe(1);
    expect(modelRank('my-own-model')).toBeUndefined();
    for (const spec of MODEL_CATALOG) expect(spec.summary?.length).toBeGreaterThan(0);
  });

  test('models are offered best for code first', () => {
    const offered = adviseModels(probeOf(8, 16_000)).models.map((model) => model.spec.id);
    expect(offered).toEqual([...MODEL_RANKING]);
  });

  test('the catalog is ordered smallest download first', () => {
    const sizes = MODEL_CATALOG.map(weightBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  test('every machine is proposed the default, and a roomy one the most capable when allowed', () => {
    expect(adviseModels(probeOf(16, 32_000)).recommended.spec.id).toBe('anvesa-code-150m');
    const advice = adviseModels(probeOf(16, 32_000), { maxTier: 'high' });
    expect(advice.recommended.spec.id).toBe(BUILTIN_MODELS.high.id);
    expect(advice.models.filter((model) => model.recommended)).toHaveLength(1);
    expect(advice.models.every((model) => model.fits)).toBe(true);
  });

  test('little memory steps the proposal down, and says which models do not fit', () => {
    const advice = adviseModels(probeOf(16, 1_500), { maxTier: 'high' });
    expect(advice.recommended.spec.id).toBe(BUILTIN_MODELS.low.id);
    const large = advice.models.find((model) => model.spec.id === BUILTIN_MODELS.medium.id);
    expect(large?.fits).toBe(false);
  });

  test('few cores keep a big model from being proposed however much memory there is', () => {
    const high = { maxTier: 'high' as const };
    expect(adviseModels(probeOf(4, 64_000), high).recommended.spec.id).toBe(BUILTIN_MODELS.low.id);
    expect(adviseModels(probeOf(8, 64_000), high).recommended.spec.id).toBe(BUILTIN_MODELS.high.id);
    expect(adviseModels(probeOf(4, 64_000)).reason).toContain('4 cores');
  });

  test('every model is listed with its download size and expected memory', () => {
    const [first] = adviseModels(probeOf(8, 16_000)).models;
    expect(first?.downloadMb).toBeGreaterThan(20);
    expect(first?.estimatedPeakMb).toBeGreaterThan(100);
  });
});
