/**
 * NAPI-RS native Rust bridge for @cntxt-labs/anvesa-dense.
 * Delegates SIMD vector math, normalization, and batch top-k scanning to crates/anvesa-napi.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ScoredIndex {
  readonly index: number;
  readonly score: number;
}

export interface NapiLaneHit {
  readonly key: string;
  readonly score?: number;
}

export interface NapiLane {
  readonly name: string;
  readonly weight: number;
  readonly hits: readonly NapiLaneHit[];
}

export interface NapiContribution {
  readonly lane: string;
  readonly rank: number;
  readonly weight: number;
  readonly score?: number;
}

export interface NapiFusedResult {
  readonly key: string;
  readonly score: number;
  readonly bestScore?: number;
  readonly foundBy: readonly NapiContribution[];
}

export interface NapiScanHit {
  readonly id: string;
  readonly score: number;
}

/** Exactly one is set. A database that cannot be opened or read throws instead. */
export interface NapiScanResult {
  readonly hits?: readonly NapiScanHit[];
  readonly corrupt?: {
    readonly id: string;
    readonly expectedBytes: number;
    readonly actualBytes: number;
  };
  readonly expired?: boolean;
}

export interface RustDenseBinding {
  dotProductSimd(a: Float32Array, b: Float32Array): number;
  normalizeSimd(vector: Float32Array): Float32Array;
  batchScanTopK(
    query: Float32Array,
    vectorsBuffer: Uint8Array,
    dims: number,
    limit: number,
  ): ScoredIndex[];
  batchDotProduct(query: Float32Array, vectorsBuffer: Uint8Array, dims: number): Float32Array;
  fuseRankingsNative(lanes: readonly NapiLane[], k?: number): NapiFusedResult[];
  /** Absent from addons built before it existed; callers check before they call. */
  scanVectorsNative?(
    dbPath: string,
    channel: string,
    model: string,
    query: Float32Array,
    limit: number,
    collapse: boolean,
    remainingMs?: number,
  ): NapiScanResult;
  /** Close the connection `scanVectorsNative` keeps for `dbPath`. */
  releaseVectorScan?(dbPath: string): void;
}

let nativeModule: RustDenseBinding | null = null;
let attempted = false;
let forcePureTs = false;

export function setRustDenseEnabled(enabled: boolean): void {
  forcePureTs = !enabled;
}

export function isRustDenseEnabled(): boolean {
  if (
    forcePureTs ||
    process.env.ANVESA_DISABLE_NATIVE === '1' ||
    process.env.ANVESA_DISABLE_NATIVE === 'true'
  ) {
    return false;
  }
  return isRustDenseAvailable();
}

export function loadRustDense(): RustDenseBinding | null {
  if (
    forcePureTs ||
    process.env.ANVESA_DISABLE_NATIVE === '1' ||
    process.env.ANVESA_DISABLE_NATIVE === 'true'
  ) {
    return null;
  }
  if (attempted) {
    return nativeModule;
  }
  attempted = true;

  const candidates = rustDenseBindingCandidates();

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        nativeModule = require(candidate) as RustDenseBinding;
        return nativeModule;
      } catch (failure) {
        if (failure) continue;
      }
    }
  }

  return null;
}

export function rustDenseBindingCandidates(moduleDir = __dirname): readonly string[] {
  const rootDir = join(moduleDir, '..', '..');
  const executableDir = dirname(process.execPath);
  return [
    join(executableDir, 'runtime', 'anvesa_napi.node'),
    join(executableDir, 'runtime', 'anvesa_napi.dll'),
    join(executableDir, 'anvesa_napi.node'),
    join(executableDir, 'anvesa_napi.dll'),
    join(rootDir, 'crates', 'anvesa-napi', 'anvesa_napi.node'),
    join(rootDir, 'target', 'release', 'anvesa_napi.node'),
    join(rootDir, 'target', 'release', 'anvesa_napi.dll'),
    join(rootDir, 'target', 'debug', 'anvesa_napi.node'),
    join(rootDir, 'target', 'debug', 'anvesa_napi.dll'),
    join(moduleDir, 'anvesa_napi.node'),
  ];
}

export function isRustDenseAvailable(): boolean {
  if (
    forcePureTs ||
    process.env.ANVESA_DISABLE_NATIVE === '1' ||
    process.env.ANVESA_DISABLE_NATIVE === 'true'
  ) {
    return false;
  }
  return loadRustDense() !== null;
}
