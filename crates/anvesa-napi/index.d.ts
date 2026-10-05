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

export interface NapiEncodeOptions {
  path?: string;
  docs?: boolean;
  positions?: boolean;
  maxDepth?: number;
}

/** The outline a LanguageMapping (its JSON) makes of one file, as JSON; null without a grammar. */
export function encodeOutlineNative(
  source: string,
  language: string,
  mappingJson: string,
  options?: NapiEncodeOptions,
): string | null;
/** Many files on every core; mappingsJson maps language keys to mappings. */
export function encodeOutlinesBatchNative(
  files: FileInput[],
  mappingsJson: string,
  options?: NapiEncodeOptions,
): (string | null)[];

export interface NapiScanHit {
  id: string;
  score: number;
}

export interface NapiCorruptVector {
  id: string;
  expectedBytes: number;
  actualBytes: number;
}

/** Exactly one is set. A database that cannot be opened or read throws instead. */
export interface NapiScanResult {
  hits?: NapiScanHit[];
  corrupt?: NapiCorruptVector;
  expired?: boolean;
}

/** Exact search over one channel and model's cards, ranked as SqliteVectorStore ranks. */
export function scanVectorsNative(
  dbPath: string,
  channel: string,
  model: string,
  query: Float32Array,
  limit: number,
  collapse: boolean,
  remainingMs?: number,
): NapiScanResult;

/** Close the connection scanVectorsNative keeps for dbPath, if it has one. */
export function releaseVectorScan(dbPath: string): void;

/** At most one is set: the facts as JSON, `unsupported` (read it another way), or the failure. */
export interface NapiExtractOutcome {
  json?: string;
  /** For the index: the facts alone, as JSON. */
  facts?: string;
  /** For the index: the outline as W-expression text. */
  wexpr?: string;
  unsupported?: boolean;
  error?: string;
}

/** Facts of many files on every core, off the JavaScript thread; one outcome per file, in order. */
export function extractFactsManyNative(
  files: FileInput[],
  mappingsJson: string,
): Promise<NapiExtractOutcome[]>;

/** As extractFactsManyNative, but ready for the index: facts as JSON, outline as W-expression text. */
export function extractForIndexManyNative(
  files: FileInput[],
  mappingsJson: string,
  omit: string[],
): Promise<NapiExtractOutcome[]>;
