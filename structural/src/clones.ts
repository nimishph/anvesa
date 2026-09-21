import { ATTR, lineRange, type WNode, walk } from './node.ts';

export interface CloneOccurrence {
  readonly path: string;
  readonly tag: string;
  readonly name: string | undefined;
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
}

export interface CloneGroup {
  /** The shared hash: a `shape` hash or a `hash` (signature) hash, per `kind`. */
  readonly key: string;
  readonly kind: 'shape' | 'signature';
  /** Syntax nodes in the shared body. Only meaningful for `shape` groups. */
  readonly shapeNodes: number | undefined;
  readonly occurrences: readonly CloneOccurrence[];
}

export interface CloneOptions {
  /**
   * `shape` (default) groups callables whose normalised bodies are identical, so renamed or
   * re-valued copies are found. `signature` groups callables with the same name and signature.
   */
  readonly by?: 'shape' | 'signature';
  /** Keep stub bodies (empty, comment-only, throw-only, literal return). Off by default. */
  readonly includeTrivial?: boolean;
  /** Ignore shapes smaller than this many syntax nodes. No minimum unless the caller sets one. */
  readonly minShapeNodes?: number;
}

const TRIVIAL_BODIES: ReadonlySet<string> = new Set([
  'empty',
  'comment-only',
  'throw-only',
  'return-literal',
]);

export interface CloneSource {
  readonly path: string;
  readonly root: WNode;
}

/**
 * Find duplicated code across files. Groups are ordered largest body first, then by number of
 * copies, then by key, so the same input always gives the same output. Nothing is dropped: page
 * the result with `paginate` if it is long.
 */
export function findClones(
  files: Iterable<CloneSource>,
  options: CloneOptions = {},
): readonly CloneGroup[] {
  const by = options.by ?? 'shape';
  const attr = by === 'shape' ? ATTR.shape : ATTR.hash;
  const groups = new Map<
    string,
    { shapeNodes: number | undefined; occurrences: CloneOccurrence[] }
  >();

  for (const { path, root } of files) {
    for (const { node } of walk(root)) {
      const key = node.attrs.get(attr);
      if (key === undefined) continue;
      if (!options.includeTrivial && TRIVIAL_BODIES.has(node.attrs.get(ATTR.bodyKind) ?? ''))
        continue;
      const size = Number.parseInt(node.attrs.get(ATTR.shapeNodes) ?? '', 10);
      const shapeNodes = Number.isFinite(size) ? size : undefined;
      if (options.minShapeNodes !== undefined && (shapeNodes ?? 0) < options.minShapeNodes)
        continue;

      const lines = lineRange(node);
      const group = groups.get(key) ?? { shapeNodes, occurrences: [] };
      group.occurrences.push({
        path,
        tag: node.tag,
        name: node.attrs.get(ATTR.name) ?? node.attrs.get(ATTR.assignedTo),
        startLine: lines?.startLine,
        endLine: lines?.endLine,
      });
      groups.set(key, group);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.occurrences.length > 1)
    .map(([key, group]) => ({
      key,
      kind: by,
      shapeNodes: by === 'shape' ? group.shapeNodes : undefined,
      occurrences: group.occurrences,
    }))
    .sort(
      (a, b) =>
        (b.shapeNodes ?? 0) - (a.shapeNodes ?? 0) ||
        b.occurrences.length - a.occurrences.length ||
        a.key.localeCompare(b.key),
    );
}
