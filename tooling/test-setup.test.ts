import { describe, expect, it } from 'bun:test';
import { DEFAULT_TELEMETRY_ENDPOINT } from '../cli/src/telemetry.ts';

describe('test setup', () => {
  it('keeps every test away from the real telemetry collector', async () => {
    if (!DEFAULT_TELEMETRY_ENDPOINT) return;
    await expect(fetch(DEFAULT_TELEMETRY_ENDPOINT, { method: 'POST', body: '{}' })).rejects.toThrow(
      'tests may not reach the real telemetry collector',
    );
  });
});
