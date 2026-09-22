import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Deadline, InvalidArgumentError, OperationAbortedError } from '@cntxt-labs/code-lens-core';
import { inputFile, makeCard, vectorStoreContract } from '@cntxt-labs/code-lens-dense';
import {
  StoreClosedError,
  StoreCorruptError,
  StoreOpenError,
  StoreOperationError,
  StoreSchemaError,
} from '../errors.ts';
import { cleanupTrees, makeTree } from '../test-support.ts';
import { MEMORY_DATABASE, StoreDatabase } from './database.ts';
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
  make: () => SqliteIndexStore.open(join(makeTree({}), '.code-lens', 'index.db')),
});

vectorStoreContract(kit, 'sqlite in memory', {
  make: () => new SqliteVectorStore(StoreDatabase.open(MEMORY_DATABASE)),
  dispose: (store) => (store as SqliteVectorStore).database.close(),
});
vectorStoreContract(kit, 'sqlite on disk', {
  make: () =>
    new SqliteVectorStore(StoreDatabase.open(join(makeTree({}), '.code-lens', 'vectors.db'))),
  dispose: (store) => (store as SqliteVectorStore).database.close(),
});

const dbPath = () => join(makeTree({}), '.code-lens', 'index.db');

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

  test('a locked database fails at once with a hint, unless a timeout was chosen', async () => {
    const path = dbPath();
    const holder = StoreDatabase.open(path);
    const contender = StoreDatabase.open(path);
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
