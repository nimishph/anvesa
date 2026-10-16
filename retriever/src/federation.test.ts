import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
