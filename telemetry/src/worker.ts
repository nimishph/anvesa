/**
 * anvesa's telemetry collector: a Cloudflare Worker between the CLI and PostHog.
 *
 * The CLI posts a batch (core/src/telemetry.ts `TelemetryPayload`) here, never to PostHog itself,
 * so the analytics store can change without a release, and so the store never sees a client: this
 * worker reads no address or header of the request, and its own request to PostHog carries none.
 *
 * Every field is checked against an allowlist and anything else is dropped, so a client (or anyone
 * posting here) cannot put free text, paths or names into the store: strings must be short tokens
 * from a fixed alphabet, numbers small, and event types known.
 */

export interface Env {
  /** The PostHog project API key: `wrangler secret put POSTHOG_KEY`. */
  readonly POSTHOG_KEY: string;
  /** PostHog's ingestion host, e.g. https://eu.i.posthog.com. */
  readonly POSTHOG_HOST?: string;
}

/** What a Worker is handed to keep work going after the response (Cloudflare's ExecutionContext). */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface PostHogEvent {
  readonly event: string;
  readonly distinct_id: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 200;
const DEFAULT_HOST = 'https://eu.i.posthog.com';
/** A batch's own clock is trusted only this far from the collector's. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const EVENT_TYPES = new Set([
  'cli_command',
  'search',
  'graph',
  'index',
  'grammar_extract',
  'mcp_tool_call',
  'rank',
  'error',
]);

/** A short token: names, ids, buckets and codes, never prose, paths or queries. */
const TOKEN = /^[A-Za-z0-9_.:+<>-]{1,64}$/;
const SESSION = /^[0-9a-f-]{32,36}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,32})?$/;

type Check = (value: unknown) => value is string | number | boolean;
const token: Check = (value): value is string => typeof value === 'string' && TOKEN.test(value);
const flag: Check = (value): value is boolean => typeof value === 'boolean';
const small =
  (max: number): Check =>
  (value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

/** Every event field PostHog may receive, and what its value must look like. */
const EVENT_FIELDS: Readonly<Record<string, Check>> = {
  name: token,
  durationMsBucket: token,
  searchMode: token,
  channelCount: small(1000),
  hasWqlFilter: flag,
  hasScope: flag,
  resultCountBucket: token,
  modelId: token,
  language: token,
  nodeCountBucket: token,
  mappedRatioBucket: token,
  errorCode: token,
  candidateCount: small(10_000),
  reranked: flag,
  topChanged: flag,
  topFirstRank: small(10_000),
  overlapAt10: small(1),
  rankMsBucket: token,
  totalMsBucket: token,
};

const PLATFORM_FIELDS: Readonly<Record<string, Check>> = {
  os: token,
  arch: token,
  cpuCores: small(4096),
  totalMemoryGbBucket: token,
  runtime: token,
};

function pick(
  source: unknown,
  fields: Readonly<Record<string, Check>>,
  prefix = '',
): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return kept;
  for (const [key, check] of Object.entries(fields)) {
    const value = (source as Record<string, unknown>)[key];
    if (check(value)) kept[`${prefix}${key}`] = value;
  }
  return kept;
}

/**
 * The PostHog events a batch becomes, or `undefined` when it is not a batch at all. Events of an
 * unknown type are dropped; unknown or malformed fields of a known one are dropped from it.
 */
export function toPostHogEvents(payload: unknown, now: number): PostHogEvent[] | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const batch = payload as Record<string, unknown>;
  if (batch.schemaVersion !== '1.0.0') return undefined;
  if (typeof batch.sessionId !== 'string' || !SESSION.test(batch.sessionId)) return undefined;
  if (typeof batch.anvesaVersion !== 'string' || !VERSION.test(batch.anvesaVersion)) {
    return undefined;
  }
  if (!Array.isArray(batch.events) || batch.events.length > MAX_EVENTS) return undefined;

  const sent = typeof batch.timestamp === 'number' ? batch.timestamp : Number.NaN;
  const at = Math.abs(sent - now) <= MAX_CLOCK_SKEW_MS ? sent : now;
  const shared = {
    anvesa_version: batch.anvesaVersion,
    ...pick(batch.platform, PLATFORM_FIELDS, 'platform_'),
    // No person profile and no location: the events are anonymous counts.
    $process_person_profile: false,
    $geoip_disable: true,
  };
  const events: PostHogEvent[] = [];
  for (const event of batch.events) {
    const type = (event as { readonly type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) continue;
    events.push({
      event: `anvesa_${type}`,
      distinct_id: batch.sessionId,
      timestamp: new Date(at).toISOString(),
      properties: { ...shared, ...pick(event, EVENT_FIELDS) },
    });
  }
  return events;
}

export async function handle(
  request: Request,
  env: Env,
  context: WorkerContext,
  send: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const events = toPostHogEvents(payload, Date.now());
  if (events === undefined) return new Response(null, { status: 400 });
  if (events.length > 0 && env.POSTHOG_KEY) {
    // After the response: the CLI waits for nothing but the 204. A failed forward is the
    // runtime's to report; the batch is not retried.
    context.waitUntil(
      send(`${env.POSTHOG_HOST ?? DEFAULT_HOST}/batch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch: events }),
      }),
    );
  }
  return new Response(null, { status: 204 });
}

export default {
  fetch: (request: Request, env: Env, context: WorkerContext) => handle(request, env, context),
};
