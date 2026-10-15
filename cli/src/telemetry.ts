import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { dirname } from 'node:path';
import {
  generateEphemeralSessionId,
  memoryBucket,
  NoopTelemetryCollector,
  type TelemetryCollector,
  type TelemetryEvent,
  type TelemetryPayload,
  type TelemetryPlatform,
} from '@cntxt-labs/anvesa-core';
import type { ProjectConfig } from '@cntxt-labs/anvesa-retriever';
import { VERSION } from './version.ts';

const MAX_BUFFER_EVENTS = 50;
const FLUSH_TIMEOUT_MS = 600;

export interface TelemetryClientOptions {
  readonly root?: string;
  readonly config?: ProjectConfig;
  readonly noNetwork?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly onPayload?: (payload: TelemetryPayload) => Promise<void> | void;
}

export function isTelemetryPermitted(options: TelemetryClientOptions = {}): boolean {
  if (options.noNetwork) return false;

  const env = options.env ?? process.env;
  if (env.ANVESA_NO_TELEMETRY === '1' || env.ANVESA_NO_TELEMETRY === 'true') return false;
  if (env.ANVESA_TELEMETRY === '0' || env.ANVESA_TELEMETRY === 'false') return false;
  if (
    env.DO_NOT_TRACK === '1' ||
    env.DO_NOT_TRACK === 'true' ||
    env.DO_NOT_TRACK?.toLowerCase() === 'true'
  ) {
    return false;
  }
  if (env.ANVESA_NO_NETWORK === '1' || env.ANVESA_NO_NETWORK === 'true') return false;

  const cfg = options.config?.telemetry;
  if (cfg === false) return false;
  if (typeof cfg === 'object' && cfg.enabled === false) return false;

  return true;
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

export class ActiveTelemetryCollector implements TelemetryCollector {
  readonly enabled = true;
  private readonly events: TelemetryEvent[] = [];
  private readonly options: TelemetryClientOptions;
  private readonly platform: TelemetryPlatform;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private activeFlushPromise: Promise<void> | null = null;
  lastDeliveryError: string | undefined;

  constructor(options: TelemetryClientOptions = {}) {
    this.options = options;
    this.platform = getPlatformInfo();

    // Periodic flush for long-running processes (e.g. MCP server), unref'd so it never blocks exit
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 30000);
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

    this.activeFlushPromise = (async () => {
      const batch = this.events.splice(0, this.events.length);
      const payload: TelemetryPayload = {
        schemaVersion: '1.0.0',
        sessionId: generateEphemeralSessionId(),
        timestamp: Date.now(),
        anvesaVersion: VERSION,
        platform: this.platform,
        events: batch,
      };

      try {
        // 1. In-memory / Test listener
        if (this.options.onPayload) {
          await this.options.onPayload(payload);
        }

        // 2. Local file audit sink (strictly from environment variable to protect against untrusted repos)
        const env = this.options.env ?? process.env;
        const logFile = env.ANVESA_TELEMETRY_LOG_FILE ?? env.ANVESA_TELEMETRY_LOG;

        if (logFile) {
          try {
            await mkdir(dirname(logFile), { recursive: true });
            await appendFile(logFile, `${JSON.stringify(payload)}\n`, 'utf8');
          } catch (failure) {
            this.lastDeliveryError = failure instanceof Error ? failure.message : String(failure);
          }
        }

        // 3. Remote HTTP endpoint (strictly from environment variable to protect against untrusted repos)
        const endpoint = env.ANVESA_TELEMETRY_ENDPOINT;

        if (endpoint && !this.options.noNetwork) {
          try {
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
            });
          } catch (failure) {
            this.lastDeliveryError = failure instanceof Error ? failure.message : String(failure);
          }
        }
      } catch (failure) {
        this.lastDeliveryError = failure instanceof Error ? failure.message : String(failure);
      }
    })().finally(() => {
      this.activeFlushPromise = null;
    });

    await this.activeFlushPromise;
    if (this.events.length >= MAX_BUFFER_EVENTS) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
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

export function createTelemetryCollector(options: TelemetryClientOptions = {}): TelemetryCollector {
  if (!isTelemetryPermitted(options)) {
    return new NoopTelemetryCollector();
  }
  return new ActiveTelemetryCollector(options);
}
