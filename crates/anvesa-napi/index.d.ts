export interface ScoredIndex {
  index: number;
  score: number;
}

export interface NapiSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
  doc?: string;
  exported: boolean;
}

export interface NapiCall {
  name: string;
  line: number;
  kind: string;
}

export interface NapiImport {
  specifier: string;
  kind: string;
  line: number;
}

export interface NapiFileOutline {
  path: string;
  language: string;
  symbols: NapiSymbol[];
  calls: NapiCall[];
  imports: NapiImport[];
  hasSyntaxErrors: boolean;
}

export interface FileInput {
  path: string;
  language: string;
  source: string;
}

export function dotProductSimd(a: Float32Array, b: Float32Array): number;
export function normalizeSimd(vector: Float32Array): Float32Array;
export function batchScanTopK(
  query: Float32Array,
  vectorsBuffer: Uint8Array,
  dims: number,
  limit: number,
): ScoredIndex[];
export function batchDotProduct(
  query: Float32Array,
  vectorsBuffer: Uint8Array,
  dims: number,
): Float32Array;

export function extractFileOutlineNative(
  path: string,
  language: string,
  source: string,
): NapiFileOutline;

export function parseFilesBatchNative(
  files: FileInput[],
): NapiFileOutline[];
