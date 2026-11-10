import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import {
  countBucket,
  durationBucket,
  generateEphemeralSessionId,
  memoryBucket,
  NoopTelemetryCollector,
  type TelemetryCollector,
  type TelemetryEvent,
  type TelemetryPayload,
  type TelemetryPlatform,
} from '@cntxt-labs/anvesa-core';
import {
  builtinModel,
  type ProjectConfig,
  type RankingEvent,
  summarizeStages,
} from '@cntxt-labs/anvesa-retriever';
import { VERSION } from './version.ts';

/**
 * Anonymous usage telemetry: what is sent is in core/src/telemetry.ts, where it goes is the
 * collector in telemetry/ (it drops the client address and forwards to the analytics store).
 *
 * It is on unless turned off, and nothing is sent before the person has been told: the first run
 * that would send prints `TELEMETRY_NOTICE` instead, remembers that it did, and sends nothing. A
 * process nobody watches (the MCP server, CI) never shows the notice, so it sends nothing until a
 * run in a terminal has. The only thing kept between runs is that choice, in the `preferences`
 * block of the per-user config (`~/.anvesa/config.json`).
 */

/**
 * Where batches go when `ANVESA_TELEMETRY_ENDPOINT` does not say: the collector in telemetry/, once
 * it is deployed. Undefined until then, and with no endpoint nothing leaves the machine.
 */
export const DEFAULT_TELEMETRY_ENDPOINT: string | undefined = undefined;

const MAX_BUFFER_EVENTS = 50;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_TIMEOUT_MS = 600;
/**
 * At close a command is done and the person is waiting for the prompt: the last batch gets this
 * long, and is dropped if the collector is slower.
 */
const CLOSE_TIMEOUT_MS = 150;
const USER_CONFIG_FILE = 'config.json';

export const TELEMETRY_NOTICE = `anvesa collects anonymous usage telemetry: which command or tool ran, how long it took and how many
results it gave (in ranges), the built-in model, and how search ranking reordered results. Never
queries, code, paths, file or symbol names, or your IP. Nothing was sent this run.
  turn it off:  anvesa telemetry off   (or DO_NOT_TRACK=1)
  details:      anvesa telemetry status
`;

type Env = Readonly<Record<string, string | undefined>>;

/** What the person chose, kept between runs. Nothing else is. */
export interface TelemetryChoice {
  /** `false`: off. `true`: on, said in so many words. Absent: the default, which is on. */
  readonly enabled?: boolean;
  /** Whether `TELEMETRY_NOTICE` has been shown, so the default may send. */
  readonly notice_shown?: boolean;
}

/**
 * The per-user anvesa config, `config.json` in `ANVESA_HOME` (else `~/.anvesa`), or `undefined`
 * when there is no home to keep it in. The choice is its `preferences.telemetry` block.
 */
export function userConfigFile(env: Env): string | undefined {
  if (env.ANVESA_HOME) return join(env.ANVESA_HOME, USER_CONFIG_FILE);
  const home = env.HOME ?? env.USERPROFILE;
  return home ? join(home, '.anvesa', USER_CONFIG_FILE) : undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type UserConfig = { readonly config: Record<string, unknown> } | { readonly problem: string };

const errorCode = (failure: unknown): string => {
  const code = (failure as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
};

/**
 * The user config as it is on disk: `{}` when it does not exist. Anything else that stops it being
 * read (not JSON, locked, unreadable) is a problem: nothing is read from it, and nothing may be
 * written over it, or the rest of the file would be lost.
 */
function readUserConfig(path: string): UserConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (failure) {
    if (errorCode(failure) === 'ENOENT') return { config: {} };
    return { problem: `${path} could not be read (${errorCode(failure)})` };
  }
  try {
    const raw: unknown = JSON.parse(text);
    return isObject(raw) ? { config: raw } : { problem: `${path} is not a JSON object` };
  } catch {
    // Someone may be editing it. Read nothing from it, and never write over it.
    return { problem: `${path} is not valid JSON` };
  }
}

export function readTelemetryChoice(env: Env): TelemetryChoice {
  const path = userConfigFile(env);
  const read = path ? readUserConfig(path) : undefined;
  const preferences = read && 'config' in read ? read.config.preferences : undefined;
  const telemetry = isObject(preferences) ? preferences.telemetry : undefined;
  if (!isObject(telemetry)) return {};
  const { enabled, notice_shown } = telemetry;
  return {
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(notice_shown === true ? { notice_shown } : {}),
  };
}

/**
 * Keep the choice in the user config's `preferences.telemetry`, leaving everything else in the file
 * as it was. Returns `undefined` when it was kept, else why not: no home, a file that exists but
 * cannot be read as JSON (it is never written over), or a failed write.
 */
export function writeTelemetryChoice(env: Env, choice: TelemetryChoice): string | undefined {
  const path = userConfigFile(env);
  if (!path) return 'neither ANVESA_HOME nor HOME (or USERPROFILE) is set';
  const read = readUserConfig(path);
  if ('problem' in read) return read.problem;
  const preferences = isObject(read.config.preferences) ? read.config.preferences : {};
  const next = { ...read.config, preferences: { ...preferences, telemetry: choice } };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
    return undefined;
  } catch (failure) {
    return `${path} could not be written (${errorCode(failure)})`;
  }
}

export interface TelemetryClientOptions {
  readonly config?: ProjectConfig;
  readonly noNetwork?: boolean;
  readonly env?: Env;
  /** Prints the notice. Absent where nobody would read it (the MCP server): then nothing is sent. */
  readonly notice?: (text: string) => void;
  readonly onPayload?: (payload: TelemetryPayload) => Promise<void> | void;
}

export interface TelemetryStatus {
  /** Whether this run records and delivers events. */
  readonly active: boolean;
  /** Why, in words: what `anvesa telemetry status` prints. */
  readonly reason: string;
  /** On by default but not shown the notice yet: this run shows it and sends nothing. */
  readonly needsNotice: boolean;
  readonly endpoint?: string;
  readonly logFile?: string;
}

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
const isOn = (value: string | undefined): boolean =>
  value === '1' || value?.toLowerCase() === 'true';

/** Whether this run sends telemetry, and why: the first rule that applies decides. */
export function telemetryStatus(options: TelemetryClientOptions = {}): TelemetryStatus {
  const env = options.env ?? process.env;
  const off = (reason: string): TelemetryStatus => ({ active: false, reason, needsNotice: false });

  if (options.noNetwork) return off('--no-network is set');
  for (const name of ['DO_NOT_TRACK', 'ANVESA_NO_TELEMETRY', 'ANVESA_NO_NETWORK']) {
    if (isOn(env[name])) return off(`${name} is set`);
  }
  const variable = env.ANVESA_TELEMETRY;
  if (variable === '0' || variable?.toLowerCase() === 'false') return off('ANVESA_TELEMETRY=0');
  // A CI run has nobody to read the notice, and its numbers are not a person's use.
  if (isSet(env.CI)) return off('running in CI (CI is set)');
  const project = options.config?.telemetry;
  if (project === false || (typeof project === 'object' && project.enabled === false)) {
    return off('turned off in .anvesa/config.json');
  }
  const choice = readTelemetryChoice(env);
  if (choice.enabled === false) return off('turned off with `anvesa telemetry off`');

  const endpoint = env.ANVESA_TELEMETRY_ENDPOINT || DEFAULT_TELEMETRY_ENDPOINT;
  const logFile = env.ANVESA_TELEMETRY_LOG_FILE || env.ANVESA_TELEMETRY_LOG || undefined;
  if (!endpoint && !logFile) return off('this build has no collector to send to');
  const where = { ...(endpoint ? { endpoint } : {}), ...(logFile ? { logFile } : {}) };

  // Written only to a local file, nothing leaves the machine: no notice is owed.
  const consented = choice.enabled === true || choice.notice_shown === true || isOn(variable);
  if (endpoint && !consented) {
    if (!userConfigFile(env)) return off('no home directory to remember the notice in');
    return { active: false, reason: 'the notice has not been shown yet', needsNotice: true };
  }
  return { active: true, reason: 'on', needsNotice: false, ...where };
}

export function getPlatformInfo(): TelemetryPlatform {
  const platform = process.platform;
  const osType: TelemetryPlatform['os'] =
    platform === 'linux' || platform === 'darwin' || platform === 'win32' ? platform : 'other';

  const arch = process.arch;
  const archType: TelemetryPlatform['arch'] = arch === 'x64' || arch === 'arm64' ? arch : 'other';

  const cpuCores = os.cpus?.()?.length ?? 1;
  const totalMem = os.totalmem?.() ?? 4 * 1024 * 1024 * 1024;
  const runtime: TelemetryPlatform['runtime'] =
    typeof (globalThis as { readonly Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node';

  return {
    os: osType,
    arch: archType,
    cpuCores,
    totalMemoryGbBucket: memoryBucket(totalMem),
    runtime,
  };
}

export interface CollectorTargets {
  readonly endpoint?: string;
  readonly logFile?: string;
  readonly onPayload?: (payload: TelemetryPayload) => Promise<void> | void;
}

export class ActiveTelemetryCollector implements TelemetryCollector {
  readonly enabled = true;
  private readonly events: TelemetryEvent[] = [];
  private readonly platform: TelemetryPlatform;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private activeFlushPromise: Promise<void> | null = null;
  lastDeliveryError: string | undefined;

  constructor(private readonly targets: CollectorTargets = {}) {
    this.platform = getPlatformInfo();
    // Periodic flush for long-running processes (the MCP server), unref'd so it never holds exit.
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  record(event: TelemetryEvent): void {
    this.events.push(event);
    if (this.events.length >= MAX_BUFFER_EVENTS) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    while (this.activeFlushPromise) {
      await this.activeFlushPromise;
    }
    if (this.events.length === 0) return;

    this.activeFlushPromise = this.deliver(this.events.splice(0, this.events.length)).finally(
      () => {
        this.activeFlushPromise = null;
      },
    );
    await this.activeFlushPromise;
    if (this.events.length >= MAX_BUFFER_EVENTS) {
      await this.flush();
    }
  }

  private closing = false;

  private async deliver(batch: TelemetryEvent[]): Promise<void> {
    const payload: TelemetryPayload = {
      schemaVersion: '1.0.0',
      sessionId: generateEphemeralSessionId(),
      timestamp: Date.now(),
      anvesaVersion: VERSION,
      platform: this.platform,
      events: batch,
    };
    const body = JSON.stringify(payload);
    const attempt = async (send: () => Promise<unknown>): Promise<void> => {
      try {
        await send();
      } catch (failure) {
        this.lastDeliveryError = failure instanceof Error ? failure.message : String(failure);
      }
    };
    const { onPayload, logFile, endpoint } = this.targets;
    if (onPayload) await attempt(async () => onPayload(payload));
    if (logFile) {
      await attempt(async () => {
        await mkdir(dirname(logFile), { recursive: true });
        await appendFile(logFile, `${body}\n`, 'utf8');
      });
    }
    if (endpoint) {
      await attempt(() =>
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.closing ? CLOSE_TIMEOUT_MS : FLUSH_TIMEOUT_MS),
        }),
      );
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.closing = true;
    await this.flush();
  }
}

let globalTelemetry: TelemetryCollector | undefined;

export function getGlobalTelemetry(): TelemetryCollector {
  if (!globalTelemetry) {
    globalTelemetry = new NoopTelemetryCollector();
  }
  return globalTelemetry;
}

export function setGlobalTelemetry(collector: TelemetryCollector): void {
  globalTelemetry = collector;
}

/** Put the no-op collector back, if `collector` (now closed) is still the global one. */
export function clearGlobalTelemetry(collector: TelemetryCollector): void {
  if (globalTelemetry === collector) globalTelemetry = undefined;
}

/**
 * The collector for this run. When the notice is owed and there is someone to show it to, it is
 * shown and remembered, and this run still sends nothing: the person can turn it off first.
 */
export function createTelemetryCollector(options: TelemetryClientOptions = {}): TelemetryCollector {
  const status = telemetryStatus(options);
  if (status.needsNotice && options.notice) {
    const env = options.env ?? process.env;
    const problem = writeTelemetryChoice(env, { ...readTelemetryChoice(env), notice_shown: true });
    if (problem === undefined) {
      options.notice(TELEMETRY_NOTICE);
    }
  }
  if (!status.active) return new NoopTelemetryCollector();
  return new ActiveTelemetryCollector({
    ...(status.endpoint ? { endpoint: status.endpoint } : {}),
    ...(status.logFile ? { logFile: status.logFile } : {}),
    ...(options.onPayload ? { onPayload: options.onPayload } : {}),
  });
}

/** A model as telemetry may name it: a built-in id, or `custom` for one the person brought. */
export function telemetryModelId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return builtinModel(id) ? id : 'custom';
}

/**
 * Record what ranking did (`RetrieverOptions.onRanking`): for a search, how far the ranker moved
 * the first stage's results and what it cost; for an index run, what the hub step cost and over
 * how many cards. The query and the symbols it names stay here.
 */
export function recordRanking(event: RankingEvent): void {
  const telemetry = getGlobalTelemetry();
  if (!telemetry.enabled) return;
  if (event.kind === 'index') {
    telemetry.record({
      type: 'index',
      name: 'hub',
      durationMsBucket: durationBucket(event.hub.hubMs),
      totalMsBucket: durationBucket(event.hub.totalMs),
      nodeCountBucket: countBucket(event.hub.cards),
    });
    return;
  }
  const summary = summarizeStages(event.stages);
  const model = telemetryModelId(event.model);
  telemetry.record({
    type: 'rank',
    name: 'symbols',
    ...(model ? { modelId: model } : {}),
    candidateCount: summary.candidates,
    reranked: summary.reranked,
    topChanged: summary.topChanged,
    ...(summary.shownTopFirstRank !== undefined && summary.shownTopFirstRank >= 0
      ? { topFirstRank: summary.shownTopFirstRank }
      : {}),
    overlapAt10: Math.round(summary.overlapAt10 * 10) / 10,
    durationMsBucket: durationBucket(summary.firstMs),
    ...(summary.rankedMs !== undefined ? { rankMsBucket: durationBucket(summary.rankedMs) } : {}),
  });
}
