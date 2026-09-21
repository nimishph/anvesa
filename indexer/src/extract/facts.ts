/**
 * What indexing learns about one source file: its symbols, what it calls and what it imports.
 *
 * Facts are plain data with no reference to the syntax tree they came from, so they can be stored
 * and compared. They record what the source *says*; deciding which symbol or file a name refers to
 * is a later step that can see the whole workspace.
 */

export interface SymbolFact {
  /** Unique within the workspace: `<path>#<qualified name>`, with `~2`, `~3` for later duplicates. */
  readonly id: string;
  readonly path: string;
  /** Qualified: `Outer.method`. */
  readonly name: string;
  /** The last segment of `name`. */
  readonly baseName: string;
  readonly kind: string;
  /** The enclosing symbol in the same file. */
  readonly parentId: string | undefined;
  /** `undefined` when the language has no export marker. */
  readonly exported: boolean | undefined;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string | undefined;
  /** Parameter names of a callable, as written (`a, ...rest`). What a bare name inside it may be. */
  readonly params?: string;
  readonly doc: string | undefined;
}

/** What a call is made on, when the source says. */
export type Receiver =
  /** `this`, `self`, `cls`, `super`, `parent`, `static`: the receiver is the enclosing type. */
  | { readonly kind: 'self' }
  /** A plain (possibly dotted) name: `client`, `this.client`, `pkg.util`, `Foo`. */
  | { readonly kind: 'name'; readonly name: string }
  /** Anything else: a call result, an index, a literal. Not resolvable by name. */
  | { readonly kind: 'complex' };

export type CallKind = 'call' | 'new' | 'jsx';

export interface CallFact {
  /** The symbol whose body contains the call; `undefined` at file level. */
  readonly from: string | undefined;
  /** The called name, without receiver, generics or `?`/`!` suffixes. */
  readonly name: string;
  readonly receiver: Receiver | undefined;
  readonly kind: CallKind;
  readonly line: number;
}

export type ImportKind =
  /** `import ... from 'x'`, `from x import y`. */
  | 'static'
  /** `import 'x'`: loaded for effect, binds nothing. */
  | 'side-effect'
  /** `export ... from 'x'`. */
  | 'reexport'
  /** `require('x')`, `import x = require('x')`. */
  | 'require'
  /** `import('x')`. */
  | 'dynamic';

export interface ImportBinding {
  /** The name in the imported module: an export name, `default`, or `*` for the whole module. */
  readonly imported: string;
  /** The name it is bound to in this file (for a re-export, the name it is exported as). */
  readonly local: string;
  readonly typeOnly: boolean;
}

export interface ImportFact {
  /** The module as written: `./util`, `@scope/pkg`, `..pkg.mod`, `os.path`. */
  readonly specifier: string;
  readonly kind: ImportKind;
  /** The specifier is a path relative to this file (`./x`, Python's `.x`). */
  readonly relative: boolean;
  /** The whole statement is type-only, so it has no runtime dependency. */
  readonly typeOnly: boolean;
  readonly bindings: readonly ImportBinding[];
  readonly line: number;
}

/**
 * A name a file makes available without declaring it in an `export` wrapper: `export { a, b as c }`
 * and `export default a`. `a` may be declared here or imported, so a barrel file that imports a
 * name and exports it on is followed to where the name is defined.
 */
export interface ExportFact {
  /** The name it is exported under (`default` for `export default a`). */
  readonly name: string;
  /** The name it has in this file. */
  readonly local: string;
  readonly line: number;
}

/** What could not be turned into a fact, so a gap in the graph can be explained. */
export interface ExtractionGaps {
  /** Calls whose target is not a name (`f()()`, `a[0]()`). */
  readonly unnamedCalls: number;
  /** `require(x)` or `import(x)` with a computed specifier. */
  readonly computedImports: number;
}

export interface FileFacts {
  readonly path: string;
  readonly language: string;
  readonly symbols: readonly SymbolFact[];
  readonly calls: readonly CallFact[];
  readonly imports: readonly ImportFact[];
  /** Names exported by a list rather than a wrapper (see `ExportFact`). */
  readonly exports: readonly ExportFact[];
  /** The source did not fully fit the grammar; facts come from the parts that did. */
  readonly hasSyntaxErrors: boolean;
  /** Whether this language's imports are understood. `false` means an empty list is not evidence. */
  readonly importsSupported: boolean;
  readonly gaps: ExtractionGaps;
}
