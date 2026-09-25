import type { Database, SQLQueryBindings } from 'bun:sqlite';
import {
  decodeCursor,
  encodeCursor,
  type Page,
  type PageRequest,
  resolveLimit,
} from '@cntxt-labs/anvesa-core';
import { StoreCorruptError } from '../errors.ts';
import type {
  CallFact,
  FileFacts,
  ImportBinding,
  ImportFact,
  Receiver,
  SymbolFact,
  TypeFact,
} from '../extract/index.ts';
import { allRows, getRow, StoreDatabase, type StoreOptions } from './database.ts';
import type {
  CallQuery,
  CallRecord,
  Confidence,
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
  QuarantineReason,
  StoredCorpusRecord,
  SymbolQuery,
} from './types.ts';

type Bindings = SQLQueryBindings[];

/** A `WHERE` clause built from optional filters, so a query names only what it constrains. */
class Where {
  readonly #clauses: string[] = [];
  readonly params: Bindings = [];

  equals(column: string, value: string | number | undefined): this {
    if (value !== undefined) {
      this.#clauses.push(`${column} = ?`);
      this.params.push(value);
    }
    return this;
  }

  /** Callers handle an empty list themselves: it matches nothing, so there is nothing to ask. */
  oneOf(column: string, values: readonly string[] | undefined): this {
    if (values !== undefined && values.length > 0) {
      this.#clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      this.params.push(...values);
    }
    return this;
  }

  prefix(column: string, value: string | undefined): this {
    if (value !== undefined && value !== '') {
      this.#clauses.push(`substr(${column}, 1, ?) = ?`);
      this.params.push([...value].length, value);
    }
    return this;
  }

  raw(clause: string): this {
    this.#clauses.push(clause);
    return this;
  }

  toString(): string {
    return this.#clauses.length === 0 ? '' : `WHERE ${this.#clauses.join(' AND ')}`;
  }
}

/**
 * Run a query as one page. `from` is everything after `FROM`, including its `WHERE`; `order` must
 * be a total order so pages neither overlap nor skip.
 */
function pageOf<Row, Item>(
  db: Database,
  spec: {
    readonly select: string;
    readonly from: string;
    readonly params: Bindings;
    readonly order: string;
  },
  request: PageRequest,
  map: (row: Row) => Item,
): Page<Item> {
  const { value: limit, source } = resolveLimit('limit', request.limit);
  const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor);
  // Statements are prepared and finalised here rather than cached: a cached statement that
  // ended without a row could stay active and keep the database file locked.
  const count = db.prepare(`SELECT count(*) AS n FROM ${spec.from}`);
  const select = db.prepare(
    `SELECT ${spec.select} FROM ${spec.from} ORDER BY ${spec.order} LIMIT ? OFFSET ?`,
  );
  let counted: { n: number };
  let rows: Row[];
  try {
    counted = count.get(...spec.params) as { n: number };
    rows = select.all(...spec.params, limit, offset) as Row[];
  } finally {
    count.finalize();
    select.finalize();
  }
  const end = offset + limit;
  const more = end < counted.n;
  return {
    items: rows.map(map),
    total: counted.n,
    nextCursor: more ? encodeCursor(end) : null,
    limit: { name: 'limit', applied: limit, source, reached: more },
  };
}

/** A page with nothing in it, carrying the limit the caller asked for. */
function emptyPage<Item>(request: PageRequest): Page<Item> {
  const { value, source } = resolveLimit('limit', request.limit);
  if (request.cursor !== undefined) decodeCursor(request.cursor);
  return {
    items: [],
    total: 0,
    nextCursor: null,
    limit: { name: 'limit', applied: value, source, reached: false },
  };
}

interface SymbolRow {
  id: string;
  path: string;
  name: string;
  base_name: string;
  kind: string;
  parent_id: string | null;
  exported: number | null;
  start_line: number;
  end_line: number;
  signature: string | null;
  params: string | null;
  doc: string | null;
  alias_of: string | null;
}

const SYMBOL_COLUMNS =
  'id, path, name, base_name, kind, parent_id, exported, start_line, end_line, signature, params, doc, alias_of';

function symbolOf(row: SymbolRow): SymbolFact {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    baseName: row.base_name,
    kind: row.kind,
    parentId: row.parent_id ?? undefined,
    exported: row.exported === null ? undefined : row.exported === 1,
    startLine: row.start_line,
    endLine: row.end_line,
    signature: row.signature ?? undefined,
    ...(row.params === null ? {} : { params: row.params }),
    doc: row.doc ?? undefined,
    ...(row.alias_of === null ? {} : { aliasOf: row.alias_of }),
  };
}

interface CallRow {
  path: string;
  from_symbol: string | null;
  name: string;
  receiver_kind: string | null;
  receiver_name: string | null;
  kind: string;
  line: number;
}

const CALL_COLUMNS = 'path, from_symbol, name, receiver_kind, receiver_name, kind, line';

function receiverOf(row: CallRow): Receiver | undefined {
  switch (row.receiver_kind) {
    case null:
      return undefined;
    case 'self':
      return { kind: 'self' };
    case 'complex':
      return { kind: 'complex' };
    case 'name':
      return { kind: 'name', name: row.receiver_name ?? '' };
    case 'result': {
      const inner = JSON.parse(row.receiver_name ?? 'null') as {
        name: string;
        receiver: Receiver | undefined;
      };
      return { kind: 'result', name: inner.name, receiver: inner.receiver ?? undefined };
    }
    default:
      throw new StoreCorruptError('calls', `${row.path}:${row.line}`, 'unknown receiver kind', {
        context: { receiverKind: row.receiver_kind },
      });
  }
}

function receiverName(receiver: Receiver | undefined): string | null {
  if (receiver?.kind === 'name') return receiver.name;
  if (receiver?.kind === 'result') {
    return JSON.stringify({ name: receiver.name, receiver: receiver.receiver ?? null });
  }
  return null;
}

function callOf(row: CallRow): CallRecord {
  return {
    path: row.path,
    from: row.from_symbol ?? undefined,
    name: row.name,
    receiver: receiverOf(row),
    kind: row.kind as CallFact['kind'],
    line: row.line,
  };
}

interface ImportRow {
  path: string;
  specifier: string;
  kind: string;
  relative: number;
  type_only: number;
  bindings: string;
  line: number;
}

const IMPORT_COLUMNS = 'path, specifier, kind, relative, type_only, bindings, line';

function importOf(row: ImportRow): ImportRecord {
  let bindings: ImportBinding[];
  try {
    bindings = JSON.parse(row.bindings) as ImportBinding[];
  } catch (failure) {
    throw new StoreCorruptError('imports', `${row.path}:${row.line}`, 'bindings are not JSON', {
      cause: failure,
    });
  }
  return {
    path: row.path,
    specifier: row.specifier,
    kind: row.kind as ImportFact['kind'],
    relative: row.relative === 1,
    typeOnly: row.type_only === 1,
    bindings,
    line: row.line,
  };
}

interface FileStateRow {
  path: string;
  size: number;
  mtime_ms: number;
  content_hash: string;
  status: 'indexed' | 'quarantined';
}

const STATE_UNION = `(
  SELECT path, size, mtime_ms, content_hash, 'indexed' AS status FROM files
  UNION ALL
  SELECT path, size, mtime_ms, coalesce(content_hash, '') AS content_hash, 'quarantined' AS status
    FROM file_quarantine
) AS all_files`;

function stateOf(row: FileStateRow): FileState {
  return {
    path: row.path,
    size: row.size,
    mtimeMs: row.mtime_ms,
    contentHash: row.content_hash,
    status: row.status,
  };
}

interface QuarantineRow {
  path: string;
  reason: string;
  message: string;
  error_code: string | null;
  size: number;
  mtime_ms: number;
  content_hash: string | null;
}

function quarantineOf(row: QuarantineRow): FileQuarantine {
  return {
    path: row.path,
    reason: row.reason as QuarantineReason,
    message: row.message,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    size: row.size,
    mtimeMs: row.mtime_ms,
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
  };
}

const flag = (value: boolean): number => (value ? 1 : 0);

/** The index store on SQLite. Every write replaces one file's rows in a single transaction. */
export class SqliteIndexStore implements IndexStore {
  readonly #database: StoreDatabase;
  readonly #owns: boolean;

  /** `owns`: close the database when this store is closed. */
  constructor(database: StoreDatabase, owns = false) {
    this.#database = database;
    this.#owns = owns;
  }

  /** Open (creating and migrating if needed) the database at `path`, and own it. */
  static open(path: string, options: StoreOptions = {}): SqliteIndexStore {
    return new SqliteIndexStore(StoreDatabase.open(path, options), true);
  }

  get database(): StoreDatabase {
    return this.#database;
  }

  async fileState(path: string): Promise<FileState | undefined> {
    return this.#database.guard('read a file state', (db) => {
      const row = getRow(
        db,
        `SELECT path, size, mtime_ms, content_hash, status FROM ${STATE_UNION} WHERE path = ?`,
        path,
      ) as FileStateRow | null;
      return row ? stateOf(row) : undefined;
    });
  }

  async files(query: FileListQuery = {}): Promise<Page<FileState>> {
    return this.#database.guard('list files', (db) => {
      const where = new Where().equals('status', query.status).prefix('path', query.pathPrefix);
      return pageOf<FileStateRow, FileState>(
        db,
        {
          select: 'path, size, mtime_ms, content_hash, status',
          from: `${STATE_UNION} ${where}`,
          params: where.params,
          order: 'path',
        },
        query,
        stateOf,
      );
    });
  }

  async replaceFile(file: IndexedFile): Promise<void> {
    this.#database.transaction('store a file', (db) => {
      clearFile(db, file.path);
      const { facts } = file;
      db.query(
        `INSERT INTO files (path, language, package_root, repo, size, mtime_ms, content_hash,
           has_syntax_errors, imports_supported, unnamed_calls, computed_imports)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        file.path,
        file.language,
        file.packageRoot ?? null,
        file.repo,
        file.size,
        file.mtimeMs,
        file.contentHash,
        flag(facts.hasSyntaxErrors),
        flag(facts.importsSupported),
        facts.gaps.unnamedCalls,
        facts.gaps.computedImports,
      );

      const insertSymbol = db.query(
        `INSERT INTO symbols (path, seq, ${SYMBOL_COLUMNS.replace('path, ', '')})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      facts.symbols.forEach((symbol, seq) => {
        insertSymbol.run(
          file.path,
          seq,
          symbol.id,
          symbol.name,
          symbol.baseName,
          symbol.kind,
          symbol.parentId ?? null,
          symbol.exported === undefined ? null : flag(symbol.exported),
          symbol.startLine,
          symbol.endLine,
          symbol.signature ?? null,
          symbol.params ?? null,
          symbol.doc ?? null,
          symbol.aliasOf ?? null,
        );
      });

      const insertCall = db.query(
        `INSERT INTO calls (path, seq, from_symbol, name, receiver_kind, receiver_name, kind, line)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      facts.calls.forEach((call, seq) => {
        insertCall.run(
          file.path,
          seq,
          call.from ?? null,
          call.name,
          call.receiver?.kind ?? null,
          receiverName(call.receiver),
          call.kind,
          call.line,
        );
      });

      const insertImport = db.query(
        `INSERT INTO imports (path, seq, specifier, kind, relative, type_only, bindings, line)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      facts.imports.forEach((entry, seq) => {
        insertImport.run(
          file.path,
          seq,
          entry.specifier,
          entry.kind,
          flag(entry.relative),
          flag(entry.typeOnly),
          JSON.stringify(entry.bindings),
          entry.line,
        );
      });

      const insertExport = db.query(
        'INSERT INTO exports (path, seq, name, local, line) VALUES (?, ?, ?, ?, ?)',
      );
      facts.exports.forEach((entry, seq) => {
        insertExport.run(file.path, seq, entry.name, entry.local, entry.line);
      });

      const insertType = db.query(
        'INSERT INTO type_bindings (path, seq, scope, name, type, origin) VALUES (?, ?, ?, ?, ?, ?)',
      );
      (facts.types ?? []).forEach((entry, seq) => {
        insertType.run(file.path, seq, entry.scope, entry.name, entry.type, entry.origin);
      });

      if (file.wexpr) {
        db.query('INSERT INTO wexpr_cache (path, format_version, text) VALUES (?, ?, ?)').run(
          file.path,
          file.wexpr.formatVersion,
          file.wexpr.text,
        );
      }
    });
  }

  async quarantineFile(entry: FileQuarantine): Promise<void> {
    this.#database.transaction('quarantine a file', (db) => {
      clearFile(db, entry.path);
      db.query(
        `INSERT INTO file_quarantine (path, reason, message, error_code, size, mtime_ms, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.path,
        entry.reason,
        entry.message,
        entry.errorCode ?? null,
        entry.size,
        entry.mtimeMs,
        entry.contentHash ?? null,
      );
    });
  }

  async touchFile(path: string, size: number, mtimeMs: number): Promise<boolean> {
    return this.#database.guard(
      'update a file stamp',
      (db) =>
        db.query('UPDATE files SET size = ?, mtime_ms = ? WHERE path = ?').run(size, mtimeMs, path)
          .changes > 0,
    );
  }

  async removeFile(path: string): Promise<boolean> {
    return this.#database.transaction('remove a file', (db) => clearFile(db, path));
  }

  async quarantinedFiles(request: PageRequest = {}): Promise<Page<FileQuarantine>> {
    return this.#database.guard('list quarantined files', (db) =>
      pageOf<QuarantineRow, FileQuarantine>(
        db,
        {
          select: 'path, reason, message, error_code, size, mtime_ms, content_hash',
          from: 'file_quarantine',
          params: [],
          order: 'path',
        },
        request,
        quarantineOf,
      ),
    );
  }

  async facts(path: string): Promise<FileFacts | undefined> {
    return this.#database.guard('read a file’s facts', (db) => {
      const file = getRow(
        db,
        `SELECT language, has_syntax_errors, imports_supported, unnamed_calls, computed_imports
           FROM files WHERE path = ?`,
        path,
      ) as {
        language: string;
        has_syntax_errors: number;
        imports_supported: number;
        unnamed_calls: number;
        computed_imports: number;
      } | null;
      if (!file) return undefined;
      const symbols = allRows(
        db,
        `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE path = ? ORDER BY seq`,
        path,
      ) as SymbolRow[];
      const calls = allRows(
        db,
        `SELECT ${CALL_COLUMNS} FROM calls WHERE path = ? ORDER BY seq`,
        path,
      ) as CallRow[];
      const imports = allRows(
        db,
        `SELECT ${IMPORT_COLUMNS} FROM imports WHERE path = ? ORDER BY seq`,
        path,
      ) as ImportRow[];
      const exports = allRows(
        db,
        'SELECT name, local, line FROM exports WHERE path = ? ORDER BY seq',
        path,
      ) as { name: string; local: string; line: number }[];
      const types = allRows(
        db,
        'SELECT scope, name, type, origin FROM type_bindings WHERE path = ? ORDER BY seq',
        path,
      ) as unknown as TypeFact[];
      return {
        path,
        language: file.language,
        symbols: symbols.map(symbolOf),
        exports,
        ...(types.length === 0 ? {} : { types }),
        calls: calls.map((row): CallFact => {
          const { path: _path, ...call } = callOf(row);
          return call;
        }),
        imports: imports.map((row): ImportFact => {
          const { path: _path, ...entry } = importOf(row);
          return entry;
        }),
        hasSyntaxErrors: file.has_syntax_errors === 1,
        importsSupported: file.imports_supported === 1,
        gaps: { unnamedCalls: file.unnamed_calls, computedImports: file.computed_imports },
      };
    });
  }

  async wexpr(path: string, formatVersion: number): Promise<string | undefined> {
    return this.#database.guard('read cached structure', (db) => {
      const row = getRow(
        db,
        'SELECT text FROM wexpr_cache WHERE path = ? AND format_version = ?',
        path,
        formatVersion,
      ) as { text: string } | null;
      return row?.text;
    });
  }

  async symbol(id: string): Promise<SymbolFact | undefined> {
    return this.#database.guard('read a symbol', (db) => {
      const row = getRow(
        db,
        `SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE id = ?`,
        id,
      ) as SymbolRow | null;
      return row ? symbolOf(row) : undefined;
    });
  }

  async findSymbols(query: SymbolQuery = {}): Promise<Page<SymbolFact>> {
    return this.#database.guard('find symbols', (db) => {
      const where = new Where()
        .equals('name', query.name)
        .equals('base_name', query.baseName)
        .equals('kind', query.kind)
        .equals('path', query.path)
        .prefix('path', query.pathPrefix);
      if (query.exportedOnly) where.raw('exported = 1');
      return pageOf<SymbolRow, SymbolFact>(
        db,
        {
          select: SYMBOL_COLUMNS,
          from: `symbols ${where}`,
          params: where.params,
          order: 'path, seq',
        },
        query,
        symbolOf,
      );
    });
  }

  async findCalls(query: CallQuery = {}): Promise<Page<CallRecord>> {
    return this.#database.guard('find calls', (db) => {
      const where = new Where()
        .equals('name', query.name)
        .equals('from_symbol', query.from)
        .equals('path', query.path);
      return pageOf<CallRow, CallRecord>(
        db,
        {
          select: CALL_COLUMNS,
          from: `calls ${where}`,
          params: where.params,
          order: 'path, seq',
        },
        query,
        callOf,
      );
    });
  }

  async findImports(query: ImportQuery = {}): Promise<Page<ImportRecord>> {
    return this.#database.guard('find imports', (db) => {
      const where = new Where().equals('specifier', query.specifier).equals('path', query.path);
      return pageOf<ImportRow, ImportRecord>(
        db,
        {
          select: IMPORT_COLUMNS,
          from: `imports ${where}`,
          params: where.params,
          order: 'path, seq',
        },
        query,
        importOf,
      );
    });
  }

  async replaceEdges(sourcePath: string, edges: readonly EdgeRecord[]): Promise<void> {
    this.#database.transaction('store edges', (db) => {
      db.query('DELETE FROM edges WHERE source_path = ?').run(sourcePath);
      const insert = db.query(
        'INSERT INTO edges (source_path, seq, from_ref, to_ref, kind, confidence) VALUES (?, ?, ?, ?, ?, ?)',
      );
      edges.forEach((edge, seq) => {
        insert.run(sourcePath, seq, edge.from, edge.to, edge.kind, edge.confidence ?? 'exact');
      });
    });
  }

  async findEdges(query: EdgeQuery = {}): Promise<Page<EdgeRecord>> {
    // Any of no kinds is nothing.
    if (query.kinds?.length === 0) return emptyPage(query);
    return this.#database.guard('find edges', (db) => {
      const where = new Where()
        .equals('from_ref', query.from)
        .equals('to_ref', query.to)
        .equals('kind', query.kind)
        .oneOf('kind', query.kinds);
      return pageOf<
        { from_ref: string; to_ref: string; kind: string; confidence: Confidence },
        EdgeRecord
      >(
        db,
        {
          select: 'from_ref, to_ref, kind, confidence',
          from: `edges ${where}`,
          params: where.params,
          order: 'source_path, seq',
        },
        query,
        (row) => ({
          from: row.from_ref,
          to: row.to_ref,
          kind: row.kind,
          confidence: row.confidence,
        }),
      );
    });
  }

  async putCorpusRecords(records: readonly StoredCorpusRecord[]): Promise<void> {
    if (records.length === 0) return;
    return this.#database.guard('write corpus records', (db) => {
      const stmt = db.prepare(`
        INSERT INTO corpus_records (corpus, id, path, attrs, text)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(corpus, id) DO UPDATE SET
          path = excluded.path,
          attrs = excluded.attrs,
          text = excluded.text
      `);
      try {
        for (const r of records) {
          stmt.run(r.corpus, r.id, r.path, JSON.stringify(r.attrs), r.text ?? null);
        }
      } finally {
        stmt.finalize();
      }
    });
  }

  async findCorpusRecords(query: CorpusQuery = {}): Promise<Page<StoredCorpusRecord>> {
    return this.#database.guard('find corpus records', (db) => {
      const where = new Where().equals('corpus', query.corpus).equals('path', query.path);
      interface CorpusRow {
        readonly corpus: string;
        readonly id: string;
        readonly path: string;
        readonly attrs: string;
        readonly text: string | null;
      }
      return pageOf<CorpusRow, StoredCorpusRecord>(
        db,
        {
          select: 'corpus, id, path, attrs, text',
          from: `corpus_records ${where}`,
          params: where.params,
          order: 'id',
        },
        query,
        (row: CorpusRow) => ({
          corpus: row.corpus,
          id: row.id,
          path: row.path,
          attrs: JSON.parse(row.attrs),
          text: row.text ?? undefined,
        }),
      );
    });
  }

  async corpusPaths(corpus: string): Promise<readonly string[]> {
    return this.#database.guard('get corpus paths', (db) => {
      const rows = allRows(
        db,
        'SELECT DISTINCT path FROM corpus_records WHERE corpus = ? ORDER BY path',
        corpus,
      ) as { path: string }[];
      return rows.map((r) => r.path);
    });
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.#database.guard('read metadata', (db) => {
      const row = getRow(db, 'SELECT value FROM meta WHERE key = ?', key) as {
        value: string;
      } | null;
      return row?.value;
    });
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.#database.guard('write metadata', (db) => {
      db.query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    });
  }

  async deleteMeta(key: string): Promise<boolean> {
    return this.#database.guard(
      'delete metadata',
      (db) => db.query('DELETE FROM meta WHERE key = ?').run(key).changes > 0,
    );
  }

  async stats(): Promise<IndexStats> {
    return this.#database.guard('count the index', (db) => {
      const count = (table: string): number =>
        (getRow(db, `SELECT count(*) AS n FROM ${table}`) as { n: number }).n;
      const byLanguage = allRows(
        db,
        'SELECT language, count(*) AS files FROM files GROUP BY language ORDER BY language',
      ) as { language: string; files: number }[];
      return {
        files: count('files'),
        quarantinedFiles: count('file_quarantine'),
        symbols: count('symbols'),
        calls: count('calls'),
        imports: count('imports'),
        edges: count('edges'),
        byLanguage,
      };
    });
  }

  async close(): Promise<void> {
    if (this.#owns) this.#database.close();
  }
}

/** Remove everything held for a path, indexed or quarantined. Returns whether anything was. */
function clearFile(db: Database, path: string): boolean {
  const indexed = db.query('DELETE FROM files WHERE path = ?').run(path).changes;
  const quarantined = db.query('DELETE FROM file_quarantine WHERE path = ?').run(path).changes;
  return indexed + quarantined > 0;
}
