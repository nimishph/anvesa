import { createHash, randomBytes } from 'node:crypto';

/**
 * Anvesa Anonymous & Non-IP Telemetry Contracts
 *
 * Guarantees:
 * 1. Zero-IP: Edge proxies discard client IP addresses.
 * 2. Zero-PII: No file paths, code snippets, query strings, git commits, or usernames.
 * 3. Ephemeral Session ID: Process-scoped in-memory random UUID. Zero disk persistence, zero machine fingerprinting.
 * 4. Zero Disruption: Non-blocking, fails silently, never throws or degrades performance.
 */

export type DurationBucket = '<10' | '10-50' | '50-200' | '200-1000' | '1000+';
export type CountBucket = '0' | '1-5' | '6-20' | '21-100' | '100+';
export type RatioBucket = '<0.25' | '0.25-0.5' | '0.5-0.75' | '0.75-1.0';
export type MemoryBucket = '<4' | '4-8' | '8-16' | '16-32' | '32+';

export interface TelemetryPlatform {
  readonly os: 'linux' | 'darwin' | 'win32' | 'other';
  readonly arch: 'x64' | 'arm64' | 'other';
  readonly cpuCores: number;
  readonly totalMemoryGbBucket: MemoryBucket;
  readonly runtime: 'bun' | 'node' | 'other';
}

export type TelemetryEventType =
  | 'cli_command'
  | 'search'
  | 'graph'
  | 'index'
  | 'grammar_extract'
  | 'mcp_tool_call'
  | 'error';

export interface TelemetryEvent {
  readonly type: TelemetryEventType;
  readonly name: string;
  readonly durationMsBucket?: DurationBucket;
  readonly searchMode?: 'fused' | 'semantic' | 'structural';
  readonly channelCount?: number;
  readonly hasWqlFilter?: boolean;
  readonly hasScope?: boolean;
  readonly resultCountBucket?: CountBucket;
  readonly modelId?: string;
  readonly language?: string;
  readonly nodeCountBucket?: CountBucket;
  readonly mappedRatioBucket?: RatioBucket;
  readonly errorCode?: string;
}

export interface TelemetryPayload {
  readonly schemaVersion: '1.0.0';
  readonly sessionId: string;
  readonly timestamp: number;
  readonly anvesaVersion: string;
  readonly platform: TelemetryPlatform;
  readonly events: readonly TelemetryEvent[];
}

export interface TelemetryCollector {
  readonly enabled: boolean;
  record(event: TelemetryEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function durationBucket(ms: number): DurationBucket {
  if (ms < 10) return '<10';
  if (ms < 50) return '10-50';
  if (ms < 200) return '50-200';
  if (ms < 1000) return '200-1000';
  return '1000+';
}

export function countBucket(count: number): CountBucket {
  if (count <= 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  if (count <= 100) return '21-100';
  return '100+';
}

export function ratioBucket(ratio: number): RatioBucket {
  if (ratio < 0.25) return '<0.25';
  if (ratio < 0.5) return '0.25-0.5';
  if (ratio < 0.75) return '0.5-0.75';
  return '0.75-1.0';
}

export function memoryBucket(bytes: number): MemoryBucket {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb < 4) return '<4';
  if (gb < 8) return '4-8';
  if (gb < 16) return '8-16';
  if (gb < 32) return '16-32';
  return '32+';
}

/**
 * Generates an ephemeral session UUID.
 * Never persists hardware identifiers, MAC addresses, or disk state.
 */
let dailyEphemeralSalt: string | undefined;

export function generateEphemeralSessionId(dateOverride?: string, saltOverride?: string): string {
  if (!dailyEphemeralSalt) {
    dailyEphemeralSalt = randomBytes(16).toString('hex');
  }
  const dateStr = dateOverride ?? new Date().toISOString().split('T')[0];
  const salt = saltOverride ?? dailyEphemeralSalt;
  const hash = createHash('sha256').update(`anvesa-session:${dateStr}:${salt}`).digest('hex');

  // Format as standard UUID v4 layout (8-4-4-4-12) via pattern match (avoids blind slicing)
  const match = hash.match(
    /^([0-9a-f]{8})([0-9a-f]{4})[0-9a-f]([0-9a-f]{3})[0-9a-f]([0-9a-f]{3})([0-9a-f]{12})/,
  );
  if (match) {
    return `${match[1]}-${match[2]}-4${match[3]}-a${match[4]}-${match[5]}`;
  }
  return randomBytes(16).toString('hex');
}

/**
 * Sanitizes any error to extract solely its alphanumeric code or generic category.
 * Absolutely prevents file paths, stack traces, or source text from leaking.
 */
export function sanitizeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN_ERROR';
  const maybeCode = (error as { readonly code?: unknown }).code;
  if (typeof maybeCode === 'string' && /^[A-Z0-9_]{3,32}$/.test(maybeCode)) {
    return maybeCode;
  }
  const maybeName = (error as { readonly name?: unknown }).name;
  if (typeof maybeName === 'string' && /^[A-Za-z0-9_]{3,32}$/.test(maybeName)) {
    return maybeName.toUpperCase();
  }
  return 'GENERIC_FAILURE';
}

/**
 * No-op collector used when telemetry is disabled or blocked.
 */
export class NoopTelemetryCollector implements TelemetryCollector {
  readonly enabled = false;
  record(_event: TelemetryEvent): void {
    // no-op: telemetry collection is disabled
  }
  async flush(): Promise<void> {
    // no-op: telemetry collection is disabled
  }
  async close(): Promise<void> {
    // no-op: telemetry collection is disabled
  }
}
