import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CodeLensError, InvalidArgumentError } from '@sutras/code-lens-core';
import {
  StoreClosedError,
  StoreOpenError,
  StoreOperationError,
  StoreSchemaError,
} from '../errors.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

export interface StoreOptions {
  /**
   * How long a statement waits for another connection's lock before failing. Unset means it does
   * not wait: a locked database fails at once with a `StoreOperationError` saying so, instead of
   * stalling for a time nobody chose.
   */
  readonly busyTimeoutMs?: number;
  /** Open an existing index for reading only. It is never migrated or created. */
  readonly readonly?: boolean;
}

/** The in-memory database name SQLite understands. Nothing touches the disk. */
export const MEMORY_DATABASE = ':memory:';

/**
 * One open index database. It owns the connection and the rules for using it: pragmas, migrations,
 * transactions, and turning every failure into a typed error that names the operation.
 */
export class StoreDatabase {
  readonly path: string;
  readonly #db: Database;
  #closed = false;

  private constructor(path: string, db: Database) {
    this.path = path;
    this.#db = db;
  }

  static open(path: string, options: StoreOptions = {}): StoreDatabase {
    if (
      options.busyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0)
    ) {
      throw new InvalidArgumentError(
        'busyTimeoutMs',
        'a non-negative whole number of milliseconds',
        options.busyTimeoutMs,
      );
    }
    const readonly = options.readonly === true;
    let db: Database;
    try {
      if (path !== MEMORY_DATABASE && !readonly) mkdirSync(dirname(path), { recursive: true });
      db = new Database(path, readonly ? { readonly: true } : { create: true });
    } catch (failure) {
      throw new StoreOpenError(path, { cause: failure });
    }

    try {
      db.exec('PRAGMA foreign_keys = ON');
      if (options.busyTimeoutMs !== undefined) {
        db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
      }
      if (path !== MEMORY_DATABASE && !readonly) {
        // Readers do not block the writer and the writer does not block readers. NORMAL sync is
        // safe under WAL: a crash can lose the last commits but cannot corrupt the file.
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
      }
      migrate(db, path, readonly);
    } catch (failure) {
      db.close();
      if (failure instanceof CodeLensError) throw failure;
      throw new StoreOpenError(path, { cause: failure });
    }
    return new StoreDatabase(path, db);
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** The schema version the database is at. */
  get schemaVersion(): number {
    return userVersion(this.#db);
  }

  /** The connection, for the store classes in this package. Throws once closed. */
  connection(operation: string): Database {
    if (this.#closed) throw new StoreClosedError(operation);
    return this.#db;
  }

  /** Run `work`, reporting any failure as a `StoreOperationError` for `operation`. */
  guard<T>(operation: string, work: (db: Database) => T): T {
    const db = this.connection(operation);
    try {
      return work(db);
    } catch (failure) {
      throw asStoreError(operation, failure);
    }
  }

  /**
   * Run `work` in one transaction: everything it writes lands together or not at all. The write
   * lock is taken up front, so two writers meet at the start instead of deadlocking midway.
   * Transactions nest.
   */
  transaction<T>(operation: string, work: (db: Database) => T): T {
    const db = this.connection(operation);
    try {
      return db.transaction(() => work(db)).immediate();
    } catch (failure) {
      throw asStoreError(operation, failure);
    }
  }

  /**
   * Close the connection. It is strict: a statement still running would leave the file locked, so
   * that is an error to see rather than a handle to leak.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close(true);
    } catch (failure) {
      throw asStoreError('close the database', failure);
    }
  }
}

/**
 * The first row of a query, or `null`. The statement is prepared and finalised here: a cached
 * statement whose `get` found no row can stay active and keep the database file locked.
 */
export function getRow(db: Database, sql: string, ...params: SQLQueryBindings[]): unknown {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize();
  }
}

/** Every row of a query, with the statement finalised for the same reason as `getRow`. */
export function allRows(db: Database, sql: string, ...params: SQLQueryBindings[]): unknown[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

function asStoreError(operation: string, failure: unknown): CodeLensError {
  if (failure instanceof CodeLensError) return failure;
  const code = (failure as { code?: unknown } | null)?.code;
  return new StoreOperationError(
    operation,
    typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined,
    { cause: failure },
  );
}

function userVersion(db: Database): number {
  const row = getRow(db, 'PRAGMA user_version') as { user_version: number } | null;
  return row?.user_version ?? 0;
}

function hasTables(db: Database): boolean {
  const row = getRow(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'") as {
    n: number;
  } | null;
  return (row?.n ?? 0) > 0;
}

function migrate(db: Database, path: string, readonly: boolean): void {
  const current = userVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new StoreSchemaError(
      path,
      `it is schema version ${current}, newer than the ${SCHEMA_VERSION} this version understands`,
      { hint: 'Upgrade code-lens, or delete the index to rebuild it.' },
    );
  }
  if (current === 0 && hasTables(db)) {
    throw new StoreSchemaError(path, 'it is a database, but not a code-lens index', {
      hint: 'Point the store at a different file.',
    });
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > current);
  if (pending.length === 0) return;
  if (readonly) {
    throw new StoreSchemaError(
      path,
      `it is at schema version ${current} and needs ${SCHEMA_VERSION}, which needs a writable open`,
    );
  }
  for (const migration of pending) {
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }).immediate();
    } catch (failure) {
      throw new StoreSchemaError(path, `migration ${migration.version} failed`, {
        cause: failure,
        context: { version: migration.version, description: migration.description },
      });
    }
  }
}
