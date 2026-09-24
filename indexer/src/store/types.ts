import type { Page, PageRequest } from '@cntxt-labs/anvesa-core';
import type { CallFact, FileFacts, ImportFact, SymbolFact } from '../extract/index.ts';

/** What a run needs to know about a file to decide whether it must be looked at again. */
export interface FileFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
  readonly contentHash: string;
}

export type FileStatus = 'indexed' | 'quarantined';

export interface FileState extends FileFingerprint {
  readonly path: string;
  readonly status: FileStatus;
}

/** Everything the index keeps about one source file. Stored and replaced as a unit. */
export interface IndexedFile extends FileFingerprint {
  readonly path: string;
  readonly language: string;
  /** Root of the owning package, or `undefined` outside every package. */
  readonly packageRoot: string | undefined;
  /** `''` for the workspace's own repository, else the nested repository's directory. */
  readonly repo: string;
  readonly facts: FileFacts;
  /**
   * The W-expression text of the file, cached so structural queries need not reparse it. Stored
   * with the format version it was written in; a reader on another version gets a miss.
   */
  readonly wexpr?: { readonly formatVersion: number; readonly text: string };
}

/** Why a file is in quarantine. Each is a different fix for whoever reads the report. */
export type QuarantineReason =
  /** The file could not be read. */
  | 'unreadable'
  /** The file is binary, so it is not source. */
  | 'binary'
  /** The parser failed outright (not merely a syntax error, which still yields facts). */
  | 'parse-failed'
  /** Fact extraction failed. */
  | 'extract-failed'
  /** The file exceeded the deadline the caller gave. */
  | 'timed-out'
  /** The file appears to be a minified bundle or generated code. */
  | 'minified';

export interface FileQuarantine {
  readonly path: string;
  readonly reason: QuarantineReason;
  /** What went wrong, in words a status report can print. */
  readonly message: string;
  /** The `CodeLensError` code, when the cause was one. */
  readonly errorCode?: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** Known when the file was read before it failed. */
  readonly contentHash?: string;
}

export interface SymbolQuery extends PageRequest {
  /** Exact qualified name, e.g. `Outer.method`. */
  readonly name?: string;
  /** Exact last segment, e.g. `method`. */
  readonly baseName?: string;
  readonly kind?: string;
  readonly path?: string;
  /** Only symbols in paths starting with this. */
  readonly pathPrefix?: string;
  readonly exportedOnly?: boolean;
}

export interface CallRecord extends CallFact {
  /** The file the call is in. */
  readonly path: string;
}

export interface CallQuery extends PageRequest {
  /** The called name. */
  readonly name?: string;
  /** Calls made from inside this symbol id. */
  readonly from?: string;
  readonly path?: string;
}

export interface ImportRecord extends ImportFact {
  readonly path: string;
}

export interface ImportQuery extends PageRequest {
  /** The module as written. */
  readonly specifier?: string;
  readonly path?: string;
}

/** A resolved link between two things in the index. What the ends mean is up to the resolver. */

export interface StoredCorpusRecord {
  readonly corpus: string;
  readonly id: string;
  readonly path: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text?: string | undefined;
}

export interface CorpusQuery extends PageRequest {
  readonly corpus?: string;
  readonly path?: string;
}

export interface EdgeRecord {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

export interface EdgeQuery extends PageRequest {
  readonly from?: string;
  readonly to?: string;
  readonly kind?: string;
  /** Any of these kinds. Combines with `kind` by both having to hold. */
  readonly kinds?: readonly string[];
}

export interface FileListQuery extends PageRequest {
  readonly status?: FileStatus;
  readonly pathPrefix?: string;
}

export interface IndexStats {
  readonly files: number;
  readonly quarantinedFiles: number;
  readonly symbols: number;
  readonly calls: number;
  readonly imports: number;
  readonly edges: number;
  readonly byLanguage: readonly { readonly language: string; readonly files: number }[];
}

/**
 * Where the facts of a workspace live. Every write replaces one file's rows as a unit, so a crash
 * or a failure midway never leaves half of a file in the index. Lists are paginated and ordered
 * (by path, then position in the file), so the same query gives the same answer every time.
 */
export interface IndexStore {
  /** What is known of a file, indexed or quarantined; `undefined` if it has never been seen. */
  fileState(path: string): Promise<FileState | undefined>;
  files(query?: FileListQuery): Promise<Page<FileState>>;

  /** Store a file's facts, replacing everything held for it, quarantine included. */
  replaceFile(file: IndexedFile): Promise<void>;
  /** Record that a file could not be indexed. Drops any facts held for it. */
  quarantineFile(entry: FileQuarantine): Promise<void>;
  /**
   * Record a new size and modification time for an indexed file whose content is unchanged, so
   * the next run can skip reading it. Returns whether the file was indexed.
   */
  touchFile(path: string, size: number, mtimeMs: number): Promise<boolean>;
  /** Forget a file entirely. Returns whether it was known. */
  removeFile(path: string): Promise<boolean>;
  quarantinedFiles(request?: PageRequest): Promise<Page<FileQuarantine>>;

  /** The facts of an indexed file, or `undefined`. */
  facts(path: string): Promise<FileFacts | undefined>;
  /** The cached W-expression text, when there is one written in this format version. */
  wexpr(path: string, formatVersion: number): Promise<string | undefined>;

  symbol(id: string): Promise<SymbolFact | undefined>;
  findSymbols(query?: SymbolQuery): Promise<Page<SymbolFact>>;
  findCalls(query?: CallQuery): Promise<Page<CallRecord>>;
  findImports(query?: ImportQuery): Promise<Page<ImportRecord>>;

  /** Replace the links that originate in one file. */
  replaceEdges(sourcePath: string, edges: readonly EdgeRecord[]): Promise<void>;
  findEdges(query?: EdgeQuery): Promise<Page<EdgeRecord>>;

  putCorpusRecords(records: readonly StoredCorpusRecord[]): Promise<void>;
  findCorpusRecords(query?: CorpusQuery): Promise<Page<StoredCorpusRecord>>;
  corpusPaths(corpus: string): Promise<readonly string[]>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  deleteMeta(key: string): Promise<boolean>;
  stats(): Promise<IndexStats>;
  close(): Promise<void>;
}
