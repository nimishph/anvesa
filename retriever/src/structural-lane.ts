import type { Page } from '@cntxt-labs/code-lens-core';
import type { FileState, IndexStore } from '@cntxt-labs/code-lens-indexer';
import {
  type IndexQueryOptions,
  type IndexQueryResult,
  parseWExpr,
  StructuralIndex,
  WEXPR_FORMAT_VERSION,
} from '@cntxt-labs/code-lens-structural';

/** What the structural lane knows about its own coverage. */
export interface StructuralCoverage {
  readonly files: number;
  /** Indexed files with no cached outline in this format version. They cannot be queried. */
  readonly missing: readonly string[];
}

/**
 * The structural index of a project, built from the outlines the indexer cached and kept current
 * by comparing each file's content hash. A file is parsed again only when its hash changed, so a
 * long-lived server stays in step with the index without reloading it.
 */
export class StructuralLane {
  readonly #store: IndexStore;
  readonly #index = new StructuralIndex();
  readonly #loaded = new Map<string, string>();
  #missing: string[] = [];

  constructor(store: IndexStore) {
    this.#store = store;
  }

  /** Bring the index in line with the store. */
  async refresh(): Promise<StructuralCoverage> {
    const current = new Map<string, FileState>();
    let cursor: string | undefined;
    do {
      const page: Page<FileState> = await this.#store.files({
        status: 'indexed',
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const file of page.items) current.set(file.path, file);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    for (const path of [...this.#loaded.keys()]) {
      if (!current.has(path)) {
        this.#index.delete(path);
        this.#loaded.delete(path);
      }
    }
    const missing: string[] = [];
    for (const [path, state] of current) {
      if (this.#loaded.get(path) === state.contentHash) continue;
      const text = await this.#store.wexpr(path, WEXPR_FORMAT_VERSION);
      if (text === undefined) {
        this.#index.delete(path);
        this.#loaded.delete(path);
        missing.push(path);
        continue;
      }
      this.#index.set({ path, root: parseWExpr(text) });
      this.#loaded.set(path, state.contentHash);
    }
    this.#missing = missing;
    return this.coverage;
  }

  get coverage(): StructuralCoverage {
    return { files: this.#index.fileCount, missing: this.#missing };
  }

  query(wql: string, options: IndexQueryOptions = {}): IndexQueryResult {
    return this.#index.query(wql, options);
  }
}
