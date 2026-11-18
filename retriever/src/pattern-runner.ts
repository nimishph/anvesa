import {
  type CompiledPattern,
  compilePattern,
  type Diagnostic,
  type PatternSpec,
  type WqlHit,
} from '@cntxt-labs/anvesa-structural';
import type { PatternTier } from './patterns/loader.ts';
import {
  type PatternInventory,
  type PatternResolver,
  projectPatterns,
} from './patterns/resolver.ts';

export type { Diagnostic, PatternSpec } from '@cntxt-labs/anvesa-structural';
export {
  DirectoryPatternSource,
  type InvalidPatternFile,
  type LoadedPattern,
  PATTERN_NAME,
  PATTERN_SCHEMA_URL,
  PATTERN_TIERS,
  type PatternSource,
  type PatternTier,
  parsePatternFile,
} from './patterns/loader.ts';
export {
  type ListedPattern,
  type PatternInventory,
  PatternResolver,
  projectPatterns,
  standardPatterns,
} from './patterns/resolver.ts';

export interface PatternRunResult {
  readonly pattern: string;
  readonly wql: string;
  readonly items: readonly WqlHit[];
  readonly total: number | null;
  readonly nextCursor: string | null;
  readonly diagnostic?: Diagnostic | undefined;
}

/** A run that also says what the pattern is and everything the compiler noticed. */
export interface PatternCheckResult extends PatternRunResult {
  readonly tier: PatternTier;
  /** The pattern file. */
  readonly path: string;
  /** The WQL before its parameters are bound. */
  readonly template: string;
  /** Every warning from compiling, then the run's own diagnostic, if any. */
  readonly diagnostics: readonly Diagnostic[];
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

/** Runs patterns. Finding them, and which tier wins, is the resolver's job. */
export class PatternRunner {
  readonly resolver: PatternResolver;

  constructor(
    private readonly retriever: PatternRetrieverHost,
    resolver?: PatternResolver,
  ) {
    this.resolver = resolver ?? projectPatterns(retriever.workspace.root);
  }

  /** The usable patterns. Use `inspect` to also learn which files were rejected. */
  async list(): Promise<readonly PatternSpec[]> {
    return (await this.inspect()).patterns;
  }

  /** Every pattern file: the ones that can run, and the ones that cannot, with why. */
  inspect(): Promise<PatternInventory> {
    return this.resolver.inventory();
  }

  /** The pattern called `name`: one file read per tier, not the whole folder. */
  async get(name: string): Promise<PatternSpec> {
    return (await this.resolver.find(name)).spec;
  }

  async run(
    nameOrSpec: string | PatternSpec,
    args: Record<string, string> = {},
    options: { limit?: number; cursor?: string } = {},
  ): Promise<PatternRunResult> {
    const spec = typeof nameOrSpec === 'string' ? await this.get(nameOrSpec) : nameOrSpec;
    return this.execute(compilePattern(spec), args, options);
  }

  /**
   * `run`, saying more: where the pattern is, its WQL before binding, and every compiler warning,
   * even when there are hits. Throws, as `run` does, when the file is invalid.
   */
  async check(
    reference: string,
    args: Record<string, string> = {},
    options: { limit?: number; cursor?: string } = {},
  ): Promise<PatternCheckResult> {
    const found = await this.resolver.find(reference);
    const compiled = compilePattern(found.spec);
    const result = await this.execute(compiled, args, options);
    return {
      ...result,
      tier: found.tier,
      path: found.path,
      template: compiled.templateWql,
      diagnostics: [...compiled.diagnostics, ...(result.diagnostic ? [result.diagnostic] : [])],
    };
  }

  private async execute(
    compiled: CompiledPattern,
    args: Record<string, string>,
    options: { limit?: number; cursor?: string },
  ): Promise<PatternRunResult> {
    const { spec } = compiled;
    const bound = compiled.bind(args);

    let include: ((path: string) => boolean) | undefined;
    if (bound.corpus) {
      const allowedPaths = new Set(await this.retriever.store.corpusPaths(bound.corpus));
      include = (p: string) => allowedPaths.has(p);
    }

    const queryResult = await this.retriever.query(bound.wql, {
      // The caller's limit wins; the pattern's own is its default.
      ...(options.limit || bound.limit ? { limit: options.limit ?? bound.limit } : {}),
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
