import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetryEvent, TelemetryPayload } from '@cntxt-labs/anvesa-core';
import {
  countBucket,
  durationBucket,
  InvalidArgumentError,
  NoopTelemetryCollector,
} from '@cntxt-labs/anvesa-core';
import type { Retriever } from '@cntxt-labs/anvesa-retriever';
import { createMcpServer } from './mcp.ts';
import {
  ActiveTelemetryCollector,
  createTelemetryCollector,
  getPlatformInfo,
  isTelemetryPermitted,
  setGlobalTelemetry,
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

    it('refuses when DO_NOT_TRACK=1 or true is set', () => {
      expect(isTelemetryPermitted({ env: { DO_NOT_TRACK: '1' } })).toBe(false);
      expect(isTelemetryPermitted({ env: { DO_NOT_TRACK: 'true' } })).toBe(false);
      expect(isTelemetryPermitted({ env: { DO_NOT_TRACK: 'TRUE' } })).toBe(false);
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
      await collector.close();
    });

    it('writes to local logFile when configured via environment variable', async () => {
      const tempLog = join(process.cwd(), '.temp_telemetry_test.log');
      try {
        const collector = new ActiveTelemetryCollector({
          env: { ANVESA_TELEMETRY_LOG_FILE: tempLog },
        });

        collector.record({
          type: 'mcp_tool_call',
          name: 'callers',
          durationMsBucket: '<10',
        });

        await collector.close();

        const content = readFileSync(tempLog, 'utf8');
        expect(content).toContain('mcp_tool_call');
        expect(content).toContain('callers');
      } finally {
        if (existsSync(tempLog)) {
          unlinkSync(tempLog);
        }
      }
    });

    it('delivers payload to HTTP endpoint with zero paths, queries, or source code', async () => {
      let postedUrl: string | undefined;
      let postedBody: TelemetryPayload | undefined;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          postedUrl = String(url);
          postedBody = JSON.parse(String(init?.body)) as TelemetryPayload;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch;

        const collector = new ActiveTelemetryCollector({
          env: { ANVESA_TELEMETRY_ENDPOINT: 'https://telemetry.anvesa.internal/v1/events' },
        });

        collector.record({
          type: 'mcp_tool_call',
          name: 'callers',
          durationMsBucket: '10-50',
        });

        await collector.close();

        expect(postedUrl).toBe('https://telemetry.anvesa.internal/v1/events');
        expect(postedBody).toBeDefined();
        expect(postedBody?.schemaVersion).toBe('1.0.0');
        expect(postedBody?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(postedBody?.events).toHaveLength(1);
        expect(postedBody?.events[0]?.name).toBe('callers');

        // Verify zero leakage of file paths, queries, or source code
        const payloadStr = JSON.stringify(postedBody);
        expect(payloadStr).not.toContain('/home/');
        expect(payloadStr).not.toContain('C:\\');
        expect(payloadStr).not.toContain('const ');
        expect(payloadStr).not.toContain('SELECT ');
      } finally {
        globalThis.fetch = originalFetch;
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

describe('MCP tool telemetry names', () => {
  it('records a built-in channel tool by name and a project-defined one as retrieve_custom', async () => {
    const recorded: TelemetryEvent[] = [];
    class Capture extends NoopTelemetryCollector {
      override record(event: TelemetryEvent): void {
        recorded.push(event);
      }
    }
    setGlobalTelemetry(new Capture());
    try {
      // The calls fail in this fake; a failed call is recorded too, under the same name.
      const retriever = {
        root: '/workspace/repo',
        registry: { channels: () => ['symbols', 'acme-secret-runbooks'] },
        retrieve: async () => {
          throw new InvalidArgumentError('channel', 'an indexed channel', 'not indexed');
        },
      } as unknown as Retriever;
      const tools = (
        createMcpServer(retriever) as unknown as {
          readonly _registeredTools: Record<
            string,
            { readonly handler: (args: unknown, extra: unknown) => Promise<unknown> }
          >;
        }
      )._registeredTools;
      await tools.retrieve_symbols?.handler({ query: 'parse' }, {});
      await tools.retrieve_acme_secret_runbooks?.handler({ query: 'parse' }, {});

      expect(recorded.map((event) => event.name)).toEqual(['retrieve_symbols', 'retrieve_custom']);
      expect(JSON.stringify(recorded)).not.toContain('acme');
    } finally {
      setGlobalTelemetry(new NoopTelemetryCollector());
    }
  });
});
