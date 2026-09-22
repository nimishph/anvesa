import { readFile } from 'node:fs/promises';
import { AggregateFailureError, Deadline, toCodeLensError } from '@cntxt-labs/code-lens-core';
import { Language, Parser } from 'web-tree-sitter';
import {
  GrammarIncompatibleError,
  GrammarIntegrityError,
  GrammarMissingError,
  ParseFailedError,
  RuntimeDisposedError,
  RuntimeInitError,
  type SourceMiss,
  UnknownLanguageError,
} from './errors.ts';
import { looksLikeWasm, sha256Hex } from './files.ts';
import { type LanguageDef, LanguageRegistry } from './languages.ts';
import type { GrammarLock } from './lockfile.ts';
import { type GrammarSource, type LocatedGrammar, locateGrammar } from './sources.ts';
import { SyntaxTree } from './tree.ts';

export interface SyntaxRuntimeOptions {
  /** Where grammars are looked for, in order. See `standardLayout`. */
  readonly sources: readonly GrammarSource[];
  readonly registry?: LanguageRegistry;
  /** Trusted checksums. The first lock that knows a grammar decides. */
  readonly locks?: readonly GrammarLock[];
  /** Path to `web-tree-sitter.wasm`, for hosts (compiled binaries) where it cannot be found by default. */
  readonly runtimeWasm?: string;
}

/** What to parse as: an explicit language, or whatever a file path implies. */
export type ParseTarget = { readonly language: string } | { readonly path: string };

export interface ParseOptions {
  readonly deadline?: Deadline;
  /** Recorded on the tree and in errors. Defaults to the path when the target is a path. */
  readonly path?: string;
}

export type GrammarStatus =
  | {
      readonly state: 'ready';
      readonly origin: string;
      readonly sha256: string;
      /** A lockfile vouched for these exact bytes. */
      readonly locked: boolean;
    }
  | { readonly state: 'missing'; readonly searched: readonly SourceMiss[] }
  | {
      readonly state: 'corrupt';
      readonly origin: string;
      readonly expectedSha256: string;
      readonly actualSha256: string;
    };

export interface LanguageStatus {
  readonly language: LanguageDef;
  readonly grammar: GrammarStatus;
}

interface LoadedGrammar {
  readonly parser: Parser;
  readonly origin: string;
}

interface VerifiedGrammar {
  readonly located: LocatedGrammar;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly locked: boolean;
}

/**
 * Parses source code with tree-sitter grammars found in the configured sources.
 *
 * - Nothing is loaded until it is asked for, and a grammar loads once even when many parses ask
 *   at the same moment.
 * - The bytes that are checksummed are the bytes that are loaded.
 * - The runtime never touches the network. Getting a grammar onto disk is `installGrammar`'s job.
 */
export class SyntaxRuntime {
  readonly registry: LanguageRegistry;
  readonly #sources: readonly GrammarSource[];
  readonly #locks: readonly GrammarLock[];
  readonly #runtimeWasm: string | undefined;
  readonly #grammars = new Map<string, Promise<LoadedGrammar>>();
  #liveTrees = 0;
  #disposed = false;

  constructor(options: SyntaxRuntimeOptions) {
    this.registry = options.registry ?? new LanguageRegistry();
    this.#sources = options.sources;
    this.#locks = options.locks ?? [];
    this.#runtimeWasm = options.runtimeWasm;
  }

  /** The language a path belongs to, without loading anything. */
  detect(path: string): LanguageDef | undefined {
    return this.registry.forPath(path);
  }

  /** Trees that were parsed and not yet disposed. Non-zero at shutdown means a leak. */
  get liveTrees(): number {
    return this.#liveTrees;
  }

  /** Grammar ids currently held in memory. */
  loadedGrammars(): readonly string[] {
    return [...this.#grammars.keys()];
  }

  async parse(
    source: string,
    target: ParseTarget,
    options: ParseOptions = {},
  ): Promise<SyntaxTree> {
    this.#assertLive('parse');
    const definition = this.#resolveTarget(target);
    const path = options.path ?? ('path' in target ? target.path : undefined);
    const operation = `parse ${path ?? 'source'} as ${definition.key}`;
    const deadline = options.deadline ?? Deadline.unbounded();

    deadline.throwIfExpired(operation);
    const { parser } = await this.#grammar(definition);
    deadline.throwIfExpired(operation);

    let tree: ReturnType<Parser['parse']>;
    try {
      tree = parser.parse(source, null, { progressCallback: () => deadline.expired });
    } catch (parseFailure) {
      parser.reset();
      throw new ParseFailedError(definition.key, path, { cause: parseFailure });
    }
    if (tree === null) {
      parser.reset();
      deadline.throwIfExpired(operation);
      throw new ParseFailedError(definition.key, path);
    }

    this.#liveTrees += 1;
    return new SyntaxTree(tree, definition, path, () => {
      this.#liveTrees -= 1;
    });
  }

  /** Parse, run `work`, and dispose the tree whether or not `work` succeeds. */
  async withTree<T>(
    source: string,
    target: ParseTarget,
    work: (tree: SyntaxTree) => T | Promise<T>,
    options: ParseOptions = {},
  ): Promise<T> {
    const tree = await this.parse(source, target, options);
    try {
      return await work(tree);
    } finally {
      tree.dispose();
    }
  }

  /** Load grammars ahead of time. Every failure is reported, not just the first. */
  async preload(languages: readonly string[]): Promise<void> {
    this.#assertLive('preload');
    const settled = await Promise.allSettled(
      languages.map(async (key) => this.#grammar(this.registry.require(key))),
    );
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [toCodeLensError(result.reason, 'preload grammars')] : [],
    );
    if (failures.length > 0) throw new AggregateFailureError('preload grammars', failures);
  }

  /**
   * Where every registered language stands, without loading any grammar. A corrupt grammar is
   * reported as corrupt rather than as absent.
   */
  async status(): Promise<readonly LanguageStatus[]> {
    this.#assertLive('report status');
    return Promise.all(
      this.registry.languages().map(async (language) => ({
        language,
        grammar: await this.#inspect(language),
      })),
    );
  }

  /** Forget a loaded grammar (all of them when `key` is omitted) and free its wasm memory. */
  async unload(key?: string): Promise<void> {
    const ids =
      key === undefined ? [...this.#grammars.keys()] : [this.registry.require(key).grammar.id];
    for (const id of ids) {
      const pending = this.#grammars.get(id);
      this.#grammars.delete(id);
      if (!pending) continue;
      const [settled] = await Promise.allSettled([pending]);
      if (settled?.status === 'fulfilled') settled.value.parser.delete();
    }
  }

  /** Free every parser. Trees still alive should be disposed by their owners first. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = [...this.#grammars.values()];
    this.#grammars.clear();
    const settled = await Promise.allSettled(pending);
    for (const result of settled) {
      if (result.status === 'fulfilled') result.value.parser.delete();
    }
  }

  #assertLive(operation: string): void {
    if (this.#disposed) throw new RuntimeDisposedError(operation);
  }

  #resolveTarget(target: ParseTarget): LanguageDef {
    if ('language' in target) return this.registry.require(target.language);
    const found = this.registry.forPath(target.path);
    if (!found) {
      throw new UnknownLanguageError(
        { path: target.path },
        this.registry.languages().map((language) => language.key),
        { context: { extensions: [...this.registry.extensions()] } },
      );
    }
    return found;
  }

  #grammar(definition: LanguageDef): Promise<LoadedGrammar> {
    const id = definition.grammar.id;
    const cached = this.#grammars.get(id);
    if (cached) return cached;
    const loading = this.#load(definition);
    this.#grammars.set(id, loading);
    // A failed load must not be remembered, or installing the grammar later could never help.
    loading.catch(() => {
      if (this.#grammars.get(id) === loading) this.#grammars.delete(id);
    });
    return loading;
  }

  async #load(definition: LanguageDef): Promise<LoadedGrammar> {
    const { grammar } = definition;
    const verified = await this.#readVerified(definition);
    const { origin } = verified.located;

    if (!looksLikeWasm(verified.bytes)) {
      throw new GrammarIncompatibleError(grammar.id, origin, {
        context: { reason: 'the file is not a WebAssembly module' },
      });
    }
    await initParserRuntime(this.#runtimeWasm);

    let language: Language;
    try {
      language = await Language.load(verified.bytes);
    } catch (loadFailure) {
      throw new GrammarIncompatibleError(grammar.id, origin, { cause: loadFailure });
    }
    const parser = new Parser();
    try {
      parser.setLanguage(language);
    } catch (abiFailure) {
      parser.delete();
      throw new GrammarIncompatibleError(grammar.id, origin, {
        cause: abiFailure,
        context: { abiVersion: language.abiVersion },
      });
    }
    return { parser, origin };
  }

  /** Find the grammar, read it once, and check those bytes against the first lock that knows it. */
  async #readVerified(definition: LanguageDef): Promise<VerifiedGrammar> {
    const { grammar } = definition;
    const located = await locateGrammar(definition.key, grammar, this.#sources);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(located.path));
    } catch (readFailure) {
      throw new GrammarMissingError(
        definition.key,
        grammar.id,
        [{ source: located.origin, reason: `${located.path} was found but could not be read` }],
        { cause: readFailure },
      );
    }
    const sha256 = sha256Hex(bytes);
    const entry = this.#locks.map((lock) => lock.get(grammar.id)).find((found) => found);
    if (entry && entry.sha256 !== sha256) {
      throw new GrammarIntegrityError(grammar.id, located.origin, entry.sha256, sha256);
    }
    return { located, bytes, sha256, locked: entry !== undefined };
  }

  async #inspect(definition: LanguageDef): Promise<GrammarStatus> {
    try {
      const verified = await this.#readVerified(definition);
      return {
        state: 'ready',
        origin: verified.located.origin,
        sha256: verified.sha256,
        locked: verified.locked,
      };
    } catch (failure) {
      if (failure instanceof GrammarMissingError) {
        return { state: 'missing', searched: failure.searched };
      }
      if (failure instanceof GrammarIntegrityError) {
        return {
          state: 'corrupt',
          origin: failure.origin,
          expectedSha256: failure.expectedSha256,
          actualSha256: failure.actualSha256,
        };
      }
      throw failure;
    }
  }
}

// web-tree-sitter initialises once per process. The first runtime decides where its own wasm
// lives; a second runtime that wants a different location cannot be honoured, and says so.
let parserRuntime: { readonly wasm: string | undefined; readonly ready: Promise<void> } | undefined;

function initParserRuntime(wasm: string | undefined): Promise<void> {
  if (parserRuntime) {
    if (parserRuntime.wasm !== wasm) {
      throw new RuntimeInitError(
        'the parser runtime was already started with a different runtimeWasm',
        { context: { started: parserRuntime.wasm ?? null, requested: wasm ?? null } },
      );
    }
    return parserRuntime.ready;
  }
  const ready = Parser.init(
    wasm === undefined
      ? undefined
      : { locateFile: (file: string) => (file.endsWith('.wasm') ? wasm : file) },
  ).catch((initFailure) => {
    parserRuntime = undefined;
    throw new RuntimeInitError('web-tree-sitter could not initialise', {
      cause: initFailure,
      ...(wasm === undefined ? {} : { context: { runtimeWasm: wasm } }),
    });
  });
  parserRuntime = { wasm, ready };
  return ready;
}
