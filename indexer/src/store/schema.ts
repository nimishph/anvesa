/**
 * The schema, as an ordered list of migrations. A database records how many it has had applied
 * (`PRAGMA user_version`); opening applies the rest, each in its own transaction. A migration is
 * never edited once released: change the schema by appending one.
 */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'index tables and vector tables',
    sql: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        package_root TEXT,
        repo TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        content_hash TEXT NOT NULL,
        has_syntax_errors INTEGER NOT NULL,
        imports_supported INTEGER NOT NULL,
        unnamed_calls INTEGER NOT NULL,
        computed_imports INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE symbols (
        path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        base_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent_id TEXT,
        exported INTEGER,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        doc TEXT,
        PRIMARY KEY (path, seq)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX symbols_id ON symbols(id);
      CREATE INDEX symbols_name ON symbols(name);
      CREATE INDEX symbols_base_name ON symbols(base_name);

      CREATE TABLE calls (
        path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        from_symbol TEXT,
        name TEXT NOT NULL,
        receiver_kind TEXT,
        receiver_name TEXT,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        PRIMARY KEY (path, seq)
      ) WITHOUT ROWID;
      CREATE INDEX calls_name ON calls(name);
      CREATE INDEX calls_from ON calls(from_symbol);

      CREATE TABLE imports (
        path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        specifier TEXT NOT NULL,
        kind TEXT NOT NULL,
        relative INTEGER NOT NULL,
        type_only INTEGER NOT NULL,
        bindings TEXT NOT NULL,
        line INTEGER NOT NULL,
        PRIMARY KEY (path, seq)
      ) WITHOUT ROWID;
      CREATE INDEX imports_specifier ON imports(specifier);

      CREATE TABLE edges (
        source_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        from_ref TEXT NOT NULL,
        to_ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (source_path, seq)
      ) WITHOUT ROWID;
      CREATE INDEX edges_from ON edges(from_ref);
      CREATE INDEX edges_to ON edges(to_ref);

      CREATE TABLE wexpr_cache (
        path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
        format_version INTEGER NOT NULL,
        text TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE file_quarantine (
        path TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        message TEXT NOT NULL,
        error_code TEXT,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        content_hash TEXT
      ) WITHOUT ROWID;

      CREATE TABLE vector_sources (
        channel TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        transformer_version TEXT NOT NULL,
        cards INTEGER NOT NULL,
        quarantined INTEGER NOT NULL,
        PRIMARY KEY (channel, path)
      ) WITHOUT ROWID;

      CREATE TABLE vector_dims (
        channel TEXT NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        PRIMARY KEY (channel, model)
      ) WITHOUT ROWID;

      CREATE TABLE cards (
        channel TEXT NOT NULL,
        id TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT NOT NULL,
        group_key TEXT NOT NULL,
        card TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (channel, id),
        FOREIGN KEY (channel, path) REFERENCES vector_sources(channel, path) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX cards_scan ON cards(channel, model);
      CREATE INDEX cards_source ON cards(channel, path);

      CREATE TABLE card_quarantine (
        channel TEXT NOT NULL,
        path TEXT NOT NULL,
        seq INTEGER NOT NULL,
        entry TEXT NOT NULL,
        PRIMARY KEY (channel, path, seq),
        FOREIGN KEY (channel, path) REFERENCES vector_sources(channel, path) ON DELETE CASCADE
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 2,
    description: 'parameter names on symbols',
    sql: `
      ALTER TABLE symbols ADD COLUMN params TEXT;
    `,
  },
  {
    version: 3,
    description: 'names exported by a list',
    sql: `
      CREATE TABLE exports (
        path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        name TEXT NOT NULL,
        local TEXT NOT NULL,
        line INTEGER NOT NULL,
        PRIMARY KEY (path, seq)
      ) WITHOUT ROWID;
    `,
  },
];

/** The schema version a database has once fully migrated. */
export const SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;
