import { toCodeLensError } from '@cntxt-labs/code-lens-core';
import {
  DiskEnvironment,
  defaultConfig,
  FactExtractor,
  GraphLinker,
  ImportResolver,
  type LinkSummary,
  readSource,
  SqliteIndexStore,
  summarize,
  Workspace,
  type WorkspaceConfig,
  walkSources,
} from '@cntxt-labs/code-lens-indexer';
import { StructuralEngine } from '@cntxt-labs/code-lens-structural';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/code-lens-syntax';
import type { ObservedCall } from './compare.ts';

export interface IndexOptions {
  /** The repository root. */
  readonly root: string;
  /** Where to write the index database. */
  readonly databasePath: string;
  /** Ignore rules on top of the repository's own, in `.gitignore` syntax. */
  readonly exclude?: readonly string[];
  /** Index only these languages. */
  readonly languages: readonly string[];
}

export interface IndexRun {
  readonly workspace: Workspace;
  readonly store: SqliteIndexStore;
  readonly resolver: ImportResolver;
  /** Every call the linker decided on, by file. */
  readonly calls: ReadonlyMap<string, readonly ObservedCall[]>;
  readonly link: LinkSummary;
  readonly timings: {
    readonly walkAndExtractMs: number;
    readonly linkMs: number;
  };
  readonly files: {
    readonly indexed: number;
    readonly quarantined: readonly { path: string; reason: string; message: string }[];
    readonly withSyntaxErrors: number;
    readonly skippedLanguages: ReadonlyMap<string, number>;
    readonly bytes: number;
  };
  /** Largest resident set seen while running, in bytes. */
  readonly peakRss: number;
  dispose(): Promise<void>;
}

/** Index a repository the way an indexing run will: walk, read, extract, store, link. */
export async function indexRepository(options: IndexOptions): Promise<IndexRun> {
  const config: WorkspaceConfig = { ...defaultConfig(), exclude: options.exclude ?? [] };
  const workspace = await Workspace.open({ root: options.root, config });
  const store = SqliteIndexStore.open(options.databasePath);
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  const extractor = new FactExtractor(new StructuralEngine({ runtime }));
  const wanted = new Set(options.languages);

  let peakRss = 0;
  const sample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  const quarantined: { path: string; reason: string; message: string }[] = [];
  const skipped = new Map<string, number>();
  let indexed = 0;
  let withSyntaxErrors = 0;
  let bytes = 0;

  const extractStart = performance.now();
  for await (const entry of walkSources(workspace)) {
    if (!wanted.has(entry.language)) {
      skipped.set(entry.language, (skipped.get(entry.language) ?? 0) + 1);
      continue;
    }
    const content = await readSource(options.root, entry.path);
    if (content.kind === 'binary') {
      await store.quarantineFile({
        path: entry.path,
        reason: 'binary',
        message: 'the file is binary',
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      });
      quarantined.push({ path: entry.path, reason: 'binary', message: 'the file is binary' });
      continue;
    }
    try {
      const facts = await extractor.extract(entry.path, content.content);
      await store.replaceFile({
        path: entry.path,
        language: entry.language,
        packageRoot: entry.package?.root,
        repo: entry.repo,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        contentHash: content.hash,
        facts,
      });
      indexed += 1;
      bytes += content.bytes;
      if (facts.hasSyntaxErrors) withSyntaxErrors += 1;
    } catch (failure) {
      const error = toCodeLensError(failure, `extract facts from ${entry.path}`);
      await store.quarantineFile({
        path: entry.path,
        reason: 'extract-failed',
        message: error.message,
        errorCode: error.code,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        contentHash: content.hash,
      });
      quarantined.push({ path: entry.path, reason: 'extract-failed', message: error.message });
    }
    if (indexed % 50 === 0) sample();
  }
  const walkAndExtractMs = performance.now() - extractStart;
  sample();

  const resolver = new ImportResolver(new DiskEnvironment(options.root), workspace.packages());
  const linker = new GraphLinker(store, resolver);
  const calls = new Map<string, ObservedCall[]>();
  const linkStart = performance.now();
  const reports = await linker.linkAll({
    onCall(path, call, resolution) {
      const list = calls.get(path);
      if (list) list.push({ call, resolution });
      else calls.set(path, [{ call, resolution }]);
    },
  });
  const linkMs = performance.now() - linkStart;
  sample();

  return {
    workspace,
    store,
    resolver,
    calls,
    link: summarize(reports),
    timings: { walkAndExtractMs, linkMs },
    files: { indexed, quarantined, withSyntaxErrors, skippedLanguages: skipped, bytes },
    peakRss,
    async dispose() {
      await store.close();
      await runtime.dispose();
    },
  };
}
