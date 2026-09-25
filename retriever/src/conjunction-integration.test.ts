import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Embedder } from '@cntxt-labs/anvesa-dense';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import { Retriever } from './retriever.ts';

const roots: string[] = [];
const open: Retriever[] = [];
const runtimes: SyntaxRuntime[] = [];

afterEach(async () => {
  for (const retriever of open.splice(0)) await retriever.close();
});
afterAll(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
function embedder(): Embedder {
  return {
    info: { id: 'test-words', dimensions: 256, maxTokens: 512 },
    count: (text) => words(text).length,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(256);
        for (const word of words(text)) {
          let hash = 7;
          for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 256;
          vector[hash] = (vector[hash] as number) + 1;
        }
        if (vector.every((v) => v === 0)) vector[0] = 1;
        return vector;
      });
    },
  };
}

const sampleProject = {
  'package.json': '{"name":"app"}',
  'src/auth.ts': `/** Authenticate user credentials and create session token. */
export function authenticateUser(credentials: any) { return true; }
/** Validate existing session token. */
export class AuthTokenManager {
  validateToken(token: string) { return true; }
  revokeToken(token: string) { return true; }
}
`,
  'src/database.ts': `/** Save user record to SQLite database. */
export function saveUser(user: any) { return true; }
/** Query user record from database by id. */
export class UserRepository {
  findUserById(id: string) { return { id }; }
  deleteUserById(id: string) { return true; }
}
`,
  'docs/architecture.md': '# Architecture\nUser authentication and database storage mechanisms.\n',
};

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'anvesa-conjunction-'));
  roots.push(root);
  for (const [path, text] of Object.entries(sampleProject)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    const past = new Date(Date.now() - 3600_000);
    utimesSync(join(root, path), past, past);
  }
  return root;
}

async function createIndexedRetriever(): Promise<Retriever> {
  const root = makeProject();
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  runtimes.push(runtime);
  const r = await Retriever.open({
    root,
    runtime,
    embedder: embedder(),
  });
  open.push(r);
  await r.index();
  return r;
}

describe('semantic and WQL conjunction', () => {
  describe('retriever.search conjunction', () => {
    test('explicit options.wql filters semantic search to matching AST nodes', async () => {
      const r = await createIndexedRetriever();
      // "user" matches authenticateUser, saveUser, UserRepository, and docs/architecture.md
      // Constraining with wql: '//class//method' must only return methods inside classes!
      const page = await r.search('user', { wql: '//class//method' });

      expect(page.conjunction).toEqual({ semantic: 'user', wql: '//class//method' });
      expect(page.items.length).toBeGreaterThan(0);
      // Every item must be inside a class
      for (const item of page.items) {
        expect([
          'UserRepository.findUserById',
          'UserRepository.deleteUserById',
          'AuthTokenManager.validateToken',
          'AuthTokenManager.revokeToken',
        ]).toContain(item.title);
      }
      // Top-level functions like authenticateUser or saveUser must NOT appear
      expect(page.items.some((item) => item.title === 'authenticateUser')).toBe(false);
      expect(page.items.some((item) => item.title === 'saveUser')).toBe(false);
      // Docs must not match //class//method
      expect(page.items.some((item) => item.path.endsWith('.md'))).toBe(false);
      // Lanes report structural match count
      const structuralLane = page.lanes.find((l) => l.name === 'structural');
      expect(structuralLane).toBeDefined();
      expect(structuralLane?.hits).toBe(4);
    });

    test('inline && syntax splits into conjunction query', async () => {
      const r = await createIndexedRetriever();
      const page = await r.search('user && //function');
      expect(page.conjunction).toEqual({ semantic: 'user', wql: '//function' });
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expect(['authenticateUser', 'saveUser']).toContain(item.title);
      }
      expect(page.items.some((item) => item.title === 'UserRepository')).toBe(false);
    });

    test('inline where syntax splits into conjunction query', async () => {
      const r = await createIndexedRetriever();
      const page = await r.search('credentials where //function');
      expect(page.conjunction).toEqual({ semantic: 'credentials', wql: '//function' });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items[0]?.title).toBe('authenticateUser');
    });

    test('inline AND syntax splits into conjunction query', async () => {
      const r = await createIndexedRetriever();
      const page = await r.search('credentials AND //function');
      expect(page.conjunction).toEqual({ semantic: 'credentials', wql: '//function' });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items[0]?.title).toBe('authenticateUser');
    });

    test('returns empty page when WQL matches nothing', async () => {
      const r = await createIndexedRetriever();
      const page = await r.search('user', { wql: '//class[@name="NonExistent"]' });
      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
      expect(page.conjunction).toEqual({ semantic: 'user', wql: '//class[@name="NonExistent"]' });
    });
  });

  describe('retriever.query conjunction', () => {
    test('explicit options.semantic ranks matching WQL hits by semantic score', async () => {
      const r = await createIndexedRetriever();
      const page = await r.query('//function', { semantic: 'save user database' });

      expect(page.conjunction).toEqual({ semantic: 'save user database', wql: '//function' });
      expect(page.items.length).toBeGreaterThan(0);
      // saveUser should be ranked #1 because it matches "save user database"
      expect(page.items[0]?.name).toBe('saveUser');
      expect(page.items[0]?.score).toBeDefined();
      expect(page.items[0]?.score).toBeGreaterThan(0);
    });

    test('inline && in retriever.query splits and scores WQL hits', async () => {
      const r = await createIndexedRetriever();
      const page = await r.query('//function && authenticate credentials');

      expect(page.conjunction).toEqual({ semantic: 'authenticate credentials', wql: '//function' });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items[0]?.name).toBe('authenticateUser');
      expect(page.items[0]?.score).toBeDefined();
    });

    test('pure WQL query without semantic returns unscored structural hits', async () => {
      const r = await createIndexedRetriever();
      const page = await r.query('//function');
      expect(page.conjunction).toBeUndefined();
      expect(page.items.length).toBe(2);
      expect(page.items[0]?.score).toBeUndefined();
    });
  });
});
