import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryCollector, TelemetryEvent, TelemetryPayload } from '@cntxt-labs/anvesa-core';
import {
  countBucket,
  durationBucket,
  InvalidArgumentError,
  NoopTelemetryCollector,
} from '@cntxt-labs/anvesa-core';
import type { ProjectConfig, Retriever } from '@cntxt-labs/anvesa-retriever';
import { runCli } from './cli.ts';
import { createMcpServer } from './mcp.ts';
import {
  ActiveTelemetryCollector,
  createTelemetryCollector,
  getPlatformInfo,
  readTelemetryChoice,
  recordRanking,
  setGlobalTelemetry,
  TELEMETRY_NOTICE,
  telemetryStatus,
  writeTelemetryChoice,
} from './telemetry.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'anvesa-telemetry-'));
  temporary.push(directory);
  return directory;
}

/** A per-user directory of its own and an endpoint, so each rule can be seen on its own. */
function sending(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ANVESA_HOME: scratch(),
    ANVESA_TELEMETRY_ENDPOINT: 'https://collector.test/v1',
    ...extra,
  };
}

const projectConfig = (telemetry: NonNullable<ProjectConfig['telemetry']>): ProjectConfig => ({
  telemetry,
  model: undefined,
  channels: {},
  fusionK: undefined,
  fragments: false,
});

/** Records what it is given, and says it is on, as an active collector would. */
class Capture implements TelemetryCollector {
  readonly enabled = true;
  readonly events: TelemetryEvent[] = [];
  record(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<void> {
    // nothing is delivered: the test reads `events`
  }
  async close(): Promise<void> {
    // as flush
  }
}

describe('when telemetry sends', () => {
  it('detects platform metadata with coarse memory buckets', () => {
    const info = getPlatformInfo();
    expect(['linux', 'darwin', 'win32', 'other']).toContain(info.os);
    expect(['x64', 'arm64', 'other']).toContain(info.arch);
    expect(info.cpuCores).toBeGreaterThanOrEqual(1);
    expect(['<4', '4-8', '8-16', '16-32', '32+']).toContain(info.totalMemoryGbBucket);
    expect(['bun', 'node', 'other']).toContain(info.runtime);
  });

  it('owes the notice before the default may send', () => {
    expect(telemetryStatus({ env: sending() })).toMatchObject({ active: false, needsNotice: true });
  });

  it('sends once the notice was shown, or the person turned it on', () => {
    const shown = sending();
    writeTelemetryChoice(shown, { notice_shown: true });
    expect(telemetryStatus({ env: shown })).toMatchObject({
      active: true,
      endpoint: 'https://collector.test/v1',
    });
    const on = sending();
    writeTelemetryChoice(on, { enabled: true });
    expect(telemetryStatus({ env: on }).active).toBe(true);
    expect(telemetryStatus({ env: sending({ ANVESA_TELEMETRY: '1' }) }).active).toBe(true);
  });

  it('sends nothing with no collector, and owes no notice for a local log', () => {
    expect(telemetryStatus({ env: {} })).toMatchObject({
      active: false,
      needsNotice: false,
      reason: 'this build has no collector to send to',
    });
    const local = telemetryStatus({ env: { ANVESA_TELEMETRY_LOG_FILE: '/tmp/t.log' } });
    expect(local).toMatchObject({ active: true, logFile: '/tmp/t.log' });
    expect(local.endpoint).toBeUndefined();
  });

  it('is off for every way of turning it off, even after consent', () => {
    const offs: [Record<string, string>, string][] = [
      [{ DO_NOT_TRACK: '1' }, 'DO_NOT_TRACK is set'],
      [{ DO_NOT_TRACK: 'TRUE' }, 'DO_NOT_TRACK is set'],
      [{ ANVESA_NO_TELEMETRY: 'true' }, 'ANVESA_NO_TELEMETRY is set'],
      [{ ANVESA_NO_NETWORK: '1' }, 'ANVESA_NO_NETWORK is set'],
      [{ ANVESA_TELEMETRY: '0' }, 'ANVESA_TELEMETRY=0'],
      [{ ANVESA_TELEMETRY: 'false' }, 'ANVESA_TELEMETRY=0'],
      [{ CI: 'true' }, 'running in CI (CI is set)'],
    ];
    for (const [extra, reason] of offs) {
      const env = sending(extra);
      writeTelemetryChoice(env, { enabled: true, notice_shown: true });
      expect(telemetryStatus({ env })).toMatchObject({ active: false, reason });
    }
    const env = sending();
    writeTelemetryChoice(env, { enabled: true, notice_shown: true });
    expect(telemetryStatus({ env, noNetwork: true }).reason).toBe('--no-network is set');
    expect(telemetryStatus({ env, config: projectConfig(false) }).active).toBe(false);
    expect(telemetryStatus({ env, config: projectConfig({ enabled: false }) }).active).toBe(false);
    writeTelemetryChoice(env, { enabled: false, notice_shown: true });
    expect(telemetryStatus({ env }).reason).toBe('turned off with `anvesa telemetry off`');
  });

  it('shows the notice once, remembers it, and sends nothing that run', async () => {
    const env = sending();
    const printed: string[] = [];
    const first = createTelemetryCollector({ env, notice: (text) => printed.push(text) });
    expect(first.enabled).toBe(false);
    expect(printed).toEqual([TELEMETRY_NOTICE]);
    expect(readTelemetryChoice(env)).toEqual({ notice_shown: true });

    const second = createTelemetryCollector({ env, notice: (text) => printed.push(text) });
    expect(second.enabled).toBe(true);
    expect(printed).toHaveLength(1);
    await second.close();
  });

  it('never shows the notice, nor sends, where nobody reads it', () => {
    const env = sending();
    expect(createTelemetryCollector({ env }).enabled).toBe(false);
    expect(readTelemetryChoice(env)).toEqual({});
  });

  it('keeps the choice in the user config, under preferences, beside what is there', () => {
    const env = sending();
    const file = join(env.ANVESA_HOME ?? '', 'config.json');
    writeFileSync(
      file,
      JSON.stringify({ model: 'anvesa-code-400m', preferences: { theme: 'dark' } }),
    );
    expect(writeTelemetryChoice(env, { enabled: false, notice_shown: true })).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      model: 'anvesa-code-400m',
      preferences: { theme: 'dark', telemetry: { enabled: false, notice_shown: true } },
    });
    expect(readTelemetryChoice(env)).toEqual({ enabled: false, notice_shown: true });
  });

  it('never writes over a user config that is not JSON', () => {
    const env = sending();
    const file = join(env.ANVESA_HOME ?? '', 'config.json');
    writeFileSync(file, '{ "model": ');
    expect(writeTelemetryChoice(env, { enabled: false })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{ "model": ');
    expect(readTelemetryChoice(env)).toEqual({});
  });
});

describe('the collector', () => {
  it('buffers events and hands the batch to onPayload', async () => {
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
    await collector.close();

    expect(received?.schemaVersion).toBe('1.0.0');
    expect(received?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(received?.events).toEqual([
      {
        type: 'search',
        name: 'search',
        searchMode: 'fused',
        durationMsBucket: '10-50',
        resultCountBucket: '6-20',
      },
    ]);
  });

  it('writes one JSON line a batch to a local log', async () => {
    const log = join(scratch(), 'events.log');
    const collector = new ActiveTelemetryCollector({ logFile: log });
    collector.record({ type: 'mcp_tool_call', name: 'callers', durationMsBucket: '<10' });
    await collector.close();
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}').events[0].name).toBe('callers');
  });

  it('posts the batch to the endpoint, and a failure is dropped', async () => {
    const posted: { url: string; body: TelemetryPayload }[] = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        if (posted.length > 1) throw new InvalidArgumentError('network', 'reachable', 'offline');
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      const collector = new ActiveTelemetryCollector({ endpoint: 'https://collector.test/v1' });
      collector.record({ type: 'mcp_tool_call', name: 'callers', durationMsBucket: '10-50' });
      await collector.flush();
      collector.record({ type: 'mcp_tool_call', name: 'query', durationMsBucket: '10-50' });
      await collector.close();

      expect(posted.map((entry) => entry.url)).toEqual([
        'https://collector.test/v1',
        'https://collector.test/v1',
      ]);
      expect(posted[0]?.body.events[0]?.name).toBe('callers');
      expect(collector.lastDeliveryError).toContain('offline');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('ranking telemetry', () => {
  const stage = (symbols: readonly string[], ms: number) => ({
    symbols: symbols.map((symbol, index) => ({ symbol, score: 1 - index / 100 })),
    ms,
  });

  it('records how far the ranker moved results, and nothing of the query or symbols', () => {
    const capture = new Capture();
    setGlobalTelemetry(capture);
    try {
      const first = Array.from({ length: 30 }, (_, index) => `src/secret.ts#symbol${index}`);
      const ranked = [first[3] ?? '', ...first.filter((_, index) => index !== 3)];
      recordRanking({
        kind: 'search',
        query: 'where is the acme billing secret',
        model: 'anvesa-code-150m',
        stages: { first: stage(first, 12), ranked: stage(ranked, 3) },
      });
      recordRanking({
        kind: 'search',
        query: 'q',
        model: 'my-private-model',
        stages: { first: stage(first, 12) },
      });
      recordRanking({
        kind: 'index',
        hub: { cards: 52_000, symbols: 40_000, hubMs: 45_000, totalMs: 61_000 },
      });

      expect(capture.events).toEqual([
        {
          type: 'rank',
          name: 'symbols',
          modelId: 'anvesa-code-150m',
          candidateCount: 30,
          reranked: true,
          topChanged: true,
          topFirstRank: 3,
          overlapAt10: 1,
          durationMsBucket: '10-50',
          rankMsBucket: '<10',
        },
        {
          type: 'rank',
          name: 'symbols',
          modelId: 'custom',
          candidateCount: 30,
          reranked: false,
          topChanged: false,
          topFirstRank: 0,
          overlapAt10: 1,
          durationMsBucket: '10-50',
        },
        {
          type: 'index',
          name: 'hub',
          durationMsBucket: '30000-120000',
          totalMsBucket: '30000-120000',
          nodeCountBucket: '10001-100000',
        },
      ]);
      const sent = JSON.stringify(capture.events);
      for (const leak of ['secret', 'acme', 'symbol0', 'my-private-model']) {
        expect(sent).not.toContain(leak);
      }
    } finally {
      setGlobalTelemetry(new NoopTelemetryCollector());
    }
  });
});

describe('anvesa telemetry', () => {
  const cli = async (env: Record<string, string>, ...args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['telemetry', ...args], {
      cwd: env.ANVESA_HOME ?? tmpdir(),
      env,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  };

  it('says what it would do, and keeps on and off', async () => {
    const env = sending();
    expect((await cli(env)).stdout).toContain('telemetry: on, from the next run');

    const off = await cli(env, 'off');
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('telemetry: off (turned off with `anvesa telemetry off`)');
    expect(readTelemetryChoice(env)).toEqual({ enabled: false, notice_shown: true });
    expect(off.stdout).toContain('config.json (preferences.telemetry)');

    const on = await cli(env, 'on', '--json');
    expect(JSON.parse(on.stdout)).toMatchObject({
      active: true,
      endpoint: 'https://collector.test/v1',
    });

    const blocked = await cli({ ...env, DO_NOT_TRACK: '1' }, 'status');
    expect(blocked.stdout).toContain('telemetry: off (DO_NOT_TRACK is set)');
  });

  it('refuses an unknown subcommand', async () => {
    expect((await cli(sending(), 'maybe')).code).toBe(2);
  });
});

describe('MCP tool telemetry names', () => {
  it('records a built-in channel tool by name and a project-defined one as retrieve_custom', async () => {
    const capture = new Capture();
    setGlobalTelemetry(capture);
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

      expect(capture.events.map((event) => event.name)).toEqual([
        'retrieve_symbols',
        'retrieve_custom',
      ]);
      expect(JSON.stringify(capture.events)).not.toContain('acme');
    } finally {
      setGlobalTelemetry(new NoopTelemetryCollector());
    }
  });
});
