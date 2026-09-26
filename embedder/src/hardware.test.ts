import { describe, expect, test } from 'bun:test';
import { adviseModels, chooseTier, type HardwareProbe, probeHardware } from './hardware.ts';
import { BUILTIN_MODELS, builtinModel, estimatePeakRssMb, MODEL_CATALOG, TIERS } from './models.ts';

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
      estimatePeakRssMb(BUILTIN_MODELS[tier].model.bytes),
    );
    expect(low).toBeLessThan(medium as number);
    expect(medium).toBeLessThan(high as number);
  });
});

describe('choosing a tier from the machine', () => {
  test('a generous machine gets the most capable model', () => {
    const choice = chooseTier(machine(32 * 1024));
    expect(choice.tier).toBe('high');
    expect(choice.fits).toBe(true);
    expect(choice.reason).toContain('bge-large-en-v1.5');
  });

  test('a constrained machine gets a smaller one, chosen by the estimate and the allowance', () => {
    // Half of 1500 MB is 750: room for bge-base (about 555), not for bge-large.
    expect(chooseTier(machine(1500)).tier).toBe('medium');
    // Half of 500 MB is 250: room for MiniLM (about 157) only.
    expect(chooseTier(machine(500)).tier).toBe('low');
  });

  test('the share of memory the encoder may take is the caller’s to set', () => {
    expect(chooseTier(machine(1500), { memoryFraction: 0.2 }).tier).toBe('low');
    expect(chooseTier(machine(1500), { memoryFraction: 0.9 }).tier).toBe('medium');
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

  test('the BGE models read the [CLS] state; MiniLM averages', () => {
    expect(BUILTIN_MODELS.low.pooling).toBe('mean');
    expect(BUILTIN_MODELS.medium.pooling).toBe('cls');
    expect(BUILTIN_MODELS.high.pooling).toBe('cls');
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
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const spec of MODEL_CATALOG) {
      expect(spec.model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.tokenizer.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.model.bytes).toBeGreaterThan(1_000_000);
      expect(spec.dimensions).toBeGreaterThan(0);
      expect(spec.maxTokens).toBeGreaterThanOrEqual(128);
      expect(builtinModel(spec.id)).toBe(spec);
    }
    expect(ids).toContain('jina-embeddings-v2-base-code');
  });

  test('the catalog is ordered smallest download first', () => {
    const sizes = MODEL_CATALOG.map((spec) => spec.model.bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  test('a roomy many-core machine is proposed the most capable standard model', () => {
    const advice = adviseModels(probeOf(16, 32_000));
    expect(advice.recommended.spec.id).toBe(BUILTIN_MODELS.high.id);
    expect(advice.models.filter((model) => model.recommended)).toHaveLength(1);
    expect(advice.models.every((model) => model.fits)).toBe(true);
  });

  test('little memory steps the proposal down, and says which models do not fit', () => {
    const advice = adviseModels(probeOf(16, 1_500));
    expect(advice.recommended.spec.id).toBe(BUILTIN_MODELS.medium.id);
    const large = advice.models.find((model) => model.spec.id === BUILTIN_MODELS.high.id);
    expect(large?.fits).toBe(false);
  });

  test('few cores keep a big model from being proposed however much memory there is', () => {
    expect(adviseModels(probeOf(2, 64_000)).recommended.spec.id).toBe(BUILTIN_MODELS.low.id);
    expect(adviseModels(probeOf(4, 64_000)).recommended.spec.id).toBe(BUILTIN_MODELS.medium.id);
    expect(adviseModels(probeOf(2, 64_000)).reason).toContain('2 cores');
  });

  test('every model is listed with its download size and expected memory', () => {
    const [first] = adviseModels(probeOf(8, 16_000)).models;
    expect(first?.downloadMb).toBeGreaterThan(20);
    expect(first?.estimatedPeakMb).toBeGreaterThan(100);
  });
});
