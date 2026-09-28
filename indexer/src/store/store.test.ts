import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Deadline, InvalidArgumentError, OperationAbortedError } from '@cntxt-labs/anvesa-core';
import { inputFile, makeCard, vectorStoreContract } from '@cntxt-labs/anvesa-dense';
import {
  StoreClosedError,
  StoreCorruptError,
  StoreOpenError,
  StoreOperationError,
  StoreSchemaError,
} from '../errors.ts';
import { cleanupTrees, makeTree } from '../test-support.ts';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  MEMORY_DATABASE,
  StoreDatabase,
  type StoreOptions,
} from './database.ts';
import { indexStoreContract } from './index-store-contract.ts';
import { MemoryIndexStore } from './memory-index-store.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';
import { SqliteIndexStore } from './sqlite-index-store.ts';
import { SqliteVectorStore } from './sqlite-vector-store.ts';
import type { IndexedFile } from './types.ts';

afterAll(cleanupTrees);

const kit = { describe, test, expect };

indexStoreContract(kit, 'memory', { make: () => new MemoryIndexStore() });
indexStoreContract(kit, 'sqlite in memory', {
  make: () => SqliteIndexStore.open(MEMORY_DATABASE),
});
indexStoreContract(kit, 'sqlite on disk', {
  make: () => SqliteIndexStore.open(join(makeTree({}), '.anvesa', 'index.db')),
});

vectorStoreContract(kit, 'sqlite in memory', {
  make: () => new SqliteVectorStore(StoreDatabase.open(MEMORY_DATABASE)),
  dispose: (store) => (store as SqliteVectorStore).database.close(),
});
vectorStoreContract(kit, 'sqlite on disk', {
  make: () =>
    new SqliteVectorStore(StoreDatabase.open(join(makeTree({}), '.anvesa', 'vectors.db'))),
  dispose: (store) => (store as SqliteVectorStore).database.close(),
});

const dbPath = () => join(makeTree({}), '.anvesa', 'index.db');

/** These modules as import URLs, so another process can load the same code this one is testing. */
const STORE_MODULE_URL = new URL('./database.ts', import.meta.url).href;
const SCHEMA_MODULE_URL = new URL('./schema.ts', import.meta.url).href;

/** Hold the write lock, say so on stdout, and keep it for `holdMs`. */
const HOLDS_THE_WRITE_LOCK = `
import { Database } from 'bun:sqlite';
const [target, holdMs] = process.argv.slice(2);
const db = new Database(target);
db.exec('PRAGMA busy_timeout = 0');
db.exec('BEGIN IMMEDIATE');
console.log('locked');
await Bun.sleep(Number(holdMs));
db.exec('ROLLBACK');
db.close();
`;

/** Bring the index up to date under the write lock, and only then let go of it. */
const UPGRADES_THE_INDEX = `
import { Database } from 'bun:sqlite';
const [schemaUrl, target, holdMs] = process.argv.slice(2);
const { MIGRATIONS } = await import(schemaUrl);
const db = new Database(target);
db.exec('PRAGMA busy_timeout = 0');
db.exec('BEGIN IMMEDIATE');
const from = db.query('PRAGMA user_version').get().user_version;
for (const migration of MIGRATIONS.filter((one) => one.version > from)) {
  db.exec(migration.sql);
  db.exec(\`PRAGMA user_version = \${migration.version}\`);
}
console.log('upgraded');
await Bun.sleep(Number(holdMs));
db.exec('COMMIT');
db.close();
`;

/**
 * Open the store the way a real process does, and report what happened as one line of JSON. On
 * failure this includes the cause chain (name/message/code of the top error and whatever it
 * wraps), not just the outer StoreOpenError's generic "Cannot open index database <path>" —
 * otherwise a failure here is undiagnosable from a CI log alone.
 */
const OPENS_AND_REPORTS = `
import { existsSync } from 'node:fs';
const [gate, moduleUrl, target] = process.argv.slice(2);
while (!existsSync(gate)) await Bun.sleep(1);
const { StoreDatabase } = await import(moduleUrl);
function describe(err) {
  if (err === null || err === undefined) return err;
  return {
    name: err?.constructor?.name,
    message: err?.message,
    code: err?.code,
    cause: 'cause' in Object(err) ? describe(err.cause) : undefined,
  };
}
try {
  const database = StoreDatabase.open(target);
  console.log(JSON.stringify({ ok: true, version: database.schemaVersion }));
  database.close();
} catch (thrown) {
  console.log(JSON.stringify({ ok: false, error: describe(thrown) }));
  process.exitCode = 1;
}
`;

/**
 * Run `body` in one other process and report the first line it prints, which is how a test knows
 * the other process has got as far as it needs to be. It has to be another process: a second
 * connection in this one could not hold a lock that this one then waits for, because the busy
 * handler does not yield to the event loop, so one process only ever hears about locks it took
 * itself. The lock is let go rather than killed off, so the file closes cleanly and can be
 * removed with the rest of the tree.
 */
function inAnotherProcess(
  body: string,
  args: readonly string[],
): { readonly signalled: Promise<string>; readonly finished: Promise<number> } {
  const root = makeTree({});
  const script = join(root, 'other-process.ts');
  writeFileSync(script, body);
  const child = Bun.spawn({ cmd: ['bun', script, ...args], stdout: 'pipe', stderr: 'inherit' });
  return {
    signalled: child.stdout
      .getReader()
      .read()
      .then(({ value }) => new TextDecoder().decode(value)),
    finished: child.exited,
  };
}

/**
 * Run `body` in `count` other processes, all released at the same instant, and report what each of
 * them made of the file. The gate is what lines them up: started one after another they would
 * arrive at the file seconds apart, which is not a race at all.
 */
async function collide(
  body: string,
  args: readonly string[],
  count: number,
): Promise<readonly { readonly exitCode: number; readonly output: string }[]> {
  const root = makeTree({});
  const gate = join(root, 'go');
  const script = join(root, 'other-process.ts');
  writeFileSync(script, body);
  const children = Array.from({ length: count }, () =>
    Bun.spawn({
      cmd: ['bun', script, gate, ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  // Long enough for the slowest child to be started and to reach the gate.
  await Bun.sleep(300);
  writeFileSync(gate, 'go');
  return Promise.all(
    children.map(async (child) => ({
      exitCode: await child.exited,
      output: (await child.stderr.text()) + (await child.stdout.text()),
    })),
  );
}

/** An index left at the first release's schema version, so opening it has migrations to apply. */
function olderSchemaIndex(journal: 'wal' | 'delete' = 'wal'): string {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path, { create: true });
  if (journal === 'wal') raw.exec('PRAGMA journal_mode = WAL');
  raw.exec(MIGRATIONS[0]?.sql ?? '');
  raw.exec('PRAGMA user_version = 1');
  raw.close();
  return path;
}

/** The schema version a file on disk is at, read without opening it as an index. */
function schemaVersionOf(path: string): number {
  const raw = new Database(path, { readonly: true });
  const version = (raw.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  raw.close();
  return version;
}

/** The copies this version of anvesa keeps beside an index, by file name. */
function copiesOf(path: string): readonly string[] {
  const prefix = `${basename(path)}.backup-v`;
  return readdirSync(dirname(path)).filter((name) => name.startsWith(prefix));
}

const sample = (path: string): IndexedFile => ({
  path,
  language: 'typescript',
  packageRoot: undefined,
  repo: '',
  size: 1,
  mtimeMs: 1,
  contentHash: 'h',
  facts: {
    path,
    language: 'typescript',
    symbols: [],
    calls: [],
    imports: [],
    exports: [],
    hasSyntaxErrors: false,
    importsSupported: true,
    gaps: { unnamedCalls: 0, computedImports: 0 },
  },
});

describe('opening the database', () => {
  test('creates the file and its directory, migrates to the current schema, and uses WAL', () => {
    const path = dbPath();
    const database = StoreDatabase.open(path);
    expect(existsSync(path)).toBe(true);
    expect(database.schemaVersion).toBe(SCHEMA_VERSION);
    const mode = database.connection('test').query('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(mode.journal_mode).toBe('wal');
    database.close();
  });

  test('data survives closing and reopening', async () => {
    const path = dbPath();
    const first = SqliteIndexStore.open(path);
    await first.replaceFile(sample('a.ts'));
    await first.setMeta('k', 'v');
    await first.close();

    const second = SqliteIndexStore.open(path);
    expect((await second.fileState('a.ts'))?.contentHash).toBe('h');
    expect(await second.getMeta('k')).toBe('v');
    await second.close();
  });

  test('a database at an older schema is migrated in place, keeping its data', async () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    // Build a database exactly as the first release would have left it.
    const old = new Database(path, { create: true });
    const [first] = MIGRATIONS;
    old.exec(first?.sql ?? '');
    old.exec('PRAGMA user_version = 1');
    old.exec("INSERT INTO files VALUES ('a.ts', 'typescript', NULL, '', 1, 1, 'h', 0, 1, 0, 0)");
    old.exec(
      "INSERT INTO symbols VALUES ('a.ts', 0, 'a.ts#f', 'f', 'f', 'function', NULL, NULL, 1, 1, 'f()', NULL)",
    );
    old.close();

    const store = SqliteIndexStore.open(path);
    expect(store.database.schemaVersion).toBe(SCHEMA_VERSION);
    const symbol = await store.symbol('a.ts#f');
    expect(symbol).toMatchObject({ name: 'f', signature: 'f()' });
    expect(symbol?.params).toBeUndefined();
    await store.close();
  });

  test('reopening does not migrate again', () => {
    const path = dbPath();
    StoreDatabase.open(path).close();
    const again = StoreDatabase.open(path);
    expect(again.schemaVersion).toBe(SCHEMA_VERSION);
    again.close();
  });

  test('a database from a newer version is refused, not guessed at', () => {
    const path = dbPath();
    StoreDatabase.open(path).close();
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    try {
      StoreDatabase.open(path);
      throw new StoreOpenError(path, { context: { problem: 'expected a refusal' } });
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(StoreSchemaError);
      expect((thrown as StoreSchemaError).message).toContain('newer');
    }
  });

  test('some other program’s database is refused', () => {
    const path = dbPath();
    StoreDatabase.open(path).close();
    const other = join(makeTree({}), 'other.db');
    const raw = new Database(other, { create: true });
    raw.exec('CREATE TABLE unrelated (x INTEGER)');
    raw.close();
    expect(() => StoreDatabase.open(other)).toThrow(StoreSchemaError);
  });

  test('a file that is not a database is a typed open error that keeps the cause', () => {
    const root = makeTree({ 'index.db': 'this is not sqlite, just text that is long enough' });
    try {
      StoreDatabase.open(join(root, 'index.db'));
      throw new StoreSchemaError(root, 'expected a failure');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(StoreOpenError);
      expect((thrown as StoreOpenError).cause).toBeDefined();
    }
  });

  test('read-only opens an existing index, and refuses to create or migrate one', () => {
    const path = dbPath();
    StoreDatabase.open(path).close();
    const reader = StoreDatabase.open(path, { readonly: true });
    expect(reader.schemaVersion).toBe(SCHEMA_VERSION);
    reader.close();
    expect(() => StoreDatabase.open(join(makeTree({}), 'none.db'), { readonly: true })).toThrow(
      StoreOpenError,
    );
  });

  test('a nonsensical busy timeout is a typed argument error', () => {
    expect(() => StoreDatabase.open(MEMORY_DATABASE, { busyTimeoutMs: -1 })).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('copying an index before it is upgraded', () => {
  test('an index with migrations to apply is copied aside, and the copy is the old index', () => {
    const path = olderSchemaIndex();
    const database = StoreDatabase.open(path);
    const backup = database.backup;
    expect(backup).toBeDefined();
    expect(backup?.from).toBe(1);
    expect(backup?.to).toBe(SCHEMA_VERSION);
    expect(backup?.backupPath).toBe(`${path}.backup-v1`);
    expect(backup?.restore).toContain(backup?.backupPath ?? '');
    expect(schemaVersionOf(path)).toBe(SCHEMA_VERSION);
    // The copy is the index as it was, whole, not a record of what the upgrade did.
    expect(schemaVersionOf(backup?.backupPath ?? path)).toBe(1);
    database.close();
  });

  test('an index with nothing to upgrade is not copied', () => {
    const path = dbPath();
    const database = StoreDatabase.open(path);
    expect(database.backup).toBeUndefined();
    database.close();
    expect(copiesOf(path)).toEqual([]);
  });

  test('a copy left by an earlier attempt is replaced, and only that is touched', () => {
    const path = olderSchemaIndex();
    // An upgrade that failed and was run again leaves its copy behind, and VACUUM INTO will not
    // write over one. Anything else next to the index is none of this code's business.
    writeFileSync(`${path}.backup-v1`, 'a copy from a failed attempt');
    writeFileSync(`${path}.backup-v3`, 'a copy from some other upgrade');
    writeFileSync(`${path}.backup-notes`, 'mine');
    const database = StoreDatabase.open(path);
    expect(database.backup?.backupPath).toBe(`${path}.backup-v1`);
    expect(schemaVersionOf(`${path}.backup-v1`)).toBe(1);
    expect(existsSync(`${path}.backup-v3`)).toBe(false);
    expect(readFileSync(`${path}.backup-notes`, 'utf8')).toBe('mine');
    database.close();
  });

  test('an upgrade that fails says where the index as it was is', () => {
    const path = olderSchemaIndex();
    // A table already sitting where the third migration wants one: the upgrade cannot finish,
    // which is the case the copy exists for.
    const raw = new Database(path);
    raw.exec('CREATE TABLE exports (mine INTEGER)');
    raw.exec('PRAGMA user_version = 2');
    raw.close();

    let failure: unknown;
    try {
      StoreDatabase.open(path);
    } catch (thrown) {
      failure = thrown;
    }
    expect(failure).toBeInstanceOf(StoreSchemaError);
    const error = failure as StoreSchemaError;
    expect(error.message).toContain('migration 3 failed');
    expect(error.hint).toContain(`${path}.backup-v2`);
    expect(schemaVersionOf(`${path}.backup-v2`)).toBe(2);
    // The failed migration rolled back, so the index and its copy are the same version.
    expect(schemaVersionOf(path)).toBe(2);
  });
});

describe('using the database', () => {
  test('a closed store says so, with the operation that was attempted', async () => {
    const store = SqliteIndexStore.open(MEMORY_DATABASE);
    await store.close();
    await store.close();
    await expect(store.stats()).rejects.toBeInstanceOf(StoreClosedError);
    await expect(store.replaceFile(sample('a.ts'))).rejects.toBeInstanceOf(StoreClosedError);
  });

  test('a store that does not own its database leaves it open', async () => {
    const database = StoreDatabase.open(MEMORY_DATABASE);
    const store = new SqliteIndexStore(database);
    await store.close();
    expect(database.isClosed).toBe(false);
    database.close();
  });

  test('a failed write leaves nothing behind', async () => {
    const store = SqliteIndexStore.open(MEMORY_DATABASE);
    const clash = (id: string) => ({
      ...sample('a.ts'),
      facts: {
        ...sample('a.ts').facts,
        symbols: [
          {
            id,
            path: 'a.ts',
            name: 'x',
            baseName: 'x',
            kind: 'function',
            parentId: undefined,
            exported: undefined,
            startLine: 1,
            endLine: 1,
            signature: undefined,
            doc: undefined,
          },
        ],
      },
    });
    await store.replaceFile(clash('a.ts#x'));
    // Another file claiming the same symbol id violates uniqueness partway through the write.
    const conflicting = { ...clash('a.ts#x'), path: 'b.ts' };
    await expect(store.replaceFile(conflicting)).rejects.toBeInstanceOf(StoreOperationError);
    expect(await store.fileState('b.ts')).toBeUndefined();
    expect((await store.stats()).files).toBe(1);
    await store.close();
  });

  test('a locked database fails at once when the store was told not to wait', () => {
    const path = dbPath();
    const holder = StoreDatabase.open(path);
    const contender = StoreDatabase.open(path, { busyTimeoutMs: 0 });
    holder.connection('test').exec('BEGIN IMMEDIATE');
    try {
      let failure: unknown;
      try {
        contender.transaction('store a file', () => undefined);
      } catch (thrown) {
        failure = thrown;
      }
      expect(failure).toBeInstanceOf(StoreOperationError);
      expect((failure as StoreOperationError).context.sqliteCode).toBe('SQLITE_BUSY');
      expect((failure as StoreOperationError).hint).toContain('Another process');
    } finally {
      holder.connection('test').exec('ROLLBACK');
      holder.close();
      contender.close();
    }
  });

  test('unreadable stored JSON is reported as corruption naming the row', async () => {
    const store = SqliteIndexStore.open(MEMORY_DATABASE);
    await store.replaceFile({
      ...sample('a.ts'),
      facts: {
        ...sample('a.ts').facts,
        imports: [
          {
            specifier: './x',
            kind: 'static',
            relative: true,
            typeOnly: false,
            bindings: [],
            line: 4,
          },
        ],
      },
    });
    store.database.connection('test').exec("UPDATE imports SET bindings = '{oops'");
    const failure = await store.findImports().catch((thrown) => thrown);
    expect(failure).toBeInstanceOf(StoreCorruptError);
    expect(failure.context.key).toBe('a.ts:4');
    expect(failure.cause).toBeDefined();
    await store.close();
  });
});

describe('another process on the same index', () => {
  test('a store names a busy timeout for itself when the caller does not', () => {
    const timeoutOf = (options?: StoreOptions) => {
      const database = StoreDatabase.open(dbPath(), options);
      try {
        return (
          database.connection('test').query('PRAGMA busy_timeout').get() as { timeout: number }
        ).timeout;
      } finally {
        database.close();
      }
    };
    expect(timeoutOf()).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    expect(timeoutOf({ busyTimeoutMs: 0 })).toBe(0);
    expect(timeoutOf({ busyTimeoutMs: 250 })).toBe(250);
  });

  test('a write waits for the lock another process is holding instead of failing at once', async () => {
    const path = dbPath();
    await SqliteIndexStore.open(path).close();
    const holder = inAnotherProcess(HOLDS_THE_WRITE_LOCK, [path, '400']);
    try {
      expect(await holder.signalled).toContain('locked');

      const store = SqliteIndexStore.open(path);
      await store.setMeta('k', 'v');
      expect(await store.getMeta('k')).toBe('v');
      await store.close();
    } finally {
      await holder.finished;
    }
  });

  test('another process writing to the file does not stop the index reaching WAL', async () => {
    const path = olderSchemaIndex('delete');
    const holder = inAnotherProcess(HOLDS_THE_WRITE_LOCK, [path, '60']);
    try {
      expect(await holder.signalled).toContain('locked');

      // Switching journal mode needs the file to itself, and SQLite reports that clash at once
      // rather than waiting for it, whatever busy timeout the store was given: only asking again
      // gets the index into WAL.
      const store = SqliteIndexStore.open(path);
      const mode = store.database.connection('test').query('PRAGMA journal_mode').get() as {
        journal_mode: string;
      };
      expect(mode.journal_mode).toBe('wal');
      await store.close();
    } finally {
      await holder.finished;
    }
  });

  test('an index another process upgrades while we wait is the one we get, not a failure', async () => {
    const path = olderSchemaIndex();
    const upgrader = inAnotherProcess(UPGRADES_THE_INDEX, [SCHEMA_MODULE_URL, path, '300']);
    try {
      expect(await upgrader.signalled).toContain('upgraded');

      // Every migration is decided on before the first lock is taken, so the list this process is
      // holding says there is work left when there is none. The version is read again under the
      // lock and the work already done is left alone.
      const store = SqliteIndexStore.open(path);
      expect(store.database.schemaVersion).toBe(SCHEMA_VERSION);
      await store.replaceFile(sample('a.ts'));
      expect((await store.files()).items).toHaveLength(1);
      await store.close();
    } finally {
      await upgrader.finished;
    }
  });

  test('a process that holds the lock past the timeout is named, not called a broken index', async () => {
    const path = olderSchemaIndex();
    const holder = inAnotherProcess(HOLDS_THE_WRITE_LOCK, [path, '700']);
    try {
      expect(await holder.signalled).toContain('locked');

      let failure: unknown;
      try {
        SqliteIndexStore.open(path, { busyTimeoutMs: 50 });
      } catch (thrown) {
        failure = thrown;
      }
      // It is another process holding the file, so it is an open problem and not a schema problem.
      expect(failure).toBeInstanceOf(StoreOpenError);
      expect(failure).not.toBeInstanceOf(StoreSchemaError);
      expect((failure as StoreOpenError).hint).toContain('Another process');
    } finally {
      await holder.finished;
    }
  });

  test('two processes opening a brand-new index at once all get a whole one', async () => {
    // Three rounds, because this is a race: a round whose processes happen to miss each other
    // proves nothing, and each round is a fresh file for a fresh set of processes to collide on.
    for (let round = 0; round < 3; round += 1) {
      const path = dbPath();
      const opened = await collide(OPENS_AND_REPORTS, [STORE_MODULE_URL, path], 3);
      expect(opened.map((child) => child.output.trim())).toEqual(
        opened.map(() => JSON.stringify({ ok: true, version: SCHEMA_VERSION })),
      );

      const store = SqliteIndexStore.open(path);
      expect(store.database.schemaVersion).toBe(SCHEMA_VERSION);
      await store.close();
    }
  });
});

describe('vector store specifics', () => {
  const transformer = {
    name: 'demo',
    version: '1',
    channel: 'demo',
    categoryId: 'custom.demo',
    categoryLabel: 'Demo',
    trust: 'third-party' as const,
    claim: () => true,
    transform: () => [],
  };
  const cardOf = (path: string, key: string) =>
    makeCard(transformer, inputFile(path, key), { key, text: key });
  const update = (
    path: string,
    cards: { card: ReturnType<typeof cardOf>; vector: Float32Array }[],
  ) => ({
    channel: 'demo',
    path,
    model: 'm',
    contentHash: 'h',
    transformerVersion: '1',
    cards,
    quarantined: [],
  });

  test('closes cleanly after a search leaves no statement running', async () => {
    const store = new SqliteVectorStore(StoreDatabase.open(join(makeTree({}), 'c.db')));
    await store.replaceSource(
      update('a.md', [{ card: cardOf('a.md', 'one'), vector: new Float32Array([1, 0, 0]) }]),
    );
    await store.search(new Float32Array([1, 0, 0]), { channel: 'demo', model: 'm', limit: 5 });
    expect(() => store.database.close()).not.toThrow();
  });

  test('a model with no record of its vector size is reported unknown, not as zero', async () => {
    const database = StoreDatabase.open(join(makeTree({}), 'v.db'));
    const store = new SqliteVectorStore(database);
    await store.replaceSource(
      update('a.md', [{ card: cardOf('a.md', 'one'), vector: new Float32Array([1, 0, 0]) }]),
    );
    expect((await store.stats('demo')).models).toEqual([{ model: 'm', dimensions: 3, cards: 1 }]);

    // Break the invariant the store keeps by writing both rows in one transaction: the cards are
    // there and the record of their size is not, which no code path is supposed to produce.
    database
      .connection('test')
      .query("DELETE FROM vector_dims WHERE channel = 'demo' AND model = 'm'")
      .run();
    const broken = await store.stats('demo');
    expect(broken.models).toEqual([{ model: 'm', cards: 1 }]);
    expect(broken.models[0]).not.toHaveProperty('dimensions');
    database.close();
  });

  test('cards and dimensions survive reopening', async () => {
    const path = join(makeTree({}), 'v.db');
    const first = new SqliteVectorStore(StoreDatabase.open(path));
    await first.replaceSource(
      update('a.md', [{ card: cardOf('a.md', 'one'), vector: new Float32Array([1, 0, 0]) }]),
    );
    first.database.close();

    const second = new SqliteVectorStore(StoreDatabase.open(path));
    const hits = await second.search(new Float32Array([1, 0, 0]), {
      channel: 'demo',
      model: 'm',
      limit: 5,
    });
    expect(hits.map((h) => h.card.id)).toEqual(['a.md#one']);
    await expect(
      second.search(new Float32Array([1, 0]), { channel: 'demo', model: 'm', limit: 5 }),
    ).rejects.toThrow(/dimension/i);
    second.database.close();
  });

  test('a search over many cards is exact and honours a large limit', async () => {
    const store = new SqliteVectorStore(StoreDatabase.open(MEMORY_DATABASE));
    const dims = 16;
    const cards = Array.from({ length: 3000 }, (_, i) => {
      const vector = new Float32Array(dims);
      vector[i % dims] = 1 + (i % 7);
      vector[(i * 5) % dims] = (vector[(i * 5) % dims] ?? 0) + 0.5;
      return { card: cardOf('big.md', `c${String(i).padStart(4, '0')}`), vector };
    });
    await store.replaceSource(update('big.md', cards));

    const query = new Float32Array(dims);
    query[3] = 1;
    const everything = await store.search(query, { channel: 'demo', model: 'm', limit: 5000 });
    expect(everything).toHaveLength(3000);
    for (let i = 1; i < everything.length; i += 1) {
      expect((everything[i - 1] as { score: number }).score).toBeGreaterThanOrEqual(
        (everything[i] as { score: number }).score,
      );
    }
    const top = await store.search(query, { channel: 'demo', model: 'm', limit: 10 });
    expect(top.map((h) => h.card.id)).toEqual(
      everything.slice(0, top.length).map((h) => h.card.id),
    );
    store.database.close();
  });

  test('a cancelled deadline stops a long scan with a typed error', async () => {
    const store = new SqliteVectorStore(StoreDatabase.open(MEMORY_DATABASE));
    const cards = Array.from({ length: 2500 }, (_, i) => ({
      card: cardOf('big.md', `c${i}`),
      vector: new Float32Array([1, i + 1]),
    }));
    await store.replaceSource(update('big.md', cards));
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.search(new Float32Array([1, 1]), {
        channel: 'demo',
        model: 'm',
        limit: 3,
        deadline: Deadline.of({ signal: controller.signal }),
      }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
    store.database.close();
  });

  test('a zero vector is refused before anything is written', async () => {
    const store = new SqliteVectorStore(StoreDatabase.open(MEMORY_DATABASE));
    await expect(
      store.replaceSource(
        update('a.md', [
          { card: cardOf('a.md', 'ok'), vector: new Float32Array([1, 0]) },
          { card: cardOf('a.md', 'zero'), vector: new Float32Array(2) },
        ]),
      ),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await store.sourceState('demo', 'a.md')).toBeUndefined();
    store.database.close();
  });
});
