import { LanguageConflictError, UnknownLanguageError } from './errors.ts';

/** A compiled tree-sitter grammar. Several languages may share one (Vue parses with tsx). */
export interface GrammarRef {
  /** Identity used in lockfiles and on disk, e.g. `tsx`. */
  readonly id: string;
  readonly npmPackage: string;
  /** The wasm file inside the package and inside every grammar directory. */
  readonly file: string;
}

export interface LanguageDef {
  readonly key: string;
  /** Lowercase, with the leading dot: `.ts`. */
  readonly extensions: readonly string[];
  readonly grammar: GrammarRef;
}

const grammar = (id: string, npmPackage: string, file = `${npmPackage}.wasm`): GrammarRef => ({
  id,
  npmPackage,
  file,
});

const tsx = grammar('tsx', 'tree-sitter-typescript', 'tree-sitter-tsx.wasm');

/** Languages code-lens knows out of the box. Whether their grammar is installed is separate. */
export function builtinLanguages(): readonly LanguageDef[] {
  return [
    {
      key: 'javascript',
      extensions: ['.js', '.jsx', '.mjs', '.cjs'],
      grammar: grammar('javascript', 'tree-sitter-javascript'),
    },
    {
      key: 'typescript',
      extensions: ['.ts', '.mts', '.cts'],
      grammar: grammar('typescript', 'tree-sitter-typescript'),
    },
    { key: 'tsx', extensions: ['.tsx'], grammar: tsx },
    // A Vue single-file component is not TypeScript. It shares the tsx grammar so its script block
    // can be parsed once the indexer has cut it out of the file.
    { key: 'vue', extensions: ['.vue'], grammar: tsx },
    {
      key: 'css',
      extensions: ['.css', '.scss', '.sass', '.less'],
      grammar: grammar('css', 'tree-sitter-css'),
    },
    {
      key: 'python',
      extensions: ['.py', '.pyi'],
      grammar: grammar('python', 'tree-sitter-python'),
    },
    { key: 'go', extensions: ['.go'], grammar: grammar('go', 'tree-sitter-go') },
    { key: 'rust', extensions: ['.rs'], grammar: grammar('rust', 'tree-sitter-rust') },
    { key: 'java', extensions: ['.java'], grammar: grammar('java', 'tree-sitter-java') },
    { key: 'c', extensions: ['.c', '.h'], grammar: grammar('c', 'tree-sitter-c') },
    {
      key: 'cpp',
      extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh'],
      grammar: grammar('cpp', 'tree-sitter-cpp'),
    },
    { key: 'ruby', extensions: ['.rb'], grammar: grammar('ruby', 'tree-sitter-ruby') },
    {
      key: 'csharp',
      extensions: ['.cs'],
      grammar: grammar('csharp', 'tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm'),
    },
    { key: 'php', extensions: ['.php'], grammar: grammar('php', 'tree-sitter-php') },
  ];
}

/**
 * The set of languages one runtime understands. Instance-scoped: two runtimes never share state,
 * and registering a language that collides with an existing one is an error, not a silent no-op.
 */
export class LanguageRegistry {
  readonly #byKey = new Map<string, LanguageDef>();
  readonly #byExtension = new Map<string, LanguageDef>();
  readonly #grammarById = new Map<string, { grammar: GrammarRef; owner: string }>();

  constructor(definitions: Iterable<LanguageDef> = builtinLanguages()) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: LanguageDef): void {
    const existing = this.#byKey.get(definition.key);
    if (existing) {
      throw new LanguageConflictError(
        `language key "${definition.key}"`,
        existing.key,
        definition.key,
      );
    }
    const known = this.#grammarById.get(definition.grammar.id);
    if (
      known &&
      (known.grammar.file !== definition.grammar.file ||
        known.grammar.npmPackage !== definition.grammar.npmPackage)
    ) {
      throw new LanguageConflictError(
        `grammar id "${definition.grammar.id}" (as ${known.grammar.npmPackage}/${known.grammar.file})`,
        known.owner,
        definition.key,
      );
    }
    const extensions = definition.extensions.map((ext) => ext.toLowerCase());
    for (const ext of extensions) {
      const owner = this.#byExtension.get(ext);
      if (owner) throw new LanguageConflictError(`extension "${ext}"`, owner.key, definition.key);
    }
    this.#byKey.set(definition.key, definition);
    if (!known)
      this.#grammarById.set(definition.grammar.id, {
        grammar: definition.grammar,
        owner: definition.key,
      });
    for (const ext of extensions) this.#byExtension.set(ext, definition);
  }

  byKey(key: string): LanguageDef | undefined {
    return this.#byKey.get(key);
  }

  /** Like `byKey`, but a missing language is an error naming what is registered. */
  require(key: string): LanguageDef {
    const found = this.#byKey.get(key);
    if (!found) throw new UnknownLanguageError({ language: key }, [...this.#byKey.keys()]);
    return found;
  }

  forExtension(extension: string): LanguageDef | undefined {
    return this.#byExtension.get(extension.toLowerCase());
  }

  /**
   * The language a file path belongs to, judged from the file name only. A dot in a directory
   * name is not an extension, a dotfile has no extension, and the longest registered suffix wins
   * so a multi-part extension such as `.d.ts` can be registered ahead of `.ts`.
   */
  forPath(path: string): LanguageDef | undefined {
    const name = baseName(path).toLowerCase();
    for (let dot = name.indexOf('.', 1); dot !== -1; dot = name.indexOf('.', dot + 1)) {
      const found = this.#byExtension.get(name.slice(dot));
      if (found) return found;
    }
    return undefined;
  }

  languages(): readonly LanguageDef[] {
    return [...this.#byKey.values()];
  }

  /** Distinct grammars, in registration order. */
  grammars(): readonly GrammarRef[] {
    return [...this.#grammarById.values()].map(({ grammar: registered }) => registered);
  }

  extensions(): ReadonlySet<string> {
    return new Set(this.#byExtension.keys());
  }
}

function baseName(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(separator + 1);
}
