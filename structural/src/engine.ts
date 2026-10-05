import { type Deadline, type Page, paginate } from '@cntxt-labs/anvesa-core';
import type {
  ParseOptions,
  ParseTarget,
  SyntaxRuntime,
  SyntaxTree,
} from '@cntxt-labs/anvesa-syntax';
import { extractVueScript } from '@cntxt-labs/anvesa-syntax';
import { type EncodeStats, encodeTree } from './encode.ts';
import { MappingNotFoundError } from './errors.ts';
import { toHit, type WqlHit } from './hits.ts';
import { type LanguageMapping, MappingRegistry } from './mapping.ts';
import { encodeNative, isNativeLanguage } from './native.ts';
import type { WNode } from './node.ts';
import { attachSfcComponent } from './sfc.ts';
import { matchWql, parseWql, type WqlQuery } from './wql.ts';

export interface StructuralEngineOptions {
  readonly runtime: SyntaxRuntime;
  readonly mappings?: MappingRegistry;
  /**
   * Encode natively where the addon has the language's grammar compiled in (the default), and on
   * web-tree-sitter only where it does not. `false` always uses web-tree-sitter.
   */
  readonly native?: boolean;
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

  readonly native: boolean;

  constructor(options: StructuralEngineOptions) {
    this.runtime = options.runtime;
    this.mappings = options.mappings ?? new MappingRegistry();
    this.native = options.native ?? true;
  }

  async encode(
    source: string,
    target: ParseTarget,
    options: EncodeSourceOptions = {},
  ): Promise<EncodedFile> {
    const encoded =
      this.#encodeNatively(source, target, options) ??
      (await this.withEncoded(source, target, options, (_tree, file) => file));
    // The component of a single-file component is the file itself, which the grammar never names.
    const root = attachSfcComponent(encoded.language, encoded.path, source, encoded.root);
    return root === undefined ? encoded : { ...encoded, root };
  }

  /**
   * The language a target is in, when the addon parses it natively and a mapping serves it; else
   * `undefined`, and the caller parses on web-tree-sitter (which also reports what is missing).
   */
  nativeLanguageOf(target: ParseTarget): string | undefined {
    if (!this.native) return undefined;
    const definition =
      'language' in target
        ? this.runtime.registry.byKey(target.language)
        : this.runtime.registry.forPath(target.path);
    if (!definition || !isNativeLanguage(definition.key)) return undefined;
    return this.mappings.mappingFor(definition.key) ? definition.key : undefined;
  }

  #encodeNatively(
    source: string,
    target: ParseTarget,
    options: EncodeSourceOptions,
  ): EncodedFile | undefined {
    const language = this.nativeLanguageOf(target);
    if (language === undefined) return undefined;
    const mapping = this.mappings.mappingFor(language) as LanguageMapping;
    const path = options.path ?? ('path' in target ? target.path : undefined);
    options.deadline?.throwIfExpired(`encode ${path ?? language}`);
    const encoded = encodeNative(
      language === 'vue' ? extractVueScript(source) : source,
      language,
      mapping,
      {
        ...(path === undefined ? {} : { path }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
        ...(options.docs === undefined ? {} : { docs: options.docs }),
        ...(options.positions === undefined ? {} : { positions: options.positions }),
      },
    );
    if (!encoded) return undefined;
    return {
      path,
      language,
      root: encoded.root,
      stats: encoded.stats,
      hasSyntaxErrors: encoded.hasSyntaxErrors,
    };
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
    const definition =
      'language' in target
        ? this.runtime.registry.byKey(target.language)
        : this.runtime.registry.forPath(target.path);
    // A grammar compiled into the addon can serve this file, so the missing mapping is what would
    // stop it. Say that before parsing: otherwise the file is parsed on web-tree-sitter, fails
    // there for lack of a wasm file, and the reader is told to install a grammar they have.
    if (
      this.native &&
      definition !== undefined &&
      isNativeLanguage(definition.key) &&
      !this.mappings.has(definition.key)
    ) {
      throw new MappingNotFoundError(definition.key, this.mappings.languages());
    }
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
