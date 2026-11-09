import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Deadline, InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import type { Embedder } from '@cntxt-labs/anvesa-dense';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import { FederatedRetriever } from './federation.ts';
import { Retriever } from './retriever.ts';

const roots: string[] = [];
const open: (Retriever | FederatedRetriever)[] = [];
const runtimes: SyntaxRuntime[] = [];

afterEach(async () => {
  for (const r of open.splice(0)) {
    await r.close();
  }
});

afterAll(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
function mockEmbedder(): Embedder {
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

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'anvesa-fed-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function createRetriever(
  root: string,
  embedderInstance = mockEmbedder(),
): Promise<Retriever> {
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  runtimes.push(runtime);
  const r = await Retriever.open({
    root,
    runtime,
    embedder: embedderInstance,
  });
  open.push(r);
  return r;
}

describe('Multi-Repository Workspace Federation (anv-fn9)', () => {
  test('status reports empty when federation is not configured', async () => {
    const hostDir = makeProject({
      'package.json': '{"name":"host-app"}',
      'src/index.ts': 'export const host = true;',
    });
    const host = await createRetriever(hostDir);
    await host.index();

    const fed = new FederatedRetriever(host, 'host-app');
    open.push(fed);

    const statuses = await fed.status();
    expect(statuses).toEqual([]);
  });

  test('status classifies ready, unindexed, and missing federated repositories', async () => {
    // 1. Ready repo: initialized and indexed
    const readyDir = makeProject({
      'package.json': '{"name":"ready-service"}',
      'src/service.ts': 'export function handleService() { return 42; }',
    });
    const readyRepo = await createRetriever(readyDir);
    await readyRepo.index();

    // 2. Unindexed repo: has files but no .anvesa/index.db
    const unindexedDir = makeProject({
      'package.json': '{"name":"unindexed-service"}',
      'src/worker.ts': 'export function runWorker() {}',
    });

    // 3. Missing repo path
    const missingPath = join(tmpdir(), 'does-not-exist-fed-repo');

    // Host repo with .anvesa/workspace.json configuring federation
    const hostDir = makeProject({
      'package.json': '{"name":"gateway"}',
      '.anvesa/workspace.json': JSON.stringify({
        federation: {
          enabled: true,
          repositories: [
            { name: 'ready-svc', path: readyDir, weight: 1.2 },
            { name: 'unindexed-svc', path: unindexedDir },
            { name: 'missing-svc', path: missingPath },
          ],
        },
      }),
      'src/gateway.ts': 'export function gateway() { return true; }',
    });

    const host = await createRetriever(hostDir);
    await host.index();

    const fed = new FederatedRetriever(host, 'gateway');
    open.push(fed);

    const statuses = await fed.status();
    expect(statuses.length).toBe(3);

    const readySt = statuses.find((s) => s.name === 'ready-svc');
    expect(readySt?.status).toBe('ready');
    expect(readySt?.weight).toBe(1.2);

    const unindexedSt = statuses.find((s) => s.name === 'unindexed-svc');
    expect(unindexedSt?.status).toBe('unindexed');
    expect(unindexedSt?.error).toContain('index.db');

    const missingSt = statuses.find((s) => s.name === 'missing-svc');
    expect(missingSt?.status).toBe('missing');
    expect(missingSt?.error).toContain('Directory not found');
  });

  test('parallel fan-out search fuses hits with repository provenance tagging', async () => {
    // Child repo: auth service
    const authDir = makeProject({
      'package.json': '{"name":"auth-svc"}',
      'src/tokens.ts': `/** Generate and verify secure JWT authentication tokens. */
export function generateToken(userId: string) { return 'jwt-' + userId; }
export function verifyToken(token: string) { return token.startsWith('jwt-'); }
`,
    });
    const authRepo = await createRetriever(authDir);
    await authRepo.index();

    // Host repo: api gateway
    const hostDir = makeProject({
      'package.json': '{"name":"api-gateway"}',
      '.anvesa/workspace.json': JSON.stringify({
        federation: {
          enabled: true,
          repositories: [{ name: 'auth-svc', path: authDir, weight: 1.0 }],
        },
      }),
      'src/routes.ts': `/** Handle authentication routes and user login requests. */
export function handleLogin(user: string) { return { status: 200 }; }
export function handleLogout() { return { status: 200 }; }
`,
    });
    const host = await createRetriever(hostDir);
    await host.index();

    const fed = new FederatedRetriever(host, 'gateway');
    open.push(fed);

    const page = await fed.search('authentication tokens');
    expect(page.items.length).toBeGreaterThan(0);

    // Verify provenance tagging
    const authItem = page.items.find((item) => item.repo === 'auth-svc');
    expect(authItem).toBeDefined();
    expect(authItem?.path).toBe('src/tokens.ts');
    expect(authItem?.key).toContain('auth-svc:');

    const hostItem = page.items.find((item) => item.repo === 'gateway');
    expect(hostItem).toBeDefined();
    expect(hostItem?.path).toBe('src/routes.ts');
    expect(hostItem?.key).toContain('gateway:');

    // Verify lanes and repositories summary in FederatedSearchPage
    expect(page.repositories.length).toBe(1);
    expect(page.lanes.some((l) => l.repo === 'auth-svc')).toBe(true);
    expect(page.lanes.some((l) => l.repo === 'gateway')).toBe(true);
  });

  test('per-repo weighting dynamically boosts federated repository results', async () => {
    const billingDir = makeProject({
      'package.json': '{"name":"billing"}',
      'src/charge.ts': `/** Process credit card payments and customer invoices. */
export function processInvoice(amount: number) { return { paid: true }; }
`,
    });
    const billingRepo = await createRetriever(billingDir);
    await billingRepo.index();

    const hostDir = makeProject({
      'package.json': '{"name":"portal"}',
      '.anvesa/workspace.json': JSON.stringify({
        federation: {
          enabled: true,
          repositories: [{ name: 'billing', path: billingDir, weight: 1.0 }],
        },
      }),
      'src/invoices.ts': `/** Customer invoice view for portal. */
export function viewInvoices() { return []; }
`,
    });
    const host = await createRetriever(hostDir);
    await host.index();

    const fed = new FederatedRetriever(host, 'portal');
    open.push(fed);

    // Heavily boost billing repository
    const page = await fed.search('customer invoice payment', {
      repoWeights: { billing: 10.0, portal: 0.1 },
    });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.repo).toBe('billing');
  });

  test('search supports repository filtering and host exclusion', async () => {
    const child1Dir = makeProject({
      'package.json': '{"name":"service-a"}',
      'src/index.ts': '/** Alpha service component */ export function runAlpha() {}',
    });
    const child1 = await createRetriever(child1Dir);
    await child1.index();

    const child2Dir = makeProject({
      'package.json': '{"name":"service-b"}',
      'src/index.ts': '/** Beta service component */ export function runBeta() {}',
    });
    const child2 = await createRetriever(child2Dir);
    await child2.index();

    const hostDir = makeProject({
      'package.json': '{"name":"orchestrator"}',
      '.anvesa/workspace.json': JSON.stringify({
        federation: {
          enabled: true,
          repositories: [
            { name: 'service-a', path: child1Dir },
            { name: 'service-b', path: child2Dir },
          ],
        },
      }),
      'src/index.ts': '/** Orchestrator entry */ export function main() {}',
    });
    const host = await createRetriever(hostDir);
    await host.index();

    const fed = new FederatedRetriever(host, 'orchestrator');
    open.push(fed);

    // Query excluding host and targeting only service-b
    const page = await fed.search('service component', {
      includeHost: false,
      repos: ['service-b'],
    });

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.repo).toBe('service-b');
    }
  });

  test('dependents computes blast-radius across host and federated repositories', async () => {
    const sharedDir = makeProject({
      'package.json': '{"name":"core-lib"}',
      'src/client.ts': 'export class ApiClient {}',
    });
    const sharedRepo = await createRetriever(sharedDir);
    await sharedRepo.index();

    // Client repo importing ApiClient from core-lib
    const clientDir = makeProject({
      'package.json': '{"name":"consumer"}',
      'src/consumer.ts': `import { ApiClient } from '../client';
export function execute() { return new ApiClient(); }
`,
    });
    const clientRepo = await createRetriever(clientDir);
    await clientRepo.index();

    // Host repo also importing ApiClient
    const hostDir = makeProject({
      'package.json': '{"name":"core-gateway"}',
      '.anvesa/workspace.json': JSON.stringify({
        federation: {
          enabled: true,
          repositories: [{ name: 'consumer', path: clientDir }],
        },
      }),
      'src/gateway.ts': `import { ApiClient } from './client';
export function runGateway() { return new ApiClient(); }
`,
      'src/client.ts': 'export class ApiClient {}',
    });
    const host = await createRetriever(hostDir);
    await host.index();

    const fed = new FederatedRetriever(host, 'core-gateway');
    open.push(fed);

    const blast = await fed.dependents('src/client.ts');
    expect(blast.total).toBeGreaterThan(0);
    expect(blast.byRepo['core-gateway']).toBeGreaterThanOrEqual(1);
    expect(blast.byRepo.consumer).toBeGreaterThanOrEqual(1);
  });
});

describe('federation: failures, paging and matching', () => {
  /** A host whose workspace.json federates `repositories`, indexed. */
  async function hostWith(
    repositories: readonly Record<string, unknown>[],
    files: Record<string, string> = {},
  ): Promise<Retriever> {
    const dir = makeProject({
      'package.json': '{"name":"host"}',
      '.anvesa/workspace.json': JSON.stringify({ federation: { enabled: true, repositories } }),
      'src/host.ts': '/** Route incoming requests. */ export function route() {}',
      ...files,
    });
    const host = await createRetriever(dir);
    await host.index();
    return host;
  }

  async function indexedRepo(files: Record<string, string>): Promise<string> {
    const dir = makeProject({ 'package.json': '{"name":"repo"}', ...files });
    await (await createRetriever(dir)).index();
    return dir;
  }

  const services = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [
      `src/service${i}.ts`,
      `/** Service ${i} handles payment requests. */ export function payment${i}() {}`,
    ]),
  );

  test('a repository whose search fails is reported in degraded, not dropped', async () => {
    const child = await indexedRepo(services);
    const host = await hostWith([{ name: 'payments', path: child }]);
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    const controller = new AbortController();
    controller.abort();
    const page = await fed.search('payment', {
      deadline: Deadline.of({ signal: controller.signal }),
    });
    expect(page.items).toEqual([]);
    expect(page.degraded.map((d) => [d.lane, d.repo])).toEqual([
      ['search', 'host'],
      ['search', 'payments'],
    ]);
  });

  test('a repository that cannot be opened is reported in degraded', async () => {
    const child = await indexedRepo(services);
    writeFileSync(join(child, '.anvesa', 'config.json'), '{ not json');
    const host = await hostWith([{ name: 'payments', path: child }]);
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    const page = await fed.search('payment');
    expect(page.degraded.find((d) => d.repo === 'payments')?.lane).toBe('open');
    expect(page.items.every((item) => item.repo === 'host')).toBe(true);
  });

  test('pages continue with a cursor and agree with one larger page', async () => {
    const child = await indexedRepo(services);
    const host = await hostWith([{ name: 'payments', path: child }], services);
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    const first = await fed.search('payment requests', { limit: 3 });
    expect(first.items.length).toBe(3);
    expect(first.limit).toMatchObject({ applied: 3, source: 'caller', reached: true });
    expect(first.nextCursor).not.toBeNull();
    const second = await fed.search('payment requests', {
      limit: 3,
      cursor: first.nextCursor as string,
    });
    const whole = await fed.search('payment requests', { limit: 6 });
    expect([...first.items, ...second.items].map((item) => item.key)).toEqual(
      whole.items.map((item) => item.key),
    );
    expect((await fed.search('payment requests')).limit.source).toBe('default');
  });

  test('a scope is refused across several repositories, and applies to one picked with repos', async () => {
    const child = await indexedRepo(services);
    const host = await hostWith([{ name: 'payments', path: child }]);
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    await expect(fed.search('payment', { scope: 'src' })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    const page = await fed.search('payment', { scope: 'src', repos: ['payments'] });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.repo === 'payments')).toBe(true);
  });

  test('dependents match an import by its module path, once per file, past one page', async () => {
    const importers = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `src/use${i}.ts`,
        `import { ApiClient } from '../lib/client';\nimport { x } from '../lib/client.js';\nexport const u${i} = 1;\n`,
      ]),
    );
    const consumer = await indexedRepo({
      ...importers,
      // Names that contain "client" but are not the file.
      'src/other.ts': `import { y } from '@acme/client-utils';\nimport { z } from './clientele';\nexport const o = 1;\n`,
    });
    const host = await hostWith([{ name: 'consumer', path: consumer }], {
      'src/lib/client.ts': 'export class ApiClient {}',
    });
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    const blast = await fed.dependents('src/lib/client.ts', { limit: 10 });
    expect(blast.byRepo.consumer).toBe(25);
    expect(blast.dependents.filter((d) => d.repo === 'consumer').length).toBe(10);
    expect(blast.dependents.some((d) => d.path === 'src/other.ts')).toBe(false);
    expect(blast.degraded).toEqual([]);
  });

  test('an index file is matched by its folder', async () => {
    const consumer = await indexedRepo({
      'src/a.ts': `import { a } from '../lib';\nexport const one = a;\n`,
      'src/b.ts': `import { b } from '../lib/index';\nexport const two = b;\n`,
      'src/c.ts': `import { c } from '../other/index';\nexport const three = c;\n`,
    });
    const host = await hostWith([{ name: 'consumer', path: consumer }], {
      'src/lib/index.ts': 'export const a = 1, b = 2;',
    });
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    const blast = await fed.dependents('src/lib/index.ts');
    expect(blast.dependents.filter((d) => d.repo === 'consumer').map((d) => d.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  test('errors in the host reach the caller; a repository that cannot be read is degraded', async () => {
    const broken = await indexedRepo(services);
    writeFileSync(join(broken, '.anvesa', 'config.json'), '{ not json');
    const host = await hostWith([{ name: 'broken', path: broken }]);
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    await expect(fed.dependents('src/host.ts', { depth: 0 })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    const blast = await fed.dependents('src/host.ts');
    expect(blast.degraded.map((d) => d.repo)).toEqual(['broken']);
    expect(blast.byRepo.broken).toBeUndefined();
  });

  test('dependents can be limited to some repositories', async () => {
    const consumer = await indexedRepo({
      'src/use.ts': `import { ApiClient } from '../client';\nexport const u = 1;\n`,
    });
    const host = await hostWith([{ name: 'consumer', path: consumer }], {
      'src/client.ts': 'export class ApiClient {}',
      'src/gateway.ts': `import { ApiClient } from './client';\nexport const g = 1;\n`,
    });
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    const only = await fed.dependents('src/client.ts', { repos: ['consumer'] });
    expect(Object.keys(only.byRepo)).toEqual(['consumer']);
  });

  test('a repository named like the host is an error, not merged with the host results', async () => {
    const child = await indexedRepo(services);
    const host = await hostWith([{ name: 'host', path: child }]);
    const fed = new FederatedRetriever(host, 'host');
    open.push(fed);

    const [status] = await fed.status();
    expect(status?.status).toBe('error');
    expect(status?.error).toContain('own name');
  });
});
