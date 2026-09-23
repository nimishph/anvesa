import { type Page, type PageRequest, paginate } from '@cntxt-labs/code-lens-core';
import { StoreOperationError } from '../errors.ts';
import type { FileFacts, SymbolFact } from '../extract/index.ts';
import type {
  CallQuery,
  CallRecord,
  CorpusQuery,
  EdgeQuery,
  EdgeRecord,
  FileListQuery,
  FileQuarantine,
  FileState,
  ImportQuery,
  ImportRecord,
  IndexedFile,
  IndexStats,
  IndexStore,
  StoredCorpusRecord,
  SymbolQuery,
} from './types.ts';

/**
 * Orders paths by code point, which is the byte order of their UTF-8, which is how SQLite orders
 * text. Plain `<` on strings orders by UTF-16 unit and disagrees for characters outside the
 * Basic Multilingual Plane.
 */
export function comparePaths(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return Number(!x.done) - Number(!y.done);
    const difference = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (difference !== 0) return difference;
  }
}

const startsWith = (value: string, prefix: string | undefined): boolean =>
  prefix === undefined || value.startsWith(prefix);

/** The reference index store, all in memory. What the SQLite store is checked against. */
export class MemoryIndexStore implements IndexStore {
  readonly #files = new Map<string, IndexedFile>();
  readonly #quarantine = new Map<string, FileQuarantine>();
  readonly #edges = new Map<string, readonly EdgeRecord[]>();
  readonly #meta = new Map<string, string>();
  readonly #corpusRecords = new Map<string, StoredCorpusRecord>();

  #sortedPaths(): string[] {
    return [...this.#files.keys()].sort(comparePaths);
  }

  async fileState(path: string): Promise<FileState | undefined> {
    const file = this.#files.get(path);
    if (file) return stateOfFile(file);
    const held = this.#quarantine.get(path);
    return held ? stateOfQuarantine(held) : undefined;
  }

  async files(query: FileListQuery = {}): Promise<Page<FileState>> {
    const all: FileState[] = [];
    if (query.status !== 'quarantined') {
      for (const file of this.#files.values()) all.push(stateOfFile(file));
    }
    if (query.status !== 'indexed') {
      for (const held of this.#quarantine.values()) all.push(stateOfQuarantine(held));
    }
    return paginate(
      all
        .filter((state) => startsWith(state.path, query.pathPrefix))
        .sort((a, b) => comparePaths(a.path, b.path)),
      query,
    );
  }

  async replaceFile(file: IndexedFile): Promise<void> {
    this.#quarantine.delete(file.path);
    this.#edges.delete(file.path);
    this.#files.set(file.path, file);
  }

  async quarantineFile(entry: FileQuarantine): Promise<void> {
    this.#files.delete(entry.path);
    this.#edges.delete(entry.path);
    this.#quarantine.set(entry.path, entry);
  }

  async touchFile(path: string, size: number, mtimeMs: number): Promise<boolean> {
    const file = this.#files.get(path);
    if (!file) return false;
    this.#files.set(path, { ...file, size, mtimeMs });
    return true;
  }

  async putCorpusRecords(records: readonly StoredCorpusRecord[]): Promise<void> {
    for (const record of records) {
      this.#corpusRecords.set(`${record.corpus}:${record.id}`, record);
    }
  }

  async findCorpusRecords(query: CorpusQuery = {}): Promise<Page<StoredCorpusRecord>> {
    const all = [...this.#corpusRecords.values()]
      .filter(
        (r) =>
          (query.corpus === undefined || r.corpus === query.corpus) &&
          (query.path === undefined || r.path === query.path),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    return paginate(all, query);
  }

  async corpusPaths(corpus: string): Promise<readonly string[]> {
    const paths = new Set<string>();
    for (const r of this.#corpusRecords.values()) {
      if (r.corpus === corpus) paths.add(r.path);
    }
    return [...paths].sort(comparePaths);
  }

  async removeFile(path: string): Promise<boolean> {
    this.#edges.delete(path);
    const removedFile = this.#files.delete(path);
    const removedQuarantine = this.#quarantine.delete(path);
    return removedFile || removedQuarantine;
  }

  async quarantinedFiles(request: PageRequest = {}): Promise<Page<FileQuarantine>> {
    return paginate(
      [...this.#quarantine.values()].sort((a, b) => comparePaths(a.path, b.path)),
      request,
    );
  }

  async facts(path: string): Promise<FileFacts | undefined> {
    return this.#files.get(path)?.facts;
  }

  async wexpr(path: string, formatVersion: number): Promise<string | undefined> {
    const cached = this.#files.get(path)?.wexpr;
    return cached?.formatVersion === formatVersion ? cached.text : undefined;
  }

  async symbol(id: string): Promise<SymbolFact | undefined> {
    for (const file of this.#files.values()) {
      const found = file.facts.symbols.find((symbol) => symbol.id === id);
      if (found) return found;
    }
    return undefined;
  }

  async findSymbols(query: SymbolQuery = {}): Promise<Page<SymbolFact>> {
    const matches: SymbolFact[] = [];
    for (const path of this.#sortedPaths()) {
      if (query.path !== undefined && path !== query.path) continue;
      if (!startsWith(path, query.pathPrefix)) continue;
      for (const symbol of this.#files.get(path)?.facts.symbols ?? []) {
        if (query.name !== undefined && symbol.name !== query.name) continue;
        if (query.baseName !== undefined && symbol.baseName !== query.baseName) continue;
        if (query.kind !== undefined && symbol.kind !== query.kind) continue;
        if (query.exportedOnly && symbol.exported !== true) continue;
        matches.push(symbol);
      }
    }
    return paginate(matches, query);
  }

  async findCalls(query: CallQuery = {}): Promise<Page<CallRecord>> {
    const matches: CallRecord[] = [];
    for (const path of this.#sortedPaths()) {
      if (query.path !== undefined && path !== query.path) continue;
      for (const call of this.#files.get(path)?.facts.calls ?? []) {
        if (query.name !== undefined && call.name !== query.name) continue;
        if (query.from !== undefined && call.from !== query.from) continue;
        matches.push({ ...call, path });
      }
    }
    return paginate(matches, query);
  }

  async findImports(query: ImportQuery = {}): Promise<Page<ImportRecord>> {
    const matches: ImportRecord[] = [];
    for (const path of this.#sortedPaths()) {
      if (query.path !== undefined && path !== query.path) continue;
      for (const entry of this.#files.get(path)?.facts.imports ?? []) {
        if (query.specifier !== undefined && entry.specifier !== query.specifier) continue;
        matches.push({ ...entry, path });
      }
    }
    return paginate(matches, query);
  }

  async replaceEdges(sourcePath: string, edges: readonly EdgeRecord[]): Promise<void> {
    if (!this.#files.has(sourcePath)) {
      throw new StoreOperationError('store edges', undefined, {
        context: { sourcePath, problem: 'the file is not in the index' },
      });
    }
    this.#edges.set(sourcePath, [...edges]);
  }

  async findEdges(query: EdgeQuery = {}): Promise<Page<EdgeRecord>> {
    const matches: EdgeRecord[] = [];
    for (const source of [...this.#edges.keys()].sort(comparePaths)) {
      for (const edge of this.#edges.get(source) ?? []) {
        if (query.from !== undefined && edge.from !== query.from) continue;
        if (query.to !== undefined && edge.to !== query.to) continue;
        if (query.kind !== undefined && edge.kind !== query.kind) continue;
        if (query.kinds !== undefined && !query.kinds.includes(edge.kind)) continue;
        matches.push(edge);
      }
    }
    return paginate(matches, query);
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.#meta.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.#meta.set(key, value);
  }

  async deleteMeta(key: string): Promise<boolean> {
    return this.#meta.delete(key);
  }

  async stats(): Promise<IndexStats> {
    let symbols = 0;
    let calls = 0;
    let imports = 0;
    let edges = 0;
    const languages = new Map<string, number>();
    for (const file of this.#files.values()) {
      symbols += file.facts.symbols.length;
      calls += file.facts.calls.length;
      imports += file.facts.imports.length;
      languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
    }
    for (const list of this.#edges.values()) edges += list.length;
    return {
      files: this.#files.size,
      quarantinedFiles: this.#quarantine.size,
      symbols,
      calls,
      imports,
      edges,
      byLanguage: [...languages.entries()]
        .sort(([a], [b]) => comparePaths(a, b))
        .map(([language, files]) => ({ language, files })),
    };
  }

  async close(): Promise<void> {
    // Nothing is held outside memory, so there is nothing to release.
  }
}

function stateOfFile(file: IndexedFile): FileState {
  return {
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    contentHash: file.contentHash,
    status: 'indexed',
  };
}

function stateOfQuarantine(entry: FileQuarantine): FileState {
  return {
    path: entry.path,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    contentHash: entry.contentHash ?? '',
    status: 'quarantined',
  };
}
