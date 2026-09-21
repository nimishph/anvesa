import type { Node, Point, Tree } from 'web-tree-sitter';
import { TreeDisposedError } from './errors.ts';
import type { LanguageDef } from './languages.ts';

export type { Node as SyntaxNode, Point, Range } from 'web-tree-sitter';

/** A place where the source did not fit the grammar. */
export interface SyntaxIssue {
  /** `error` is text the grammar could not place; `missing` is a token the parser inserted. */
  readonly kind: 'error' | 'missing';
  readonly nodeType: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly start: Point;
  readonly end: Point;
}

/**
 * A parsed file. Its memory lives in wasm, so it must be released with `dispose()` (or `using`).
 * Nodes taken from `root` belong to the tree and must not outlive it.
 */
export class SyntaxTree implements Disposable {
  readonly language: LanguageDef;
  readonly path: string | undefined;
  #tree: Tree | undefined;
  readonly #released: () => void;

  constructor(tree: Tree, language: LanguageDef, path: string | undefined, released: () => void) {
    this.#tree = tree;
    this.language = language;
    this.path = path;
    this.#released = released;
  }

  get isDisposed(): boolean {
    return this.#tree === undefined;
  }

  get root(): Node {
    return this.#live().rootNode;
  }

  /** True when any part of the source did not fit the grammar. */
  get hasErrors(): boolean {
    return this.root.hasError;
  }

  /**
   * Every syntax problem, in document order, produced lazily so the caller decides how many to
   * read. Only branches that contain a problem are entered.
   */
  *errors(): Generator<SyntaxIssue> {
    const pending: Node[] = [this.root];
    while (pending.length > 0) {
      const node = pending.pop() as Node;
      if (node.isError || node.isMissing) {
        yield {
          kind: node.isMissing ? 'missing' : 'error',
          nodeType: node.type,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          start: node.startPosition,
          end: node.endPosition,
        };
      }
      const children = node.children;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child && (child.hasError || child.isMissing)) pending.push(child);
      }
    }
  }

  /** Release the wasm memory. Safe to call more than once. */
  dispose(): void {
    const tree = this.#tree;
    if (tree === undefined) return;
    this.#tree = undefined;
    tree.delete();
    this.#released();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #live(): Tree {
    if (this.#tree === undefined) throw new TreeDisposedError(this.language.key, this.path);
    return this.#tree;
  }
}
