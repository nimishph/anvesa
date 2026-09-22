import {
  type CodeLensError,
  DEFAULT_RESULT_LIMIT,
  type LimitReport,
  type Page,
  toCodeLensError,
} from '@cntxt-labs/code-lens-core';
import {
  type ChannelRegistry,
  type Embedder,
  retrieve as retrieveDense,
  type VectorStore,
} from '@cntxt-labs/code-lens-dense';
import type { EdgeRecord, IndexStats, IndexStore, Workspace } from '@cntxt-labs/code-lens-indexer';
import { EDGE, IMPORT_EDGE_KINDS } from '@cntxt-labs/code-lens-indexer';
import { looksLikeWql, type WqlHit } from '@cntxt-labs/code-lens-structural';
import type { StructuralCoverage, StructuralLane } from './structural-lane.ts';

export interface ChannelInfo {
  readonly name: string;
  readonly builtin: boolean;
  readonly module: string | undefined;
  readonly enabled: boolean;
  readonly weight: number;
  readonly transformers: readonly { readonly name: string; readonly version: string }[];
  readonly trust: string;
  readonly categoryId: string;
  readonly hasSource: boolean;
  readonly cards: number;
  readonly sources: number;
  readonly quarantined: number;
}

/**
 * What the reports below read from an open project. `Retriever` provides it; naming it here keeps
 * the reports from depending on the class that calls them.
 */
export interface ProjectView {
  readonly root: string;
  readonly workspace: Workspace;
  readonly store: IndexStore;
  readonly vectors: VectorStore;
  readonly registry: ChannelRegistry;
  readonly embedder: Embedder | undefined;
  readonly structure: StructuralLane;
  channels(): Promise<readonly ChannelInfo[]>;
  query(
    wql: string,
    options?: { readonly limit?: number },
  ): Promise<Page<WqlHit> & { readonly coverage: StructuralCoverage }>;
}

export interface Status {
  readonly root: string;
  readonly index: IndexStats;
  /** A run began and did not finish, so edges and cards may be stale until the next one. */
  readonly interrupted: boolean;
  readonly channels: readonly ChannelInfo[];
  readonly embedder: { readonly id: string; readonly dimensions: number } | undefined;
  readonly structural: StructuralCoverage;
  readonly quarantinedFiles: number;
}

export async function statusOf(retriever: ProjectView): Promise<Status> {
  const { store } = retriever;
  const index = await store.stats();
  return {
    root: retriever.root,
    index,
    interrupted: (await store.getMeta('index.dirty')) !== undefined,
    channels: await retriever.channels(),
    embedder: retriever.embedder
      ? { id: retriever.embedder.info.id, dimensions: retriever.embedder.info.dimensions }
      : undefined,
    structural: await retriever.structure.refresh(),
    quarantinedFiles: index.quarantinedFiles,
  };
}

export interface Explanation {
  readonly index: IndexStats;
  readonly packages: readonly {
    readonly name: string;
    readonly root: string;
    readonly kind: string;
    readonly files: number;
  }[];
  /** Files imported by the most others: what the project leans on. */
  readonly hubFiles: readonly { readonly path: string; readonly importedBy: number }[];
  /** Symbols called from the most places. */
  readonly hubSymbols: readonly { readonly id: string; readonly calledFrom: number }[];
  /** Imports that should resolve inside the workspace and do not. */
  readonly danglingImports: number;
  readonly limit: LimitReport;
}

/**
 * What a project is made of, read from its index: languages, packages, and the files and symbols
 * everything else depends on. `limit` says how many hubs to list; it is a page size, reported.
 */
export async function explainProject(
  retriever: ProjectView,
  options: { readonly limit?: number } = {},
): Promise<Explanation> {
  const limit = options.limit ?? 12;
  const { store, workspace } = retriever;
  const importedBy = new Map<string, number>();
  const calledFrom = new Map<string, number>();
  let danglingImports = 0;

  let cursor: string | undefined;
  do {
    const page: Page<EdgeRecord> = await store.findEdges({
      kinds: [...IMPORT_EDGE_KINDS, EDGE.calls, EDGE.importsDangling],
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const edge of page.items) {
      if (edge.kind === EDGE.calls) calledFrom.set(edge.to, (calledFrom.get(edge.to) ?? 0) + 1);
      else if (edge.kind === EDGE.importsDangling) danglingImports += 1;
      else importedBy.set(edge.to, (importedBy.get(edge.to) ?? 0) + 1);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  const top = <K>(counts: Map<K, number>) =>
    [...counts].sort((a, b) => b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : 1));
  const hubFiles = top(importedBy);
  const hubSymbols = top(calledFrom);

  const packages = [];
  for (const pkg of workspace.packages()) {
    const files = await store.files({
      status: 'indexed',
      limit: 1,
      ...(pkg.root === '' ? {} : { pathPrefix: `${pkg.root}/` }),
    });
    packages.push({ name: pkg.name, root: pkg.root, kind: pkg.kind, files: files.total ?? 0 });
  }
  return {
    index: await store.stats(),
    packages,
    hubFiles: hubFiles.slice(0, limit).map(([path, count]) => ({ path, importedBy: count })),
    hubSymbols: hubSymbols.slice(0, limit).map(([id, count]) => ({ id, calledFrom: count })),
    danglingImports,
    limit: {
      name: 'hubs',
      applied: limit,
      source: options.limit === undefined ? 'default' : 'caller',
      reached: hubFiles.length > limit || hubSymbols.length > limit,
    },
  };
}

export type DiagnosisStage = 'INDEX' | 'CARDS' | 'RED_TEAM' | 'RANK';

export interface Diagnosis {
  readonly path: string;
  readonly query: string;
  /** The first stage the file was lost at, or `undefined` when it was found. */
  readonly lostAt: DiagnosisStage | undefined;
  /** One sentence saying what happened and what to do. */
  readonly verdict: string;
  readonly indexed: {
    readonly status: 'indexed' | 'quarantined' | 'missing';
    readonly detail: string;
  };
  readonly channels: readonly {
    readonly channel: string;
    readonly cards: number;
    readonly quarantinedCards: number;
    /** Why cards were quarantined, if any were. */
    readonly reasons: readonly string[];
  }[];
  /** Where the file ranked in each lane, within `depth`. */
  readonly ranks: readonly { readonly lane: string; readonly rank: number | undefined }[];
  readonly failed: readonly { readonly lane: string; readonly error: CodeLensError }[];
  readonly depth: number;
}

/**
 * Why a file did not come up for a query, by the stage that lost it: not indexed (or quarantined),
 * indexed but no cards, cards quarantined by the red-team gate, or embedded but ranked below the
 * depth searched. The stages are checked in that order and the first failure is the answer.
 */
export async function diagnoseMiss(
  retriever: ProjectView,
  input: { readonly query: string; readonly path: string; readonly depth?: number },
): Promise<Diagnosis> {
  const { store, vectors, registry } = retriever;
  const depth = input.depth ?? DEFAULT_RESULT_LIMIT;
  const state = await store.fileState(input.path);

  const indexed: Diagnosis['indexed'] =
    state === undefined
      ? { status: 'missing', detail: 'the path is not in the index' }
      : state.status === 'quarantined'
        ? { status: 'quarantined', detail: await quarantineDetail(retriever, input.path) }
        : { status: 'indexed', detail: `indexed, ${state.size} bytes` };

  const channels = [];
  for (const channel of registry.channels()) {
    const source = await vectors.sourceState(channel, input.path);
    const held = (await vectors.quarantined(channel)).filter(
      (q) => q.card.source.path === input.path,
    );
    channels.push({
      channel,
      cards: source?.cards ?? 0,
      quarantinedCards: held.length,
      reasons: [...new Set(held.flatMap((q) => q.reasons))],
    });
  }

  const ranks: { lane: string; rank: number | undefined }[] = [];
  const failed: { lane: string; error: CodeLensError }[] = [];
  if (indexed.status === 'indexed') {
    if (retriever.embedder) {
      for (const channel of registry.channels()) {
        try {
          const page = await retrieveDense({
            channel,
            query: input.query,
            embedder: retriever.embedder,
            store: vectors,
            limit: depth,
          });
          const at = page.items.findIndex((hit) => hit.card.source.path === input.path);
          ranks.push({ lane: channel, rank: at === -1 ? undefined : at + 1 });
        } catch (failure) {
          failed.push({ lane: channel, error: toCodeLensError(failure, `rank in ${channel}`) });
        }
      }
    }
    if (looksLikeWql(input.query)) {
      try {
        const page = await retriever.query(input.query, { limit: depth });
        const at = page.items.findIndex((hit) => hit.path === input.path);
        ranks.push({ lane: 'structural', rank: at === -1 ? undefined : at + 1 });
      } catch (failure) {
        failed.push({ lane: 'structural', error: toCodeLensError(failure, 'rank structurally') });
      }
    }
  }

  const found = ranks.filter((entry) => entry.rank !== undefined);
  const best = found.sort((a, b) => (a.rank as number) - (b.rank as number))[0];
  const withCards = channels.filter((entry) => entry.cards > 0);
  const quarantinedOnly = channels.filter(
    (entry) => entry.cards === 0 && entry.quarantinedCards > 0,
  );

  let lostAt: DiagnosisStage | undefined;
  let verdict: string;
  if (indexed.status !== 'indexed') {
    lostAt = 'INDEX';
    verdict =
      indexed.status === 'missing'
        ? `${input.path} is not in the index: it may be ignored, in a language with no grammar, out of scope, or not indexed since it appeared (run: code-lens index).`
        : `${input.path} was quarantined: ${indexed.detail}.`;
  } else if (withCards.length === 0 && quarantinedOnly.length > 0) {
    lostAt = 'RED_TEAM';
    verdict = `Every card of ${input.path} was quarantined by the red-team gate: ${quarantinedOnly.flatMap((e) => e.reasons).join('; ')}.`;
  } else if (withCards.length === 0) {
    lostAt = 'CARDS';
    verdict = `${input.path} is indexed but no channel made cards from it: no transformer claims it, or it yields nothing (see: code-lens channel test).`;
  } else if (best === undefined) {
    lostAt = 'RANK';
    verdict = `${input.path} is embedded (${withCards.map((e) => `${e.channel}: ${e.cards}`).join(', ')}) but ranks below ${depth} in every lane for this query.`;
  } else {
    verdict = `Found: rank ${best.rank} in ${best.lane}.`;
  }

  return {
    path: input.path,
    query: input.query,
    lostAt,
    verdict,
    indexed,
    channels,
    ranks,
    failed,
    depth,
  };
}

async function quarantineDetail(retriever: ProjectView, path: string): Promise<string> {
  let cursor: string | undefined;
  do {
    const page = await retriever.store.quarantinedFiles(cursor === undefined ? {} : { cursor });
    const found = page.items.find((entry) => entry.path === path);
    if (found) return `${found.reason}: ${found.message}`;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return 'reason unknown';
}
