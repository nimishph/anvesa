import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CodeLensError, InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  StoreClosedError,
  StoreOpenError,
  StoreOperationError,
  StoreSchemaError,
} from '../errors.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

export interface StoreOptions {
  /**
   * How long a statement waits for another connection's lock before failing. Defaults to
   * `DEFAULT_BUSY_TIMEOUT_MS`; `0` means it does not wait, so a locked database fails at once with
   * a `StoreOperationError` saying so, instead of stalling for a time nobody chose.
   */
  readonly busyTimeoutMs?: number;
  /** Open an existing index for reading only. It is never migrated or created. */
  readonly readonly?: boolean;
}

/** The in-memory database name SQLite understands. Nothing touches the disk. */
export const MEMORY_DATABASE = ':memory:';

/**
 * How long a statement waits for another connection's lock when the caller names no timeout.
 * Two anvesa processes on one index — a manual index while a session's reindex fires, two
 * terminals — meet at the write lock, and a bounded wait is what makes that a queue rather than a
 * failure. Long enough to outlast an ordinary statement, short enough that a wedged process is
 * reported rather than waited on forever.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** How long grouped writes wait before they are committed together; see `beginGroup`. */
export const DEFAULT_GROUP_FLUSH_MS = 250;

/** How long to wait between asks for WAL. Long enough for the other process to finish writing. */
const WAL_RETRY_MS = 25;

/**
 * How many times to re-ask for WAL before believing the lock is not coming: the busy_timeout
 * pragma does not cover this particular switch (see `enableWal`), so it gets its own retry loop —
 * but it should still add up to the same "wedged, not just slow" budget as `DEFAULT_BUSY_TIMEOUT_MS`
 * rather than a shorter one of its own, since it's answering the identical question about a
 * process racing to be the first to touch a brand-new index file.
 */
const WAL_ATTEMPTS = Math.ceil(DEFAULT_BUSY_TIMEOUT_MS / WAL_RETRY_MS);

/**
 * How many times a migration step retries after losing a duplicate-object race (see `migrate`),
 * and how long to wait between attempts. A single unsynchronized re-read right after the loss
 * isn't reliably enough after the loser's own rollback — see the comment on that retry — so this
 * re-enters a fresh, properly locked transaction instead, the same way `enableWal` doesn't trust
 * a single re-check either.
 */
const DUPLICATE_OBJECT_ATTEMPTS = 8;
const DUPLICATE_OBJECT_RETRY_MS = 20;

/** What a copy of an index is called, followed by the version it was taken at. */
const BACKUP_SUFFIX = '.backup-v';

/**
 * A copy of an index taken before it was changed, and what to do with it. The copy is a whole
 * index, not a record of what the upgrade did: putting it back puts the index back.
 */
export interface StoreBackup {
  /** The index that was copied. */
  readonly path: string;
  /** The copy: the index exactly as it was at `from`. */
  readonly backupPath: string;
  /** The schema version the index was at when the copy was taken. */
  readonly from: number;
  /** The schema version it was brought to. */
  readonly to: number;
  /** The one command that puts the copy back over the index. */
  readonly restore: string;
}

/**
 * One open index database. It owns the connection and the rules for using it: pragmas, migrations,
 * transactions, and turning every failure into a typed error that names the operation.
 */
export class StoreDatabase {
  readonly path: string;
  readonly #db: Database;
  readonly #backup: StoreBackup | undefined;
  readonly #onClose = new Set<() => void>();
  #group:
    | {
        readonly flushMs: number;
        /** Set while the group's transaction is open: it commits when this fires. */
        timer: ReturnType<typeof setTimeout> | undefined;
        /** A commit the timer could not make, raised by the next write or by `endGroup`. */
        failure: unknown;
      }
    | undefined;
  #closed = false;

  private constructor(path: string, db: Database, backup: StoreBackup | undefined) {
    this.path = path;
    this.#db = db;
    this.#backup = backup;
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
      if (path !== MEMORY_DATABASE && !readonly) mkdirRecursiveIdempotent(dirname(path));
      db = new Database(path, readonly ? { readonly: true } : { create: true });
    } catch (failure) {
      throw new StoreOpenError(path, { cause: failure });
    }

    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
      if (path !== MEMORY_DATABASE && !readonly) {
        // Readers do not block the writer and the writer does not block readers. NORMAL sync is
        // safe under WAL: a crash can lose the last commits but cannot corrupt the file.
        enableWal(db);
        db.exec('PRAGMA synchronous = NORMAL');
      }
      const backup = migrate(db, path, readonly);
      return new StoreDatabase(path, db, backup);
    } catch (failure) {
      db.close();
      if (failure instanceof CodeLensError) throw failure;
      throw new StoreOpenError(path, { cause: failure });
    }
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * The copy taken before this open changed the index, or `undefined` when it had nothing to
   * change: a new file, an index already at this version, or a database in memory. The copy is
   * named after the version the index was at, so it is clear which upgrade it belongs to.
   */
  get backup(): StoreBackup | undefined {
    return this.#backup;
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
    this.#openGroupTransaction(db);
    let result: T;
    try {
      result = db.transaction(() => work(db)).immediate();
    } catch (failure) {
      throw asStoreError(operation, failure);
    }
    return result;
  }

  /**
   * Let the small transactions that follow reach the disk together: while writes are grouped, the
   * first one opens a transaction that the rest join as savepoints (each still lands whole or not
   * at all), and it is committed `flushMs` after it opened, by a timer, whether or not anything
   * else is written. A commit rewrites every index page a write touched, so on an index with many
   * small files most of the time went to commits. Until {@link endGroup}.
   *
   * The write lock is held only from a grouped write until that timer, never while nothing is
   * written, so another process's writer waits at most about `flushMs` longer than it did. A crash
   * loses what was written since the last commit, which an index run that was cut short redoes.
   * Nothing happens when a group is already open.
   */
  beginGroup(flushMs = DEFAULT_GROUP_FLUSH_MS): void {
    this.connection('group writes');
    if (this.#group) return;
    this.#group = { flushMs, timer: undefined, failure: undefined };
  }

  /** Commit what the group holds and stop grouping. */
  endGroup(): void {
    const group = this.#group;
    if (!group) return;
    this.#group = undefined;
    if (group.timer !== undefined) clearTimeout(group.timer);
    if (group.failure !== undefined) throw group.failure;
    if (group.timer === undefined) return;
    try {
      this.connection('commit grouped writes').exec('COMMIT');
    } catch (failure) {
      throw asStoreError('commit grouped writes', failure);
    }
  }

  /** Whether writes are being grouped, so some may not yet be visible to other connections. */
  get grouping(): boolean {
    return this.#group !== undefined;
  }

  /** Open the group's transaction for the first write since the last commit, and time its commit. */
  #openGroupTransaction(db: Database): void {
    const group = this.#group;
    if (!group) return;
    if (group.failure !== undefined) {
      // The timer could not commit; nothing grouped since then can be trusted to land.
      this.#group = undefined;
      throw group.failure;
    }
    if (group.timer !== undefined || db.inTransaction) return;
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (failure) {
      throw asStoreError('group writes', failure);
    }
    // Statements run to completion between awaits, so when the timer fires the only transaction
    // open on this connection is the group's own.
    const timer = setTimeout(() => {
      group.timer = undefined;
      if (this.#group !== group || this.#closed) return;
      try {
        db.exec('COMMIT');
      } catch (failure) {
        group.failure = asStoreError('commit grouped writes', failure);
      }
    }, group.flushMs);
    // A pending commit must not keep the process alive; closing commits it anyway.
    timer.unref?.();
    group.timer = timer;
  }

  /** Run `release` when this database closes, to let go of what was opened alongside it. */
  onClose(release: () => void): void {
    if (this.#closed) release();
    else this.#onClose.add(release);
  }

  /**
   * Close the connection. It is strict: a statement still running would leave the file locked, so
   * that is an error to see rather than a handle to leak.
   */
  close(): void {
    if (this.#closed) return;
    // What a group holds was written by transactions that each completed: keep it. The connection
    // is closed even if that fails, and the failure is reported after.
    let unsaved: unknown;
    try {
      this.endGroup();
    } catch (failure) {
      unsaved = failure;
    }
    this.#closed = true;
    for (const release of this.#onClose) release();
    this.#onClose.clear();
    try {
      this.#db.close(true);
    } catch (failure) {
      throw asStoreError('close the database', failure);
    }
    if (unsaved !== undefined) throw unsaved;
  }
}

/**
 * `mkdirSync(dir, { recursive: true })`, but tolerant of another process creating the same
 * directory in the instant between this one finding it absent and creating it — several anvesa
 * processes opening a brand-new index at once all race on the same `.anvesa` directory. Node's
 * `recursive: true` already swallows a plain "it's there" (`EEXIST`) race on most platforms, but
 * Windows can also surface it as `EPERM` when `CreateDirectory` loses that race by a hair. Either
 * way, the directory existing when it's checked again is success, not failure.
 */
function mkdirRecursiveIdempotent(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (failure) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return;
    throw failure;
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

/** Whether `failure` is another connection holding the file, rather than anything being wrong. */
function isLocked(failure: unknown): boolean {
  const code = (failure as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

/**
 * Whether `failure` is SQLite refusing to (re)create an object — table, index, column — that is
 * already there. SQLite reports this as a plain `Error` with no `.code`, so it's matched on
 * message the way `isLocked` is matched on code.
 */
function isDuplicateObject(failure: unknown): boolean {
  const message = failure instanceof Error ? failure.message : String(failure);
  return /\balready exists\b/i.test(message);
}

/** Whether the index holds anything an upgrade could lose: files, cards, or recorded state. */
function holdsData(db: Database): boolean {
  return (
    getRow(
      db,
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM files) OR EXISTS (SELECT 1 FROM cards)
                   OR EXISTS (SELECT 1 FROM meta)`,
    ) !== null
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

function journalMode(db: Database): string {
  const row = getRow(db, 'PRAGMA journal_mode') as { journal_mode: string } | null;
  return row?.journal_mode ?? '';
}

/**
 * Put the file in WAL, once. Switching journal mode needs a moment nobody else is touching the
 * database, and SQLite does not apply the busy timeout to that change: two processes opening a
 * brand-new index at the same instant see `SQLITE_BUSY` from the loser. The mode is a property of
 * the file, so the loser waits for the winner to finish writing it and carries on.
 */
function enableWal(db: Database): void {
  for (let attempt = 1; ; attempt += 1) {
    if (journalMode(db) === 'wal') return;
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (failure) {
      if (!isLocked(failure) || attempt >= WAL_ATTEMPTS) throw failure;
      Bun.sleepSync(WAL_RETRY_MS);
    }
  }
}

/** The schema version `db` is at, refusing the two states no amount of migrating can fix. */
function checkUsable(db: Database, path: string, current: number): void {
  if (current > SCHEMA_VERSION) throw tooNewSchema(path, current);
  if (current === 0 && hasTables(db)) {
    throw new StoreSchemaError(path, 'it is a database, but not a anvesa index', {
      hint: 'Point the store at a different file.',
    });
  }
}

function tooNewSchema(path: string, current: number): StoreSchemaError {
  return new StoreSchemaError(
    path,
    `it is schema version ${current}, newer than the ${SCHEMA_VERSION} this version understands`,
    { hint: 'Upgrade anvesa, or delete the index to rebuild it.' },
  );
}

/**
 * Copy the index aside before anything changes it. Every migration is transactional, so the file
 * cannot be left half-written, but a migration that is simply wrong leaves nothing to go back to
 * and the way out is a rebuild, which is an evening of the user's time. Only the copy from the
 * latest upgrade is kept: an older one is of no use to anyone and takes up room forever.
 */
function takeBackup(db: Database, path: string, from: number): StoreBackup {
  const backupPath = `${path}${BACKUP_SUFFIX}${from}`;
  for (const stale of backupsOf(path)) rmSync(stale, { force: true });
  try {
    // VACUUM INTO writes the whole database as it stands in one statement, so the copy is
    // consistent even in WAL, and it refuses to write over an existing file.
    db.exec(`VACUUM INTO ${quote(backupPath)}`);
  } catch (failure) {
    throw new StoreOpenError(path, {
      cause: failure,
      hint: `The index could not be copied to ${backupPath} before upgrading it, so nothing was changed. Make room in ${dirname(path)} and try again.`,
      context: { backupPath, from, to: SCHEMA_VERSION },
    });
  }
  return {
    path,
    backupPath,
    from,
    to: SCHEMA_VERSION,
    restore: `Move ${backupPath} over ${path}, then open the index with this version of anvesa.`,
  };
}

/** Every copy of this index taken by an earlier upgrade, the target for the next one included. */
function backupsOf(path: string): readonly string[] {
  const prefix = `${basename(path)}${BACKUP_SUFFIX}`;
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => join(dirname(path), name));
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function migrate(db: Database, path: string, readonly: boolean): StoreBackup | undefined {
  // A file ahead of this version has nothing pending, so the loop below would never look at it.
  const current = userVersion(db);
  if (current > SCHEMA_VERSION) throw tooNewSchema(path, current);
  const pending = MIGRATIONS.filter((migration) => migration.version > current);
  if (pending.length === 0) return undefined;
  if (readonly) {
    // A reader cannot create the tables, so it says what the file is rather than what it wants.
    checkUsable(db, path, current);
    throw new StoreSchemaError(
      path,
      `it is at schema version ${current} and needs ${SCHEMA_VERSION}, which needs a writable open`,
    );
  }
  // An index that is not there yet has nothing to lose, so only an existing one is copied, and
  // only if it holds something: a process that finds a new index part-way created is looking at
  // another process creating it at that moment, and copying (or clearing old copies beside) a
  // file another process is still writing breaks that process's open.
  const backup =
    path === MEMORY_DATABASE || current === 0 || !holdsData(db)
      ? undefined
      : takeBackup(db, path, current);
  // Set only by a migration this process applied itself, and that had data to move.
  let vacuum = false;
  for (const migration of pending) {
    for (let attempt = 0; ; attempt += 1) {
      let appliedHere = false;
      try {
        db.transaction(() => {
          // Re-read under the write lock, which is where the version is settled. Two processes
          // opening a brand-new index at the same instant both read an empty file and both find
          // work to do; the one that waited for the lock must see the other's tables and take the
          // next step, not try to create what is already there. Every step before this one either
          // applied its version or found it already applied, so the file is at `version - 1` here
          // unless another process has moved it further along.
          const now = userVersion(db);
          checkUsable(db, path, now);
          if (now >= migration.version) return;
          db.exec(migration.sql);
          db.exec(`PRAGMA user_version = ${migration.version}`);
          appliedHere = true;
        }).immediate();
        if (
          appliedHere &&
          migration.vacuumIf !== undefined &&
          getRow(db, migration.vacuumIf) !== null
        ) {
          vacuum = true;
        }
        break;
      } catch (failure) {
        if (failure instanceof CodeLensError) throw failure;
        // Another process holding the write lock past the busy timeout is not a broken migration.
        if (isLocked(failure)) {
          throw new StoreOpenError(path, {
            cause: failure,
            hint: 'Another process is upgrading this index. Wait for it to finish, then run this again.',
            context: { version: migration.version, description: migration.description },
          });
        }
        // Two processes racing this same step can both find nothing pending and both start
        // creating it: SQLite serializes their transactions (that's what the write lock is for),
        // so exactly one succeeds and the other's DDL fails against what the winner just
        // committed. A single unsynchronized re-read of the version right here, outside any
        // transaction, isn't trustworthy enough — it can still run before the winner's commit is
        // visible on this connection. So this retries the whole step through a fresh, properly
        // locked transaction instead: that re-read of `now` above is the one that counts, and a
        // few short retries give the winner's commit time to land before this gives up.
        if (isDuplicateObject(failure) && attempt < DUPLICATE_OBJECT_ATTEMPTS) {
          Bun.sleepSync(DUPLICATE_OBJECT_RETRY_MS);
          continue;
        }
        throw new StoreSchemaError(path, `migration ${migration.version} failed`, {
          cause: failure,
          ...(backup === undefined
            ? {}
            : {
                hint: `The index as it was before this upgrade is at ${backup.backupPath}. ${backup.restore}`,
              }),
          context: { version: migration.version, description: migration.description, ...backup },
        });
      }
    }
  }
  // A migration that moves data out of a table leaves its old pages free; the file would keep that
  // size until rewritten. VACUUM cannot run inside a transaction, so it follows the steps. It runs
  // only in the process that applied such a migration to an index with data in it: never for a new
  // index, which several processes may be creating at the same moment, since rewriting a file
  // another process is opening breaks that open. If another process holds the lock, it is skipped:
  // the free pages are used again by later writes.
  if (vacuum) {
    try {
      db.exec('VACUUM');
    } catch (failure) {
      if (!isLocked(failure)) throw asStoreError('give back the space the upgrade freed', failure);
    }
  }
  return backup;
}
