import { describe, expect, it } from 'bun:test';
import {
  countBucket,
  durationBucket,
  generateEphemeralSessionId,
  memoryBucket,
  NoopTelemetryCollector,
  ratioBucket,
  sanitizeErrorCode,
} from './telemetry.ts';

describe('core telemetry module (anonymous & non-IP)', () => {
  it('categorizes durations into coarse logarithmic buckets', () => {
    expect(durationBucket(4)).toBe('<10');
    expect(durationBucket(9)).toBe('<10');
    expect(durationBucket(10)).toBe('10-50');
    expect(durationBucket(45)).toBe('10-50');
    expect(durationBucket(120)).toBe('50-200');
    expect(durationBucket(500)).toBe('200-1000');
    expect(durationBucket(2500)).toBe('1000+');
  });

  it('categorizes result and node counts into privacy-preserving buckets', () => {
    expect(countBucket(0)).toBe('0');
    expect(countBucket(3)).toBe('1-5');
    expect(countBucket(5)).toBe('1-5');
    expect(countBucket(12)).toBe('6-20');
    expect(countBucket(50)).toBe('21-100');
    expect(countBucket(1500)).toBe('100+');
  });

  it('categorizes ratio numbers into quartile buckets', () => {
    expect(ratioBucket(0.1)).toBe('<0.25');
    expect(ratioBucket(0.4)).toBe('0.25-0.5');
    expect(ratioBucket(0.65)).toBe('0.5-0.75');
    expect(ratioBucket(0.95)).toBe('0.75-1.0');
  });

  it('categorizes system memory bytes into GB buckets', () => {
    expect(memoryBucket(2 * 1024 * 1024 * 1024)).toBe('<4');
    expect(memoryBucket(6 * 1024 * 1024 * 1024)).toBe('4-8');
    expect(memoryBucket(16 * 1024 * 1024 * 1024)).toBe('16-32');
    expect(memoryBucket(64 * 1024 * 1024 * 1024)).toBe('32+');
  });

  it('generates a deterministic daily session ID for the same day and salt, but rotates with date', () => {
    const sessionToday = generateEphemeralSessionId('2026-10-15', 'salt-abc');
    const sessionTodayRepeat = generateEphemeralSessionId('2026-10-15', 'salt-abc');
    const sessionTomorrow = generateEphemeralSessionId('2026-10-16', 'salt-abc');

    expect(sessionToday).toBe(sessionTodayRepeat);
    expect(sessionToday).not.toBe(sessionTomorrow);
    expect(sessionToday).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sanitizes error codes to prevent file paths or stack traces leaking', () => {
    expect(sanitizeErrorCode({ code: 'INVALID_ARGUMENT' })).toBe('INVALID_ARGUMENT');
    expect(sanitizeErrorCode({ code: 'FILE_NOT_FOUND' })).toBe('FILE_NOT_FOUND');
    expect(
      sanitizeErrorCode({ name: 'SyntaxError', message: 'Syntax error at /secret/code.ts:42' }),
    ).toBe('SYNTAXERROR');
    expect(sanitizeErrorCode('raw string error')).toBe('UNKNOWN_ERROR');
    expect(sanitizeErrorCode(null)).toBe('UNKNOWN_ERROR');
  });

  it('NoopTelemetryCollector accepts events without throwing', async () => {
    const noop = new NoopTelemetryCollector();
    expect(noop.enabled).toBe(false);
    expect(() =>
      noop.record({
        type: 'search',
        name: 'search',
        durationMsBucket: '10-50',
        resultCountBucket: '6-20',
      }),
    ).not.toThrow();
    await expect(noop.flush()).resolves.toBeUndefined();
    await expect(noop.close()).resolves.toBeUndefined();
  });
});
