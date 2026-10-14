import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetryPayload } from '@cntxt-labs/anvesa-core';
import { countBucket, durationBucket } from '@cntxt-labs/anvesa-core';
import {
  ActiveTelemetryCollector,
  createTelemetryCollector,
  getPlatformInfo,
  isTelemetryPermitted,
} from './telemetry.ts';

describe('cli telemetry collector & transport', () => {
  it('detects platform metadata with coarse memory buckets', () => {
    const info = getPlatformInfo();
    expect(['linux', 'darwin', 'win32', 'other']).toContain(info.os);
    expect(['x64', 'arm64', 'other']).toContain(info.arch);
    expect(info.cpuCores).toBeGreaterThanOrEqual(1);
    expect(['<4', '4-8', '8-16', '16-32', '32+']).toContain(info.totalMemoryGbBucket);
    expect(['bun', 'node', 'other']).toContain(info.runtime);
  });

  describe('circuit breaker & opt-out rules', () => {
    it('is permitted by default in clean environment', () => {
      expect(isTelemetryPermitted({ env: {} })).toBe(true);
    });

    it('refuses when noNetwork is true (--no-network)', () => {
      expect(isTelemetryPermitted({ noNetwork: true, env: {} })).toBe(false);
    });

    it('refuses when ANVESA_NO_TELEMETRY=1 is set', () => {
      expect(isTelemetryPermitted({ env: { ANVESA_NO_TELEMETRY: '1' } })).toBe(false);
      expect(isTelemetryPermitted({ env: { ANVESA_NO_TELEMETRY: 'true' } })).toBe(false);
    });

    it('refuses when ANVESA_TELEMETRY=0 is set', () => {
      expect(isTelemetryPermitted({ env: { ANVESA_TELEMETRY: '0' } })).toBe(false);
      expect(isTelemetryPermitted({ env: { ANVESA_TELEMETRY: 'false' } })).toBe(false);
    });

    it('refuses when DO_NOT_TRACK=1 is set', () => {
      expect(isTelemetryPermitted({ env: { DO_NOT_TRACK: '1' } })).toBe(false);
    });

    it('refuses when ANVESA_NO_NETWORK=1 is set', () => {
      expect(isTelemetryPermitted({ env: { ANVESA_NO_NETWORK: '1' } })).toBe(false);
    });

    it('refuses when project config has telemetry: false', () => {
      expect(
        isTelemetryPermitted({
          config: {
            telemetry: false,
            model: undefined,
            channels: {},
            fusionK: undefined,
            fragments: false,
          },
          env: {},
        }),
      ).toBe(false);
    });

    it('refuses when project config has telemetry: { enabled: false }', () => {
      expect(
        isTelemetryPermitted({
          config: {
            telemetry: { enabled: false },
            model: undefined,
            channels: {},
            fusionK: undefined,
            fragments: false,
          },
          env: {},
        }),
      ).toBe(false);
    });
  });

  describe('active collector buffering and dispatch', () => {
    it('buffers events and dispatches via onPayload callback', async () => {
      let received: TelemetryPayload | undefined;
      const collector = new ActiveTelemetryCollector({
        onPayload: (payload) => {
          received = payload;
        },
      });

      collector.record({
        type: 'search',
        name: 'search',
        searchMode: 'fused',
        durationMsBucket: durationBucket(42),
        resultCountBucket: countBucket(10),
      });

      await collector.flush();

      expect(received).toBeDefined();
      expect(received?.schemaVersion).toBe('1.0.0');
      expect(received?.sessionId).toBeDefined();
      expect(received?.events.length).toBe(1);
      expect(received?.events[0]?.type).toBe('search');
      expect(received?.events[0]?.durationMsBucket).toBe('10-50');
      expect(received?.events[0]?.resultCountBucket).toBe('6-20');
    });

    it('writes to local logFile when configured', async () => {
      const tempLog = join(process.cwd(), '.temp_telemetry_test.log');
      try {
        const collector = new ActiveTelemetryCollector({
          config: {
            telemetry: { logFile: tempLog },
            model: undefined,
            channels: {},
            fusionK: undefined,
            fragments: false,
          },
          env: {},
        });

        collector.record({
          type: 'grammar_extract',
          name: 'inspectTopology',
          language: 'typescript',
          nodeCountBucket: countBucket(350),
        });

        await collector.close();

        const content = readFileSync(tempLog, 'utf8');
        expect(content).toContain('grammar_extract');
        expect(content).toContain('typescript');
      } finally {
        if (existsSync(tempLog)) {
          unlinkSync(tempLog);
        }
      }
    });

    it('returns NoopTelemetryCollector when disabled', () => {
      const collector = createTelemetryCollector({
        env: { ANVESA_NO_TELEMETRY: '1' },
      });
      expect(collector.enabled).toBe(false);
    });
  });
});
