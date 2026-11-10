import { describe, expect, it } from 'bun:test';
// The collector deploys on its own, outside the workspace: the client's types are only checked here.
import type { TelemetryPayload } from '../../core/src/telemetry.ts';
import { handle, type PostHogEvent, toPostHogEvents } from './worker.ts';

const NOW = Date.UTC(2026, 10, 10, 12);

const batch = (overrides: Partial<TelemetryPayload> = {}): TelemetryPayload => ({
  schemaVersion: '1.0.0',
  sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  timestamp: NOW - 1000,
  anvesaVersion: '0.7.4',
  platform: { os: 'linux', arch: 'x64', cpuCores: 8, totalMemoryGbBucket: '16-32', runtime: 'bun' },
  events: [
    {
      type: 'rank',
      name: 'symbols',
      modelId: 'anvesa-code-150m',
      candidateCount: 30,
      reranked: true,
      topChanged: true,
      topFirstRank: 3,
      overlapAt10: 0.8,
      durationMsBucket: '10-50',
      rankMsBucket: '<10',
    },
  ],
  ...overrides,
});

describe('toPostHogEvents', () => {
  it('turns each event into an anonymous PostHog event with the batch fields', () => {
    expect(toPostHogEvents(batch(), NOW)).toEqual([
      {
        event: 'anvesa_rank',
        distinct_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        timestamp: new Date(NOW - 1000).toISOString(),
        properties: {
          anvesa_version: '0.7.4',
          platform_os: 'linux',
          platform_arch: 'x64',
          platform_cpuCores: 8,
          platform_totalMemoryGbBucket: '16-32',
          platform_runtime: 'bun',
          $process_person_profile: false,
          $geoip_disable: true,
          name: 'symbols',
          modelId: 'anvesa-code-150m',
          candidateCount: 30,
          reranked: true,
          topChanged: true,
          topFirstRank: 3,
          overlapAt10: 0.8,
          durationMsBucket: '10-50',
          rankMsBucket: '<10',
        },
      },
    ]);
  });

  it('drops free text, unknown fields and unknown event types', () => {
    const hostile = {
      ...batch(),
      events: [
        {
          type: 'search',
          name: 'search',
          query: 'where is the billing secret',
          modelId: '/home/alice/models/private model',
          errorCode: 'C:\\Users\\alice',
          channelCount: 1e9,
        },
        { type: 'keylogger', name: 'x' },
      ],
    };
    const events = toPostHogEvents(hostile, NOW) as PostHogEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.properties.name).toBe('search');
    const sent = JSON.stringify(events);
    for (const leak of ['billing', 'alice', 'query', 'channelCount', 'keylogger']) {
      expect(sent).not.toContain(leak);
    }
  });

  it('refuses what is not a batch, and distrusts a far-off clock', () => {
    expect(toPostHogEvents(null, NOW)).toBeUndefined();
    expect(toPostHogEvents({ ...batch(), schemaVersion: '2' }, NOW)).toBeUndefined();
    expect(toPostHogEvents({ ...batch(), sessionId: 'alice@example.com' }, NOW)).toBeUndefined();
    const skewed = toPostHogEvents(batch({ timestamp: 0 }), NOW);
    expect(skewed?.[0]?.timestamp).toBe(new Date(NOW).toISOString());
  });
});

describe('the worker', () => {
  const env = { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://posthog.test' };

  it('answers 204 and forwards to PostHog after the response, with no client address', async () => {
    const forwarded: { url: string; init: RequestInit }[] = [];
    const pending: Promise<unknown>[] = [];
    const response = await handle(
      new Request('https://collector.test/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify(batch()),
      }),
      env,
      { waitUntil: (promise) => pending.push(promise) },
      (async (url: string | URL | Request, init?: RequestInit) => {
        forwarded.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    );
    await Promise.all(pending);

    expect(response.status).toBe(204);
    expect(forwarded.map((call) => call.url)).toEqual(['https://posthog.test/batch/']);
    const body = String(forwarded[0]?.init.body);
    expect(JSON.parse(body)).toMatchObject({ api_key: 'phc_test' });
    expect(body).not.toContain('203.0.113.9');
    expect(forwarded[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('refuses other methods, oversized bodies and malformed JSON', async () => {
    const context = { waitUntil: () => undefined };
    const post = (body: string) =>
      handle(new Request('https://collector.test/v1', { method: 'POST', body }), env, context);
    expect((await handle(new Request('https://collector.test/v1'), env, context)).status).toBe(405);
    expect((await post('x'.repeat(70 * 1024))).status).toBe(413);
    expect((await post('{')).status).toBe(400);
    expect((await post('{"schemaVersion":"1.0.0"}')).status).toBe(400);
  });
});
