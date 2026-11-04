import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  AggregateFailureError,
  type CodeLensError,
  type Page,
  toCodeLensError,
} from '@cntxt-labs/anvesa-core';
import { DEFAULT_RRF_K, fuse, type Lane } from './fuse.ts';
import type { SearchOptions, SearchResult } from './retriever.ts';
import { Retriever } from './retriever.ts';

export interface FederatedRepoStatus {
  readonly name: string;
  readonly path: string;
  readonly resolvedPath: string;
  readonly status: 'ready' | 'unindexed' | 'missing' | 'error';
  readonly error?: string | undefined;
  readonly weight: number;
  readonly defaultLanes?: readonly string[] | undefined;
}

export interface FederatedSearchOptions extends SearchOptions {
  /** Filter search to specific federated repository names. Default: host + all configured repositories. */
  readonly repos?: readonly string[] | undefined;
  /** Overrides per-repo weights from config. E.g. { 'core-api': 1.5 } */
  readonly repoWeights?: Readonly<Record<string, number>> | undefined;
  /** Include host repository in search. Default: true. */
  readonly includeHost?: boolean | undefined;
}

export interface FederatedSearchPage extends Page<SearchResult> {
  readonly lanes: readonly {
    readonly name: string;
    readonly hits: number;
    readonly repo?: string | undefined;
  }[];
  readonly degraded: readonly {
    readonly lane: string;
    readonly error: CodeLensError;
    readonly repo?: string | undefined;
  }[];
  readonly repositories: readonly FederatedRepoStatus[];
  readonly depth: number;
}

export interface FederatedDependent {
  readonly repo: string;
  readonly path: string;
  readonly depth: number;
}

export interface FederatedDependentsResult {
  readonly dependents: readonly FederatedDependent[];
  readonly total: number;
  readonly byRepo: Readonly<Record<string, number>>;
}

export class FederatedRetriever {
  readonly host: Retriever;
  readonly hostName: string;
  readonly #opened = new Map<string, Retriever>();

  constructor(host: Retriever, hostName?: string) {
    this.host = host;
    this.hostName = hostName ?? (basename(host.root) || 'host');
  }

  /**
   * Discovers and evaluates the status of all configured federated repositories.
   */
  async status(): Promise<readonly FederatedRepoStatus[]> {
    const config = this.host.workspace.config.federation;
    if (!config?.enabled || config.repositories.length === 0) {
      return [];
    }

    const statuses: FederatedRepoStatus[] = [];
    for (const repo of config.repositories) {
      const resolvedPath = resolve(this.host.root, repo.path);
      const weight = repo.weight ?? 1.0;

      if (!existsSync(resolvedPath)) {
        statuses.push({
          name: repo.name,
          path: repo.path,
          resolvedPath,
          status: 'missing',
          error: `Directory not found: ${resolvedPath}`,
          weight,
          defaultLanes: repo.defaultLanes,
        });
        continue;
      }

      // Check if index exists (.anvesa/index.db)
      const indexDb = resolve(resolvedPath, '.anvesa', 'index.db');
      if (!existsSync(indexDb)) {
        statuses.push({
          name: repo.name,
          path: repo.path,
          resolvedPath,
          status: 'unindexed',
          error: 'No .anvesa/index.db found. Run `anvesa index` in that repository.',
          weight,
          defaultLanes: repo.defaultLanes,
        });
        continue;
      }

      try {
        let child = this.#opened.get(repo.name);
        if (!child) {
          child = await Retriever.open({
            root: resolvedPath,
            ...(this.host.embedder ? { embedder: this.host.embedder } : {}),
          });
          this.#opened.set(repo.name, child);
        }
        statuses.push({
          name: repo.name,
          path: repo.path,
          resolvedPath,
          status: 'ready',
          weight,
          defaultLanes: repo.defaultLanes,
        });
      } catch (err) {
        statuses.push({
          name: repo.name,
          path: repo.path,
          resolvedPath,
          status: 'error',
          error: String(err),
          weight,
          defaultLanes: repo.defaultLanes,
        });
      }
    }

    return statuses;
  }

  /**
   * Executes a federated search across the host and all configured federated repositories.
   */
  async search(query: string, options: FederatedSearchOptions = {}): Promise<FederatedSearchPage> {
    const statuses = await this.status();
    const includeHost = options.includeHost ?? true;
    const repoFilter = options.repos ? new Set(options.repos) : undefined;

    interface SearchTarget {
      name: string;
      retriever: Retriever;
      weight: number;
    }

    const targets: SearchTarget[] = [];

    if (includeHost && (!repoFilter || repoFilter.has(this.hostName) || repoFilter.has('host'))) {
      const hostWeight = options.repoWeights?.[this.hostName] ?? options.repoWeights?.host ?? 1.0;
      targets.push({ name: this.hostName, retriever: this.host, weight: hostWeight });
    }

    for (const st of statuses) {
      if (st.status !== 'ready') continue;
      if (repoFilter && !repoFilter.has(st.name)) continue;
      const child = this.#opened.get(st.name);
      if (!child) continue;
      const repoWeight = options.repoWeights?.[st.name] ?? st.weight;
      targets.push({ name: st.name, retriever: child, weight: repoWeight });
    }

    // Execute parallel searches across all targets
    const searches = await Promise.allSettled(
      targets.map(async (t) => {
        const page = await t.retriever.search(query, options);
        return { target: t, page };
      }),
    );

    const allLanes: Lane<SearchResult>[] = [];
    const reportedLanes: { name: string; hits: number; repo?: string }[] = [];
    const degraded: { lane: string; error: CodeLensError; repo?: string }[] = [];
    let maxDepth = 0;

    for (let i = 0; i < searches.length; i++) {
      const result = searches[i];
      const target = targets[i];
      if (!target) continue;

      if (result && result.status === 'fulfilled') {
        const { target: t, page } = result.value;
        if (page.depth > maxDepth) maxDepth = page.depth;

        // Record lanes and degraded
        for (const l of page.lanes) {
          reportedLanes.push({ name: l.name, hits: l.hits, repo: t.name });
        }
        for (const d of page.degraded) {
          degraded.push({ lane: d.lane, error: d.error, repo: t.name });
        }

        // Tag all items with their originating repository
        const taggedHits = page.items.map((item) => ({
          key: `${t.name}:${item.key}`,
          item: {
            ...item,
            repo: t.name,
            key: `${t.name}:${item.key}`,
          },
          score: item.score,
        }));

        allLanes.push({
          name: `${t.name}:fused`,
          weight: t.weight,
          hits: taggedHits,
        });
      }
    }

    const fused = fuse(allLanes, DEFAULT_RRF_K);
    const limit = options.limit ?? 20;
    const items = fused.slice(0, limit).map((f) => ({
      ...f.item,
      score: f.score,
      bestScore: f.bestScore ?? f.item.bestScore,
      foundBy: f.foundBy,
    }));

    return {
      items,
      total: fused.length,
      nextCursor: null,
      limit: { name: 'limit', applied: limit, source: 'default', reached: fused.length > limit },
      lanes: reportedLanes,
      degraded,
      repositories: statuses,
      depth: maxDepth,
    };
  }

  /**
   * Cross-repo blast radius: Finds files depending on a path or symbol across the federation.
   */
  async dependents(
    path: string,
    options: {
      readonly depth?: number;
      readonly limit?: number;
      readonly includeTypeOnly?: boolean;
    } = {},
  ): Promise<FederatedDependentsResult> {
    const statuses = await this.status();
    const dependents: FederatedDependent[] = [];
    const byRepo: Record<string, number> = {};

    // 1. Host repo dependents
    try {
      const hostDeps = await this.host.dependents(path, options);
      for (const d of hostDeps.dependents) {
        dependents.push({ repo: this.hostName, path: d.path, depth: d.depth });
      }
      byRepo[this.hostName] = hostDeps.dependents.length;
    } catch (failure) {
      toCodeLensError(failure, `dependents in ${this.hostName}`);
      byRepo[this.hostName] = 0;
    }

    // 2. Federated repos: search for references / imports to target file name / base name
    const targetBase = basename(path).replace(/\.[^.]+$/, '');
    for (const st of statuses) {
      if (st.status !== 'ready') continue;
      const child = this.#opened.get(st.name);
      if (!child) continue;

      try {
        const queryRes = await child.query(`//import[contains(@name, "${targetBase}")]`);
        let count = 0;
        for (const item of queryRes.items) {
          if (item.path) {
            dependents.push({ repo: st.name, path: item.path, depth: 1 });
            count++;
          }
        }
        byRepo[st.name] = count;
      } catch (failure) {
        toCodeLensError(failure, `dependents in ${st.name}`);
        byRepo[st.name] = 0;
      }
    }

    return {
      dependents,
      total: dependents.length,
      byRepo,
    };
  }

  /**
   * Closes all child retrievers opened during federation queries.
   */
  async close(): Promise<void> {
    const errors: CodeLensError[] = [];
    for (const child of this.#opened.values()) {
      try {
        await child.close();
      } catch (failure) {
        errors.push(toCodeLensError(failure, 'close child repository'));
      }
    }
    this.#opened.clear();
    if (errors.length > 0) {
      throw new AggregateFailureError('federation close', errors);
    }
  }
}
