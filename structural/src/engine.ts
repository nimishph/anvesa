import { type Deadline, type Page, paginate } from '@cntxt-labs/anvesa-core';
import type {
  ParseOptions,
  ParseTarget,
  SyntaxRuntime,
  SyntaxTree,
} from '@cntxt-labs/anvesa-syntax';
import { type EncodeStats, encodeTree } from './encode.ts';
import { toHit, type WqlHit } from './hits.ts';
import { MappingRegistry } from './mapping.ts';
import type { WNode } from './node.ts';
import { matchWql, parseWql, type WqlQuery } from './wql.ts';

export interface StructuralEngineOptions {
  readonly runtime: SyntaxRuntime;
  readonly mappings?: MappingRegistry;
}

export interface EncodeSourceOptions {
  /** Recorded on the tree and used to answer `@path`. Defaults to the target's path. */
  readonly path?: string;
  /** See `EncodeOptions.maxDepth`. Off by default. */
  readonly maxDepth?: number;
  /** See `EncodeOptions.docs`. Off by default. */
  readonly docs?: boolean;
  /** See `EncodeOptions.positions`. Off by default. */
  readonly positions?: boolean;
  readonly deadline?: Deadline;
}

export interface EncodedFile {
  readonly path: string | undefined;
  readonly language: string;
  readonly root: WNode;
  readonly stats: EncodeStats;
  /** The source did not fully fit the grammar, so the outline may be incomplete. */
  readonly hasSyntaxErrors: boolean;
}

export interface QueryDirectOptions extends EncodeSourceOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface QueryDirectResult extends Page<WqlHit> {
  readonly file: EncodedFile;
}

/**
 * Source text in, structure out. Parses with a `SyntaxRuntime`, encodes with the language's
 * mapping, and disposes the syntax tree before returning, so callers only ever hold plain data.
 *
 * It does no file I/O: callers read files and pass their contents.
 */
export class StructuralEngine {
  readonly runtime: SyntaxRuntime;
  readonly mappings: MappingRegistry;

  constructor(options: StructuralEngineOptions) {
    this.runtime = options.runtime;
    this.mappings = options.mappings ?? new MappingRegistry();
  }

  async encode(
    source: string,
    target: ParseTarget,
    options: EncodeSourceOptions = {},
  ): Promise<EncodedFile> {
    return this.withEncoded(source, target, options, (_tree, encoded) => encoded);
  }

  /**
   * Parse once, encode, and hand both the syntax tree and the outline to `work`. The tree is
   * disposed afterwards, so `work` must not let it (or any node of it) escape. Use this when
   * something else needs the syntax tree that the outline was built from, such as call sites,
   * rather than parsing the file a second time.
   */
  async withEncoded<T>(
    source: string,
    target: ParseTarget,
    options: EncodeSourceOptions,
    work: (tree: SyntaxTree, encoded: EncodedFile) => T | Promise<T>,
  ): Promise<T> {
    const path = options.path ?? ('path' in target ? target.path : undefined);
    const parseOptions: ParseOptions = {
      ...(path === undefined ? {} : { path }),
      ...(options.deadline ? { deadline: options.deadline } : {}),
    };
    return this.runtime.withTree(
      source,
      target,
      (tree) => {
        const mapping = this.mappings.require(tree.language.key);
        const { root, stats } = encodeTree(tree.root, {
          mapping,
          ...(path === undefined ? {} : { path }),
          ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
          ...(options.docs === undefined ? {} : { docs: options.docs }),
          ...(options.positions === undefined ? {} : { positions: options.positions }),
        });
        return work(tree, {
          path,
          language: tree.language.key,
          root,
          stats,
          hasSyntaxErrors: tree.hasErrors,
        });
      },
      parseOptions,
    );
  }

  /** Query one piece of source directly, with no index. */
  async queryDirect(
    query: string | WqlQuery,
    source: string,
    target: ParseTarget,
    options: QueryDirectOptions = {},
  ): Promise<QueryDirectResult> {
    const parsed = typeof query === 'string' ? parseWql(query) : query;
    const file = await this.encode(source, target, options);
    const matches = matchWql(
      parsed,
      [file.root],
      file.path === undefined ? {} : { path: file.path },
    );
    const page = paginate(
      matches.map((match) => toHit(file.path, match.node)),
      {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      },
    );
    return { ...page, file };
  }
}
