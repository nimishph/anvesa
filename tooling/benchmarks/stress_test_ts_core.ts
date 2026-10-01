/**
 * Comprehensive Stress Test for Anvesa via TypeScript Wrapper
 * Evaluates performance, memory, and scaling when the core computational engine
 * is compiled to / running as pure TypeScript (with zero native addons),
 * and compares it directly against the native SIMD-accelerated core.
 */

import { cpus, totalmem } from 'node:os';
import {
  batchDotProduct,
  batchScanTopK,
  isRustDenseAvailable,
  normalize,
  setRustDenseEnabled,
} from '../../dense/src/index.ts';
import { MEMORY_DATABASE, StoreDatabase } from '../../indexer/src/store/database.ts';
import { SqliteVectorStore } from '../../indexer/src/store/sqlite-vector-store.ts';
import {
  isRustSyntaxAvailable,
  parseFilesBatch,
  setRustSyntaxEnabled,
} from '../../syntax/src/index.ts';

const print = (msg = '') => process.stdout.write(`${msg}\n`);

interface LatencyStats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly total: number;
}

function calculateStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, val) => sum + val, 0);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
    mean: total / (sorted.length || 1),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    total,
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function runTsWrapperStressTest() {
  print('='.repeat(80));
  print('       ANVESA COMPREHENSIVE STRESS TEST: TS WRAPPER (CORE AS TS)');
  print('='.repeat(80));
  print(
    `Runtime: Bun/Node on ${process.platform}-${process.arch} | CPU: ${cpus().length}x ${cpus()[0]?.model}`,
  );
  print(
    `System Memory: ${(totalmem() / 1024 ** 3).toFixed(1)} GB | Native Addon Present: ${isRustDenseAvailable() && isRustSyntaxAvailable()}`,
  );
  print('-'.repeat(80));

  const dims = 384;
  const initialMem = process.memoryUsage();
  print(
    `Baseline Memory: RSS ${formatBytes(initialMem.rss)} | Heap Used ${formatBytes(initialMem.heapUsed)}`,
  );

  // ==========================================================================
  // SECTION 1: TS WRAPPER VECTOR SCANNING STRESS (Core Compiled to TS)
  // ==========================================================================
  print('\n>>> [TEST 1] Vector Top-K Scan via TS Wrapper (Core as TS vs Native)');
  print(
    '    Evaluating min-heap selection across 10k, 50k, and 100k vectors @ 384 dimensions...\n',
  );

  const scales = [10_000, 50_000, 100_000];
  const query = normalize(new Float32Array(dims).map((_, i) => Math.sin(i * 0.05)));

  interface VectorBenchmarkResult {
    scale: number;
    tsTime: number;
    tsThroughput: number;
    nativeTime: number;
    nativeThroughput: number;
    speedup: number;
    scoreTs: number;
    scoreNative: number;
  }

  const vectorResults: VectorBenchmarkResult[] = [];

  for (const numVectors of scales) {
    print(
      `  • Stress scaling: ${numVectors.toLocaleString()} vectors (${formatBytes(numVectors * dims * 4)} aligned buffer)`,
    );

    // Prepare random normalized vector buffer
    const buffer = new Uint8Array(numVectors * dims * 4);
    const floatView = new Float32Array(buffer.buffer);
    for (let i = 0; i < floatView.length; i++) {
      floatView[i] = Math.random() - 0.5;
    }

    // 1. Pure TS mode (Core compiled to TS)
    setRustDenseEnabled(false);
    // Warmup
    batchScanTopK(query, buffer, dims, 20);
    const t0 = performance.now();
    const tsTop = batchScanTopK(query, buffer, dims, 20);
    const tsTime = performance.now() - t0;
    const tsThroughput = numVectors / (tsTime / 1000);

    // 2. Native mode via exact same TS wrapper
    setRustDenseEnabled(true);
    // Warmup
    batchScanTopK(query, buffer, dims, 20);
    const t1 = performance.now();
    const nativeTop = batchScanTopK(query, buffer, dims, 20);
    const nativeTime = performance.now() - t1;
    const nativeThroughput = numVectors / (nativeTime / 1000);

    const speedup = tsTime / nativeTime;
    vectorResults.push({
      scale: numVectors,
      tsTime,
      tsThroughput,
      nativeTime,
      nativeThroughput,
      speedup,
      scoreTs: tsTop[0]?.score ?? 0,
      scoreNative: nativeTop[0]?.score ?? 0,
    });

    print(
      `    Core as TS:     ${tsTime.toFixed(2).padStart(6)} ms | Throughput: ${tsThroughput.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)} vec/s | Top-1 Score: ${tsTop[0]?.score.toFixed(4)}`,
    );
    print(
      `    Core as Native: ${nativeTime.toFixed(2).padStart(6)} ms | Throughput: ${nativeThroughput.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)} vec/s | Top-1 Score: ${nativeTop[0]?.score.toFixed(4)}`,
    );
    print(
      `    Acceleration:   ${speedup.toFixed(1)}x faster via native SIMD | Mathematical Parity: ${Math.abs((tsTop[0]?.score ?? 0) - (nativeTop[0]?.score ?? 0)) < 1e-4 ? 'VERIFIED' : 'MISMATCH'}`,
    );
  }

  // ==========================================================================
  // SECTION 2: TS WRAPPER BATCH DOT PRODUCT & NORMALIZATION STRESS
  // ==========================================================================
  print('\n>>> [TEST 2] High-Throughput Matrix Operations (100,000 Vectors)');
  const buffer100k = new Uint8Array(100_000 * dims * 4);
  const floatView100k = new Float32Array(buffer100k.buffer);
  for (let i = 0; i < floatView100k.length; i++) {
    floatView100k[i] = Math.random() - 0.5;
  }

  // A. Batch Dot Product
  setRustDenseEnabled(false);
  const tDotTsStart = performance.now();
  const tsScores = batchDotProduct(query, buffer100k, dims);
  const tsDotTime = performance.now() - tDotTsStart;

  setRustDenseEnabled(true);
  const tDotNativeStart = performance.now();
  const nativeScores = batchDotProduct(query, buffer100k, dims);
  const nativeDotTime = performance.now() - tDotNativeStart;
  const dotSpeedup = tsDotTime / nativeDotTime;

  print(`  • Batch Dot Product (100k vectors):`);
  print(
    `    Core as TS:     ${tsDotTime.toFixed(2)} ms (${(100_000 / (tsDotTime / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })} ops/sec)`,
  );
  print(
    `    Core as Native: ${nativeDotTime.toFixed(2)} ms (${(100_000 / (nativeDotTime / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })} ops/sec)`,
  );
  print(
    `    Parity check:   delta = ${Math.abs((tsScores[0] ?? 0) - (nativeScores[0] ?? 0)).toExponential(2)}`,
  );

  // B. Normalization Loop (10,000 vectors)
  const normVecs = Array.from({ length: 10_000 }, () =>
    new Float32Array(dims).map(() => Math.random() - 0.5),
  );

  setRustDenseEnabled(false);
  const tNormTs = performance.now();
  for (let i = 0; i < normVecs.length; i++) {
    normalize(normVecs[i] as Float32Array);
  }
  const normTsTime = performance.now() - tNormTs;

  setRustDenseEnabled(true);
  const tNormNative = performance.now();
  for (let i = 0; i < normVecs.length; i++) {
    normalize(normVecs[i] as Float32Array);
  }
  const normNativeTime = performance.now() - tNormNative;
  print(`  • High-Dimensional Normalization (10,000 vectors @ 384-dim):`);
  print(
    `    Core as TS:     ${normTsTime.toFixed(2)} ms (${(10_000 / (normTsTime / 1000)).toFixed(0)} vecs/sec)`,
  );
  print(
    `    Core as Native: ${normNativeTime.toFixed(2)} ms (${(10_000 / (normNativeTime / 1000)).toFixed(0)} vecs/sec)`,
  );

  // ==========================================================================
  // SECTION 3: TS WRAPPER AST OUTLINE EXTRACTION STRESS (500 Files)
  // ==========================================================================
  print('\n>>> [TEST 3] Multi-File AST Outline Extraction via TS Wrapper');
  const numFiles = 500;

  const tsCode = `
import { Injectable, Logger } from '@anvesa/core';
import { calculateMetrics } from './metrics';

export interface EngineConfig {
  threads: number;
  bufferSize: number;
}

/** Core processing engine */
@Injectable()
export class ProcessingEngine {
  private logger = new Logger('Engine');

  async dispatch(task: Task): Promise<Result> {
    this.logger.info('Dispatching task');
    const metric = calculateMetrics(task);
    return { ok: true, metric };
  }
}

export function createEngine(cfg: EngineConfig): ProcessingEngine {
  return new ProcessingEngine();
}
`;

  const pyCode = `
import os
import sys

class StreamDispatcher:
    """Manages event streaming pipeline."""
    def __init__(self, stream_id: str):
        self.stream_id = stream_id

    def emit(self, event: dict) -> bool:
        if not event:
            return False
        return self._send(event)

    def _send(self, payload: dict) -> bool:
        return True

def process_stream(events: list) -> int:
    """Processes a stream batch."""
    dispatcher = StreamDispatcher("main")
    return sum(1 for e in events if dispatcher.emit(e))
`;

  const fileBatch = Array.from({ length: numFiles }, (_, i) => ({
    path: i % 2 === 0 ? `src/module_${i}.ts` : `pkg/stream_${i}.py`,
    language: i % 2 === 0 ? 'typescript' : 'python',
    source: i % 2 === 0 ? tsCode : pyCode,
  }));

  // A. Core compiled to TS
  setRustSyntaxEnabled(false);
  const tAstTsStart = performance.now();
  const tsOutlines = parseFilesBatch(fileBatch);
  const astTsTime = performance.now() - tAstTsStart;
  const tsSymbolsCount = tsOutlines.reduce((acc, o) => acc + o.symbols.length, 0);

  // B. Core as Native (Rayon parallel AST parsing)
  setRustSyntaxEnabled(true);
  const tAstNatStart = performance.now();
  const natOutlines = parseFilesBatch(fileBatch);
  const astNatTime = performance.now() - tAstNatStart;
  const natSymbolsCount = natOutlines.reduce((acc, o) => acc + o.symbols.length, 0);

  print(`  • 500 Source Files AST Extraction:`);
  print(
    `    Core as TS:     ${astTsTime.toFixed(2)} ms (${(numFiles / (astTsTime / 1000)).toFixed(0)} files/sec, ${(astTsTime / numFiles).toFixed(3)} ms/file, ${tsSymbolsCount} symbols)`,
  );
  print(
    `    Core as Native: ${astNatTime.toFixed(2)} ms (${(numFiles / (astNatTime / 1000)).toFixed(0)} files/sec, ${(astNatTime / numFiles).toFixed(3)} ms/file, ${natSymbolsCount} symbols)`,
  );
  print(
    `    Parallel Speedup: ${(astTsTime / astNatTime).toFixed(1)}x faster via native Rayon engine`,
  );

  // ==========================================================================
  // SECTION 4: END-TO-END SQLITE VECTOR STORE SEARCH STRESS (10,000 Cards)
  // ==========================================================================
  print('\n>>> [TEST 4] End-to-End SQLite Vector Store Query Stress (10,000 Cards)');
  print('    Populating SQLite vector database with 10,000 embedded code cards...');

  const storeDb = StoreDatabase.open(MEMORY_DATABASE);
  const vectorStore = new SqliteVectorStore(storeDb);

  const cardsCount = 10_000;
  const sampleCards = [];
  for (let i = 0; i < cardsCount; i++) {
    const cardVec = new Float32Array(dims);
    for (let d = 0; d < dims; d++) cardVec[d] = Math.sin((i + 1) * d * 0.01);
    const unit = normalize(cardVec);
    sampleCards.push({
      card: {
        id: `sym_card_${i}`,
        kind: 'symbol' as const,
        source: { channel: 'symbols', path: `src/file_${i % 100}.ts` },
        text: `export function symbol_${i}() { return ${i}; }`,
        attrs: { group: `group_${i}` },
        trust: 'first-party' as const,
        provenance: { transformer: 'symbols', version: 'v1' },
      },
      vector: unit,
    });
  }

  await vectorStore.replaceSource({
    channel: 'symbols',
    path: 'src/all_symbols.ts',
    model: 'minilm',
    contentHash: 'hash_test_123',
    transformerVersion: 'v1',
    cards: sampleCards,
    quarantined: [],
  });

  const QUERY_COUNT = 100;
  print(`    Executing ${QUERY_COUNT} consecutive vector search queries across 10k cards...`);

  // 1. Search with Core as Pure TS
  setRustDenseEnabled(false);
  const tsLatencies: number[] = [];
  for (let q = 0; q < QUERY_COUNT; q++) {
    const qVec = new Float32Array(dims);
    for (let d = 0; d < dims; d++) qVec[d] = Math.cos((q + 1) * d * 0.02);
    const start = performance.now();
    const hits = await vectorStore.search(qVec, { channel: 'symbols', model: 'minilm', limit: 10 });
    tsLatencies.push(performance.now() - start);
    if (hits.length === 0) process.exit(1);
  }
  const tsStats = calculateStats(tsLatencies);

  // 2. Search with Core as Native
  setRustDenseEnabled(true);
  const natLatencies: number[] = [];
  for (let q = 0; q < QUERY_COUNT; q++) {
    const qVec = new Float32Array(dims);
    for (let d = 0; d < dims; d++) qVec[d] = Math.cos((q + 1) * d * 0.02);
    const start = performance.now();
    const hits = await vectorStore.search(qVec, { channel: 'symbols', model: 'minilm', limit: 10 });
    natLatencies.push(performance.now() - start);
    if (hits.length === 0) process.exit(1);
  }
  const natStats = calculateStats(natLatencies);

  print('\n  • Search Latency Distribution (10,000 SQLite Cards, 100 Queries):');
  print(`    | Metric                | Core as TS (Compiled) | Core as Native SIMD | Speedup |`);
  print(`    |-----------------------|-----------------------|---------------------|---------|`);
  print(
    `    | Median (p50) Latency  | ${tsStats.p50.toFixed(2).padStart(17)} ms | ${natStats.p50.toFixed(2).padStart(15)} ms | ${(tsStats.p50 / natStats.p50).toFixed(1).padStart(6)}x |`,
  );
  print(
    `    | 95th Percentile (p95) | ${tsStats.p95.toFixed(2).padStart(17)} ms | ${natStats.p95.toFixed(2).padStart(15)} ms | ${(tsStats.p95 / natStats.p95).toFixed(1).padStart(6)}x |`,
  );
  print(
    `    | 99th Percentile (p99) | ${tsStats.p99.toFixed(2).padStart(17)} ms | ${natStats.p99.toFixed(2).padStart(15)} ms | ${(tsStats.p99 / natStats.p99).toFixed(1).padStart(6)}x |`,
  );
  print(
    `    | Total Execution Time  | ${tsStats.total.toFixed(1).padStart(17)} ms | ${natStats.total.toFixed(1).padStart(15)} ms | ${(tsStats.total / natStats.total).toFixed(1).padStart(6)}x |`,
  );
  print(
    `    | Query Throughput      | ${(QUERY_COUNT / (tsStats.total / 1000)).toFixed(1).padStart(17)} QPS| ${(QUERY_COUNT / (natStats.total / 1000)).toFixed(1).padStart(15)} QPS| ${(natStats.total / tsStats.total > 0 ? (QUERY_COUNT / (natStats.total / 1000) / (QUERY_COUNT / (tsStats.total / 1000))).toFixed(1) : '1.0').padStart(6)}x |`,
  );

  await storeDb.close();

  // ==========================================================================
  // SECTION 5: MEMORY FOOTPRINT & FINAL SUMMARY
  // ==========================================================================
  const finalMem = process.memoryUsage();
  print('\n>>> [TEST 5] Memory Profile & Heap Efficiency');
  print(
    `  • Initial RSS:      ${formatBytes(initialMem.rss)} | Heap: ${formatBytes(initialMem.heapUsed)}`,
  );
  print(
    `  • Final RSS:        ${formatBytes(finalMem.rss)} | Heap: ${formatBytes(finalMem.heapUsed)}`,
  );
  print(
    `  • Heap Delta:       ${formatBytes(Math.max(0, finalMem.heapUsed - initialMem.heapUsed))}`,
  );

  print(`\n${'='.repeat(80)}`);
  print('               OVERALL TS WRAPPER COMPARATIVE BENCHMARK SUMMARY');
  print('='.repeat(80));
  print(
    '| Workload / Benchmark (via TS Wrapper)       | Core as TS (Compiled) | Core as Native SIMD | Speedup |',
  );
  print(
    '|---------------------------------------------|-----------------------|---------------------|---------|',
  );
  for (const r of vectorResults) {
    print(
      `| Scan ${r.scale.toLocaleString().padStart(7)} vectors (384-dim Top-20)   | ${r.tsTime.toFixed(1).padStart(17)} ms | ${r.nativeTime.toFixed(1).padStart(15)} ms | ${r.speedup.toFixed(1).padStart(6)}x |`,
    );
  }
  print(
    `| Batch Dot Product (100,000 vectors)         | ${tsDotTime.toFixed(1).padStart(17)} ms | ${nativeDotTime.toFixed(1).padStart(15)} ms | ${dotSpeedup.toFixed(1).padStart(6)}x |`,
  );
  print(
    `| High-Dim Normalization (10,000 vectors)     | ${normTsTime.toFixed(1).padStart(17)} ms | ${normNativeTime.toFixed(1).padStart(15)} ms | ${(normTsTime / normNativeTime).toFixed(1).padStart(6)}x |`,
  );
  print(
    `| 500-File AST Outline Extraction             | ${astTsTime.toFixed(1).padStart(17)} ms | ${astNatTime.toFixed(1).padStart(15)} ms | ${(astTsTime / astNatTime).toFixed(1).padStart(6)}x |`,
  );
  print(
    `| SQLite 10,000 Cards Search Latency (p50)    | ${tsStats.p50.toFixed(2).padStart(17)} ms | ${natStats.p50.toFixed(2).padStart(15)} ms | ${(tsStats.p50 / natStats.p50).toFixed(1).padStart(6)}x |`,
  );
  print(
    `| SQLite Search Query Throughput (QPS)        | ${(QUERY_COUNT / (tsStats.total / 1000)).toFixed(1).padStart(17)} QPS| ${(QUERY_COUNT / (natStats.total / 1000)).toFixed(1).padStart(15)} QPS| ${(natStats.total / tsStats.total > 0 ? (QUERY_COUNT / (natStats.total / 1000) / (QUERY_COUNT / (tsStats.total / 1000))).toFixed(1) : '1.0').padStart(6)}x |`,
  );
  print('='.repeat(80));
}

await runTsWrapperStressTest();
