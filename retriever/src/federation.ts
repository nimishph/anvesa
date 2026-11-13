import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  AggregateFailureError,
  type CodeLensError,
  DEFAULT_SEARCH_LIMIT,
  decodeCursor,
  encodeCursor,
  InvalidArgumentError,
  type Page,
  resolveLimit,
  toCodeLensError,
} from '@cntxt-labs/anvesa-core';
import type { FederatedRepository } from '@cntxt-labs/anvesa-indexer';
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

/** A repository that could not be searched or read, and why. */
export interface FederatedFailure {
  readonly lane: string;
  readonly error: CodeLensError;
  readonly repo?: string | undefined;
}

export interface FederatedSearchPage extends Page<SearchResult> {
  readonly lanes: readonly {
    readonly name: string;
    readonly hits: number;
    readonly repo?: string | undefined;
  }[];
  /** Lanes, and whole repositories, that failed. The search carried on without them. */
  readonly degraded: readonly FederatedFailure[];
  readonly repositories: readonly FederatedRepoStatus[];
  readonly depth: number;
}

export interface FederatedDependent {
  readonly repo: string;
  readonly path: string;
  readonly depth: number;
}

export interface FederatedDependentsOptions {
  readonly depth?: number;
  /** Most dependents listed per repository; `total` still counts them all. */
  readonly limit?: number;
  readonly includeTypeOnly?: boolean;
  /** Only these repositories (the host's name included). Default: the host and every one configured. */
  readonly repos?: readonly string[] | undefined;
}

export interface FederatedDependentsResult {
  readonly dependents: readonly FederatedDependent[];
  /** Dependents found in every repository, before any `limit`. */
  readonly total: number;
  readonly byRepo: Readonly<Record<string, number>>;
  /** Repositories that could not be read. Their dependents are not in the result. */
  readonly degraded: readonly FederatedFailure[];
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
   * Every configured federated repository and its state. Each one with an index is opened, so a
   * repository that cannot be opened shows as `error` here rather than at the next search.
   */
  async status(): Promise<readonly FederatedRepoStatus[]> {
    const statuses: FederatedRepoStatus[] = [];
    for (const repo of this.#configured()) {
      const found = this.#inspect(repo);
      if (found.status !== 'ready') {
        statuses.push(found);
        continue;
      }
      try {
        await this.#child(found);
        statuses.push(found);
      } catch (failure) {
        statuses.push({
          ...found,
          status: 'error',
          error: toCodeLensError(failure, `open ${found.name}`).message,
        });
      }
    }
    return statuses;
  }

  /**
   * Search the host and the federated repositories, and fuse their results. Only the repositories
   * searched are opened. A repository whose search fails is reported in `degraded`; the others
   * still answer.
   */
  async search(query: string, options: FederatedSearchOptions = {}): Promise<FederatedSearchPage> {
    const { repos, repoWeights, includeHost = true, cursor, limit: requested, ...rest } = options;
    const wanted = this.#wanted(repos);
    const statuses = this.#configured().map((repo) => this.#inspect(repo));
    const degraded: FederatedFailure[] = [];

    interface SearchTarget {
      readonly name: string;
      readonly retriever: Retriever;
      readonly weight: number;
    }
    const targets: SearchTarget[] = [];
    if (includeHost && (!wanted || wanted.has(this.hostName) || wanted.has('host'))) {
      const weight = repoWeights?.[this.hostName] ?? repoWeights?.host ?? 1.0;
      targets.push({ name: this.hostName, retriever: this.host, weight });
    }
    for (const st of statuses) {
      degraded.push(...this.#unready(st, wanted));
      if (st.status !== 'ready' || (wanted && !wanted.has(st.name))) continue;
      try {
        const retriever = await this.#child(st);
        targets.push({ name: st.name, retriever, weight: repoWeights?.[st.name] ?? st.weight });
      } catch (failure) {
        degraded.push({
          lane: 'open',
          error: toCodeLensError(failure, `open ${st.name}`),
          repo: st.name,
        });
      }
    }

    // A scope is a path in one repository: across several it would filter each by a path that
    // only one of them has.
    if ((rest.scope !== undefined || rest.include !== undefined) && targets.length > 1) {
      throw new InvalidArgumentError(
        'scope',
        'used with one repository only: pick it with --repo <name>',
        rest.scope ?? 'a path filter',
      );
    }

    // Every repository is read from its first result, as deep as this page reaches, so the fused
    // order of one page agrees with the next.
    const pageLimit = resolveLimit(
      'limit',
      requested ?? this.host.config.search?.defaultLimit ?? DEFAULT_SEARCH_LIMIT,
    );
    const offset = cursor === undefined ? 0 : decodeCursor(cursor);
    const end = offset + pageLimit.value;

    const searches = await Promise.allSettled(
      targets.map((target) => target.retriever.search(query, { ...rest, limit: end })),
    );

    const lanes: Lane<SearchResult>[] = [];
    const reportedLanes: { name: string; hits: number; repo?: string }[] = [];
    let depth = 0;
    let unread = false;
    searches.forEach((settled, index) => {
      const target = targets[index] as SearchTarget;
      if (settled.status === 'rejected') {
        degraded.push({
          lane: 'search',
          error: toCodeLensError(settled.reason, `search ${target.name}`),
          repo: target.name,
        });
        return;
      }
      const page = settled.value;
      depth = Math.max(depth, page.depth);
      if (page.nextCursor !== null) unread = true;
      for (const lane of page.lanes) {
        reportedLanes.push({ name: lane.name, hits: lane.hits, repo: target.name });
      }
      for (const failure of page.degraded) degraded.push({ ...failure, repo: target.name });
      lanes.push({
        name: `${target.name}:fused`,
        weight: target.weight,
        hits: page.items.map((item) => {
          const key = `${target.name}:${item.key}`;
          // The repository's own fused score is a rank position (~0.02), not a similarity: the
          // similarity is its bestScore, and that is what a result's bar shows (#51).
          return {
            key,
            item: { ...item, repo: target.name, key },
            ...(item.bestScore === undefined ? {} : { score: item.bestScore }),
          };
        }),
      });
    });

    const fused = fuse(lanes, DEFAULT_RRF_K);
    const more = fused.length > end || unread;
    return {
      items: fused.slice(offset, end).map((f) => ({
        ...f.item,
        score: f.score,
        bestScore: f.bestScore ?? f.item.bestScore,
        foundBy: f.foundBy,
      })),
      // A repository with more than it returned leaves the total unknown.
      total: unread ? null : fused.length,
      nextCursor: more ? encodeCursor(end) : null,
      limit: {
        name: 'limit',
        applied: pageLimit.value,
        source: requested === undefined ? 'default' : 'caller',
        reached: more,
      },
      lanes: reportedLanes,
      degraded,
      repositories: statuses,
      depth,
    };
  }

  /**
   * Cross-repo blast radius: the files that import `path`, in the host by its import graph, and in
   * each federated repository by its import statements. Another repository's imports cannot be
   * resolved to a file of the host, so there an import counts when its module path names the file:
   * its last segment is the file's name (`../client` for `client.ts`), or, for an `index` file, its
   * folder (`./lib` or `./lib/index` for `lib/index.ts`). A failure in the host is the caller's
   * error; a federated repository that cannot be read is reported in `degraded`.
   */
  async dependents(
    path: string,
    options: FederatedDependentsOptions = {},
  ): Promise<FederatedDependentsResult> {
    const { repos, ...graph } = options;
    const wanted = this.#wanted(repos);
    const dependents: FederatedDependent[] = [];
    const byRepo: Record<string, number> = {};
    const degraded: FederatedFailure[] = [];
    let total = 0;

    if (!wanted || wanted.has(this.hostName) || wanted.has('host')) {
      const found = await this.host.dependents(path, graph);
      for (const d of found.dependents) {
        dependents.push({ repo: this.hostName, path: d.path, depth: d.depth });
      }
      byRepo[this.hostName] = found.total;
      total += found.total;
    }

    const names = importNames(path);
    for (const st of this.#configured().map((repo) => this.#inspect(repo))) {
      degraded.push(...this.#unready(st, wanted));
      if (st.status !== 'ready' || (wanted && !wanted.has(st.name))) continue;
      try {
        const child = await this.#child(st);
        const importers = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await child.query('//import', {
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          });
          for (const hit of page.items) {
            if (hit.path !== undefined && hit.name !== undefined && names(hit.name)) {
              importers.add(hit.path);
            }
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        const found = [...importers].sort();
        const listed = graph.limit === undefined ? found : found.slice(0, graph.limit);
        for (const importer of listed) dependents.push({ repo: st.name, path: importer, depth: 1 });
        byRepo[st.name] = found.length;
        total += found.length;
      } catch (failure) {
        degraded.push({
          lane: 'dependents',
          error: toCodeLensError(failure, `dependents in ${st.name}`),
          repo: st.name,
        });
      }
    }

    return { dependents, total, byRepo, degraded };
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

  /** The configured repositories, when federation is on. */
  #configured(): readonly FederatedRepository[] {
    const config = this.host.workspace.config.federation;
    return config?.enabled ? config.repositories : [];
  }

  /**
   * The repository names asked for, or `undefined` for all of them. A name that is neither the
   * host's nor a configured repository's is an error: it would otherwise search nothing and return
   * an empty page as if that were the answer (#51).
   */
  #wanted(repos: readonly string[] | undefined): ReadonlySet<string> | undefined {
    if (!repos || repos.length === 0) return undefined;
    const known = [this.hostName, ...this.#configured().map((repo) => repo.name)];
    for (const name of repos) {
      if (name !== 'host' && !known.includes(name)) {
        throw new InvalidArgumentError(
          '--repo',
          `a repository of this federation (${known.join(', ')})`,
          name,
        );
      }
    }
    return new Set(repos);
  }

  /** A repository asked for by name that cannot be searched: said, not silently left out. */
  #unready(st: FederatedRepoStatus, wanted: ReadonlySet<string> | undefined): FederatedFailure[] {
    if (st.status === 'ready' || !wanted?.has(st.name)) return [];
    return [
      {
        lane: 'open',
        error: toCodeLensError(
          new InvalidArgumentError('--repo', 'a repository with an index', st.name, {
            hint: st.error ?? `It is ${st.status}.`,
          }),
          `open ${st.name}`,
        ),
        repo: st.name,
      },
    ];
  }

  /**
   * What the file system says about a repository, without opening it: `ready` means it has an
   * index to open.
   */
  #inspect(repo: FederatedRepository): FederatedRepoStatus {
    const resolvedPath = resolve(this.host.root, repo.path);
    const base = {
      name: repo.name,
      path: repo.path,
      resolvedPath,
      weight: repo.weight ?? 1.0,
      defaultLanes: repo.defaultLanes,
    };
    if (repo.name === this.hostName || repo.name === 'host') {
      return {
        ...base,
        status: 'error',
        error: `"${repo.name}" is the host's own name; give the repository another one`,
      };
    }
    if (!existsSync(resolvedPath)) {
      return { ...base, status: 'missing', error: `Directory not found: ${resolvedPath}` };
    }
    if (!existsSync(resolve(resolvedPath, '.anvesa', 'index.db'))) {
      return {
        ...base,
        status: 'unindexed',
        error: 'No .anvesa/index.db found. Run `anvesa index` in that repository.',
      };
    }
    return { ...base, status: 'ready' };
  }

  /** The repository's retriever, opened the first time it is needed. */
  async #child(repo: FederatedRepoStatus): Promise<Retriever> {
    const held = this.#opened.get(repo.name);
    if (held) return held;
    const child = await Retriever.open({
      root: repo.resolvedPath,
      ...(this.host.embedder ? { embedder: this.host.embedder } : {}),
    });
    this.#opened.set(repo.name, child);
    return child;
  }
}

/** Whether an import's module path (as written, quotes included) names the file at `path`. */
function importNames(path: string): (specifier: string) => boolean {
  const stem = basename(path).replace(/\.[^.]+$/, '');
  const folder = basename(dirname(path));
  return (specifier) => {
    const segments = specifier
      .replace(/^['"`]|['"`]$/g, '')
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.');
    const last = (segments.at(-1) ?? '').replace(/\.[^.]+$/, '');
    const parent = segments.at(-2);
    if (stem !== 'index') return last === stem;
    return last === folder || (last === 'index' && parent === folder);
  };
}
