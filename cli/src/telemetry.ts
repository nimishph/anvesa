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
  if (env.DO_NOT_TRACK === '1') return false;
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
  private isFlushing = false;
  lastDeliveryError: string | undefined;

  constructor(options: TelemetryClientOptions = {}) {
    this.options = options;
    this.platform = getPlatformInfo();
  }

  record(event: TelemetryEvent): void {
    if (this.events.length >= MAX_BUFFER_EVENTS) {
      this.events.shift(); // Maintain ring buffer bound
    }
    this.events.push(event);
  }

  async flush(): Promise<void> {
    if (this.events.length === 0 || this.isFlushing) return;
    this.isFlushing = true;
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

      // 2. Local file audit sink (if configured)
      const env = this.options.env ?? process.env;
      const logFile =
        (typeof this.options.config?.telemetry === 'object'
          ? this.options.config.telemetry.logFile
          : undefined) ?? env.ANVESA_TELEMETRY_LOG;

      if (logFile) {
        try {
          await mkdir(dirname(logFile), { recursive: true });
          await appendFile(logFile, `${JSON.stringify(payload)}\n`, 'utf8');
        } catch (failure) {
          this.lastDeliveryError = failure instanceof Error ? failure.message : String(failure);
        }
      }

      // 3. Remote HTTP endpoint (if configured & network allowed)
      const endpoint =
        (typeof this.options.config?.telemetry === 'object'
          ? this.options.config.telemetry.endpoint
          : undefined) ?? env.ANVESA_TELEMETRY_ENDPOINT;

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
    } finally {
      this.isFlushing = false;
    }
  }

  async close(): Promise<void> {
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
