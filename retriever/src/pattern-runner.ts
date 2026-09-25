import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
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

/** A pattern file that could not be used, and why. Never dropped silently. */
export interface InvalidPatternFile {
  readonly file: string;
  readonly code: string;
  readonly message: string;
}

export interface PatternInventory {
  readonly patterns: readonly PatternSpec[];
  readonly invalid: readonly InvalidPatternFile[];
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

  /** The usable patterns. Use `inspect` to also learn which files were rejected. */
  async list(): Promise<readonly PatternSpec[]> {
    return (await this.inspect()).patterns;
  }

  /** Every file in the patterns directory: the ones that compile, and the ones that do not. */
  async inspect(): Promise<PatternInventory> {
    const dir = this.patternsDirectory();
    if (!existsSync(dir)) return { patterns: [], invalid: [] };
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const patterns: PatternSpec[] = [];
    const invalid: InvalidPatternFile[] = [];
    for (const f of files) {
      try {
        const text = await readFile(join(dir, f), 'utf8');
        let parsed: PatternSpec;
        try {
          parsed = JSON.parse(text) as PatternSpec;
        } catch (failure) {
          throw new InvalidArgumentError('pattern file', 'valid JSON', f, { cause: failure });
        }
        if (!parsed || typeof parsed.name !== 'string' || !parsed.name || !parsed.target) {
          throw new InvalidArgumentError('pattern', 'an object with "name" and "target"', f);
        }
        compilePattern(parsed);
        patterns.push(parsed);
      } catch (failure) {
        const typed = toCodeLensError(failure, `load pattern ${f}`);
        invalid.push({ file: f, code: typed.code, message: typed.message });
      }
    }
    patterns.sort((a, b) => a.name.localeCompare(b.name));
    return { patterns, invalid };
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
