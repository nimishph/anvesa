/**
 * The kinds of edge the linker writes. A kind says both what the link is and how far to trust it,
 * so a query can ask for exactly the evidence it wants. Nothing that fails to link is dropped: it
 * becomes an edge of an `unresolved`, `dangling` or `external` kind that says where it went.
 *
 * Nodes are file paths (`src/a.ts`) and symbol ids (`src/a.ts#Outer.run`). A file-level call
 * starts at the file's path.
 */
export const EDGE = {
  /** file -> file it imports at run time. */
  imports: 'imports',
  /** file -> file it imports only for types. */
  importsType: 'imports:type',
  /** file -> file it re-exports from. Changes to the target change this file's own exports. */
  reexports: 'imports:reexport',
  /** file -> a file that exists but is not source (stylesheet, JSON, image). */
  importsAsset: 'imports:asset',
  /** file -> package outside the workspace. */
  importsExternal: 'imports:external',
  /** file -> specifier that should resolve inside the workspace and does not. */
  importsDangling: 'imports:dangling',
  /** symbol or file -> symbol, found through scope, imports or the enclosing class. */
  calls: 'calls',
  /** symbol or file -> symbol matched by name only, among what the caller can see. A guess. */
  callsByName: 'calls:name',
  /** symbol or file -> `package#name` outside the workspace. */
  callsExternal: 'calls:external',
  /** symbol or file -> the called name, when nothing could be found for it. */
  callsUnresolved: 'calls:unresolved',
} as const;

export type EdgeKind = (typeof EDGE)[keyof typeof EDGE];

/** Edge kinds that link a file to what it imports, in the order a reader cares about them. */
export const IMPORT_EDGE_KINDS: readonly EdgeKind[] = [
  EDGE.imports,
  EDGE.importsType,
  EDGE.reexports,
  EDGE.importsAsset,
];

/** Edge kinds that link a caller to a symbol in the workspace. */
export const CALL_EDGE_KINDS: readonly EdgeKind[] = [EDGE.calls, EDGE.callsByName];
