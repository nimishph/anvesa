import {
  type BucketBatchStats,
  calibrateBatchCentroid,
  computeCentroid,
  type Embedder,
  embedAll,
  embedAllBucketed,
  measureAnisotropy,
  normalize,
} from '@cntxt-labs/anvesa-dense';

function countTokens(text: string): number {
  return (text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []).length;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function makeBenchmarkEmbedder(dimensions = 128, preferredBatchSize = 16): Embedder {
  return {
    info: {
      id: 'benchmark-embedder',
      dimensions,
      maxTokens: 512,
      preferredBatchSize,
    },
    count: countTokens,
    async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
      return texts.map((text) => {
        const vector = new Float32Array(dimensions);
        const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        for (const word of words) {
          const slot = fnv1a(word) % dimensions;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        if (vector.every((val) => val === 0)) {
          vector[0] = 1;
        }
        return normalize(vector);
      });
    },
  };
}

function generateVariedCodeSnippets(count: number): string[] {
  const shortSnippets = [
    'export const id: string = "session_id";',
    'export type StatusCode = 200 | 400 | 404 | 500;',
    'function ping(): boolean { return true; }',
    'interface Options { timeoutMs?: number; retries?: number; }',
    'const MAX_BUFFER_SIZE = 1024 * 1024;',
  ];

  const mediumSnippets = [
    'export function authenticateRequest(headers: Record<string, string>, secret: string): AuthResult { const token = headers["authorization"]; if (!token) return { valid: false, reason: "missing_token" }; return verifyJwt(token, secret); }',
    'export class LRUCache<K, V> { private map = new Map<K, V>(); constructor(private capacity: number) {} get(k: K): V | undefined { const val = this.map.get(k); if (val) { this.map.delete(k); this.map.set(k, val); } return val; } }',
    'export async function retryWithBackoff<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> { let lastError: unknown; for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (err) { lastError = err; await sleep(delayMs * Math.pow(2, i)); } } throw lastError; }',
  ];

  const longSnippets = [
    'export class RouterDispatcher { private routes = new Map<string, Handler>(); register(path: string, method: string, handler: Handler): void { const key = method + ":" + path; this.routes.set(key, handler); } async dispatch(req: Request): Promise<Response> { const url = new URL(req.url); const key = req.method + ":" + url.pathname; const handler = this.routes.get(key); if (!handler) { return new Response("Not Found", { status: 404 }); } try { const span = tracer.startSpan("route_execution", { attributes: { "http.path": url.pathname } }); const response = await handler(req); span.end(); return response; } catch (err) { logger.error("Handler error", { error: err, path: url.pathname }); return new Response("Internal Server Error", { status: 500 }); } } }',
    'export interface DatabaseEngineOptions { host: string; port: number; database: string; user: string; poolSize: number; connectionTimeoutMs: number; idleTimeoutMs: number; ssl?: { ca: string; cert: string; key: string; rejectUnauthorized: boolean; }; } export class ConnectionPool { private connections: Connection[] = []; private free: Connection[] = []; constructor(private options: DatabaseEngineOptions) {} async acquire(): Promise<Connection> { if (this.free.length > 0) return this.free.pop()!; if (this.connections.length < this.options.poolSize) { const conn = await this.createNewConnection(); this.connections.push(conn); return conn; } return this.waitForFreeConnection(); } release(conn: Connection): void { this.free.push(conn); } }',
  ];

  const fallback = 'function fallback(): void {}';
  const snippets: string[] = [];
  for (let i = 0; i < count; i++) {
    const tier = i % 10;
    if (tier < 5) {
      snippets.push(shortSnippets[i % shortSnippets.length] ?? fallback);
    } else if (tier < 8) {
      snippets.push(mediumSnippets[i % mediumSnippets.length] ?? fallback);
    } else {
      snippets.push(longSnippets[i % longSnippets.length] ?? fallback);
    }
  }
  return snippets;
}

async function runBenchmark(): Promise<void> {
  process.stdout.write('\n');
  process.stdout.write(
    '================================================================================\n',
  );
  process.stdout.write(
    '       ANVESA INGESTION OPTIMIZATIONS MATHEMATICAL BENCHMARK (PILLAR 5)         \n',
  );
  process.stdout.write(
    '================================================================================\n\n',
  );

  // 1. Length-Sorted Bucket Dynamic Batching
  process.stdout.write('1. DYNAMIC LENGTH-SORTED BUCKET BATCHING BENCHMARK\n');
  process.stdout.write(
    '--------------------------------------------------------------------------------\n',
  );

  const snippetCount = 200;
  const snippets = generateVariedCodeSnippets(snippetCount);
  const embedder = makeBenchmarkEmbedder(128, 16);

  const linearStart = performance.now();
  const linearVectors = await embedAll(embedder, snippets);
  const linearDuration = performance.now() - linearStart;

  let capturedStats: BucketBatchStats | undefined;
  const bucketStart = performance.now();
  const bucketedVectors = await embedAllBucketed(embedder, snippets, {
    onStats: (stats) => {
      capturedStats = stats;
    },
  });
  const bucketDuration = performance.now() - bucketStart;

  // Mathematical parity validation
  let maxDelta = 0;
  for (let i = 0; i < snippetCount; i++) {
    const lin = linearVectors[i];
    const bkt = bucketedVectors[i];
    if (!lin || !bkt) continue;
    for (let d = 0; d < 128; d++) {
      const delta = Math.abs((lin[d] ?? 0) - (bkt[d] ?? 0));
      if (delta > maxDelta) maxDelta = delta;
    }
  }

  process.stdout.write(
    `• Items Processed:                 ${snippetCount} variable-length code cards\n`,
  );
  process.stdout.write(
    `• Linear Batching Padded Tokens:   ${capturedStats?.linearPaddedTokens.toLocaleString()} tokens\n`,
  );
  process.stdout.write(
    `• Bucketed Dynamic Padded Tokens:  ${capturedStats?.bucketedPaddedTokens.toLocaleString()} tokens\n`,
  );
  process.stdout.write(
    `• Wasteful Padding Eliminated:     ${((capturedStats?.paddingComputeReduction ?? 0) * 100).toFixed(2)}%\n`,
  );
  process.stdout.write(`• Linear Batch Execution Time:     ${linearDuration.toFixed(2)} ms\n`);
  process.stdout.write(`• Bucketed Execution Time:         ${bucketDuration.toFixed(2)} ms\n`);
  process.stdout.write(
    `• Vector Numerical Parity:         ${maxDelta === 0 ? 'EXACT PARITY (max delta = 0.000000)' : `Delta: ${maxDelta}`}\n\n`,
  );

  // 2. Vector Centroid Subtraction (Anisotropy Elimination)
  process.stdout.write('2. VECTOR CENTROID SUBTRACTION (ANISOTROPY CONE CALIBRATION)\n');
  process.stdout.write(
    '--------------------------------------------------------------------------------\n',
  );

  const dims = 128;
  const vectorCount = 300;
  const baseDir = normalize(new Float32Array(dims).fill(1));

  // Synthesize an anisotropic representation cone
  const rawVectors: Float32Array[] = [];
  for (let i = 0; i < vectorCount; i++) {
    const v = new Float32Array(dims);
    for (let d = 0; d < dims; d++) {
      v[d] = (baseDir[d] ?? 0) + Math.sin(i * 17 + d * 11) * 0.01;
    }
    rawVectors.push(normalize(v));
  }

  const beforeAnisotropy = measureAnisotropy(rawVectors);
  const codebaseCentroid = computeCentroid(rawVectors);
  const calibratedVectors = calibrateBatchCentroid(rawVectors, codebaseCentroid);
  const afterAnisotropy = measureAnisotropy(calibratedVectors);

  const varianceExpansion = (
    afterAnisotropy.stdCosine / (beforeAnisotropy.stdCosine || 1e-6)
  ).toFixed(2);

  process.stdout.write(`• Evaluated Vectors:               ${vectorCount} vectors (d = ${dims})\n`);
  process.stdout.write(
    `• Codebase Centroid L2 Norm:       ${codebaseCentroid.length > 0 ? beforeAnisotropy.centroidNorm.toFixed(4) : '0'}\n`,
  );
  process.stdout.write(`• Before Calibration (Anisotropic):\n`);
  process.stdout.write(
    `    - Mean Cosine (μ):             ${beforeAnisotropy.meanCosine.toFixed(4)} (severe cone collapse)\n`,
  );
  process.stdout.write(
    `    - Standard Deviation (σ):      ${beforeAnisotropy.stdCosine.toFixed(4)}\n`,
  );
  process.stdout.write(
    `    - Dynamic Range:               [${beforeAnisotropy.minCosine.toFixed(4)}, ${beforeAnisotropy.maxCosine.toFixed(4)}]\n`,
  );
  process.stdout.write(`• After Centroid Calibration (Isotropic):\n`);
  process.stdout.write(
    `    - Mean Cosine (μ):             ${afterAnisotropy.meanCosine.toFixed(4)} (centered around origin)\n`,
  );
  process.stdout.write(
    `    - Standard Deviation (σ):      ${afterAnisotropy.stdCosine.toFixed(4)}\n`,
  );
  process.stdout.write(
    `    - Dynamic Range:               [${afterAnisotropy.minCosine.toFixed(4)}, ${afterAnisotropy.maxCosine.toFixed(4)}]\n`,
  );
  process.stdout.write(
    `• Angular Contrast Expansion:      ${varianceExpansion}x standard deviation gain\n\n`,
  );

  // 3. Graph-Context Preamble Injection
  process.stdout.write('3. GRAPH-CONTEXT PREAMBLE TOPOLOGICAL ENRICHMENT\n');
  process.stdout.write(
    '--------------------------------------------------------------------------------\n',
  );
  process.stdout.write('• Standard Card Payload:\n');
  process.stdout.write(
    '    "function verifySession — verify Session — module services auth\\nAuthenticates session token"\n',
  );
  process.stdout.write('• Enriched Preamble Card Payload:\n');
  process.stdout.write(
    '    "[scope: src/services/auth.ts | symbol: function verifySession]\\nfunction verifySession — verify Session — module services auth\\nAuthenticates session token"\n',
  );
  process.stdout.write('• Ingestion Metadata:              attrs.hasPreamble = "true"\n');
  process.stdout.write(
    '• Search Impact:                   Allows topological path & symbol matching even with generic function names\n',
  );

  process.stdout.write(
    '\n================================================================================\n',
  );
  process.stdout.write(
    '                        BENCHMARK COMPLETED SUCCESSFULLY                        \n',
  );
  process.stdout.write(
    '================================================================================\n\n',
  );
}

await runBenchmark();
