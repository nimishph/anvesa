import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  compilePattern,
  type Diagnostic,
  type PatternSpec,
  type WqlHit,
} from '@cntxt-labs/anvesa-structural';

export type { Diagnostic, PatternSpec } from '@cntxt-labs/anvesa-structural';

export interface PatternRunResult {
  readonly pattern: string;
  readonly wql: string;
  readonly items: readonly WqlHit[];
  readonly total: number | null;
  readonly nextCursor: string | null;
  readonly diagnostic?: Diagnostic | undefined;
}

export interface PatternRetrieverHost {
  readonly workspace: { readonly root: string };
  readonly store: {
    corpusPaths(corpus: string): Promise<readonly string[]>;
    stats(): Promise<{ readonly byLanguage?: readonly { readonly language: string }[] }>;
  };
  query(
    wql: string,
    options?: {
      limit?: number;
      cursor?: string;
      include?: (path: string) => boolean;
    },
  ): Promise<{
    readonly items: readonly WqlHit[];
    readonly total: number | null;
    readonly nextCursor: string | null;
  }>;
}

export class PatternRunner {
  constructor(private readonly retriever: PatternRetrieverHost) {}

  patternsDirectory(): string {
    return join(this.retriever.workspace.root, '.anvesa', 'patterns');
  }

  async list(): Promise<readonly PatternSpec[]> {
    const dir = this.patternsDirectory();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const specs: PatternSpec[] = [];
    for (const f of files) {
      try {
        const text = await readFile(join(dir, f), 'utf8');
        const parsed = JSON.parse(text) as PatternSpec;
        if (parsed.name && parsed.target) specs.push(parsed);
      } catch (_failure) {
        // Skip unparseable pattern files during discovery
        void _failure;
      }
    }
    return specs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<PatternSpec> {
    const list = await this.list();
    const found = list.find((p) => p.name === name);
    if (!found) {
      throw new InvalidArgumentError(
        'name',
        `one of ${(await this.list()).map((p) => p.name).join(', ')}`,
        name,
      );
    }
    return found;
  }

  async run(
    nameOrSpec: string | PatternSpec,
    args: Record<string, string> = {},
    options: { limit?: number; cursor?: string } = {},
  ): Promise<PatternRunResult> {
    const spec = typeof nameOrSpec === 'string' ? await this.get(nameOrSpec) : nameOrSpec;
    const compiled = compilePattern(spec);
    const bound = compiled.bind(args);

    let include: ((path: string) => boolean) | undefined;
    if (bound.corpus) {
      const allowedPaths = new Set(await this.retriever.store.corpusPaths(bound.corpus));
      include = (p: string) => allowedPaths.has(p);
    }

    const queryResult = await this.retriever.query(bound.wql, {
      ...(bound.limit || options.limit ? { limit: bound.limit ?? options.limit } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(include ? { include } : {}),
    });

    const repoStats = await this.retriever.store.stats();
    const repoLangs = repoStats.byLanguage?.map((l) => l.language) ?? [];
    const diag = compiled.diagnoseResults(queryResult.items.length, repoLangs);

    return {
      pattern: spec.name,
      wql: bound.wql,
      items: queryResult.items,
      total: queryResult.total,
      nextCursor: queryResult.nextCursor,
      ...(diag ? { diagnostic: diag } : {}),
    };
  }
}
