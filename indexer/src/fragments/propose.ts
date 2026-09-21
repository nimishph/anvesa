import { communities, type Edge } from './louvain.ts';
import type { FragmentManifest, FragmentSpec } from './manifest.ts';

/** What a proposal is made from. Order does not matter: inputs are sorted before anything is decided. */
export interface ProposeInput {
  /** Every indexed file, `/`-separated and relative to the workspace root. */
  readonly files: readonly string[];
  /** Package folders that discovery found (`''`, the workspace itself, is ignored). */
  readonly packageRoots: readonly string[];
}

export interface ClusterInput extends ProposeInput {
  /** File-to-file import links, `from` importing `to`. */
  readonly imports: readonly (readonly [from: string, to: string])[];
  /** Larger gives smaller clusters. 1 by default. */
  readonly resolution?: number;
  /** Human names for fragments, by id. Words only: they decide nothing. */
  readonly labels?: Readonly<Record<string, string>>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A fragment id from a name: lowercase, plain characters, never empty. */
export function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return cleaned === '' ? 'fragment' : cleaned;
}

/** Ids that never clash: the first taker keeps the plain name, later ones get `-2`, `-3`. */
class IdPool {
  readonly #taken = new Set<string>(['root']);

  take(wanted: string): string {
    let id = slug(wanted);
    for (let n = 2; this.#taken.has(id); n += 1) id = `${slug(wanted)}-${n}`;
    this.#taken.add(id);
    return id;
  }
}

const directoryOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf('/')));

function withRoot(fragments: Record<string, FragmentSpec>): void {
  fragments.root = { label: 'Files outside every other fragment' };
}

/**
 * The free tier: fragments follow how the code is already laid out. Every package folder is one
 * fragment; files outside a package group by their top folder; files at the top level are the
 * fallback. Nothing is inferred, so it is the same on every machine and cheap to review, and it is
 * where a small repository should stop.
 */
export function proposePathPrior(input: ProposeInput): FragmentManifest {
  const ids = new IdPool();
  const fragments: Record<string, FragmentSpec> = {};
  withRoot(fragments);

  // A package with no indexed file (outside the scope of this index, or all ignored) needs no shard.
  const candidates = [...new Set(input.packageRoots.filter((root) => root !== ''))].sort(compare);
  const roots = candidates.filter((root) =>
    input.files.some((file) => file.startsWith(`${root}/`)),
  );
  for (const root of roots) {
    const name = root.slice(root.lastIndexOf('/') + 1);
    // A folder name shared by two packages is told apart by the whole path.
    const id = ids.take(
      roots.filter((other) => other.endsWith(`/${name}`) || other === name).length > 1
        ? root
        : name,
    );
    fragments[id] = { label: root, roots: [root] };
  }

  const inPackage = (file: string) => roots.some((root) => file.startsWith(`${root}/`));
  const top = new Set<string>();
  for (const file of [...input.files].sort(compare)) {
    if (inPackage(file)) continue;
    const slash = file.indexOf('/');
    if (slash !== -1) top.add(file.slice(0, slash));
  }
  for (const folder of [...top].sort(compare)) {
    // A top folder that is itself a package root, or holds one, is already covered.
    if (roots.some((root) => root === folder || root.startsWith(`${folder}/`))) continue;
    fragments[ids.take(folder)] = { label: folder, roots: [folder] };
  }
  return {
    manifestVersion: 1,
    algorithm: { id: 'path-prior', version: 1 },
    fallback: 'root',
    fragments,
  };
}

/** The directory prefix shared by most of a group's files, for a name. */
function dominantDirectory(files: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = directoryOf(file)
      .split('/')
      .filter((part) => part !== '');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('/');
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  let best = '';
  let bestDepth = 0;
  let bestCount = 0;
  // The deepest prefix that still covers at least half the group. Among equally deep ones, the one
  // covering more, then the smaller name, so the choice never depends on iteration order.
  for (const [prefix, count] of [...counts].sort(([a], [b]) => compare(a, b))) {
    if (count * 2 < files.length) continue;
    const depth = prefix.split('/').length;
    if (depth > bestDepth || (depth === bestDepth && count > bestCount)) {
      best = prefix;
      bestDepth = depth;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The second tier: fragments follow how the code depends on itself. Files that import each other a
 * lot end up together whatever folder they are in (Louvain communities over the import graph,
 * decided in a fixed order so any machine finds the same ones). Each cluster is named by the folder
 * most of it lives in. A file with no imports either way joins the cluster its folder mostly belongs
 * to, and one whose folder belongs to none stays in the fallback.
 *
 * Unlike the free tier this looks at the code, so it is run by a maintainer and its result
 * committed: the manifest, not the run, is what every machine follows.
 */
export function proposeClustered(input: ClusterInput): FragmentManifest {
  const files = [...new Set(input.files)].sort(compare);
  const index = new Map(files.map((file, position) => [file, position]));
  const weights = new Map<string, Edge>();
  for (const [from, to] of input.imports) {
    const a = index.get(from);
    const b = index.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = `${low}:${high}`;
    weights.set(key, { a: low, b: high, weight: (weights.get(key)?.weight ?? 0) + 1 });
  }
  const linked = new Set<number>();
  for (const { a, b } of weights.values()) {
    linked.add(a);
    linked.add(b);
  }
  const edges = [...weights.values()].sort((x, y) => x.a - y.a || x.b - y.b);
  const community = communities(files.length, edges, input.resolution ?? 1);

  const groups = new Map<number, string[]>();
  files.forEach((file, position) => {
    if (!linked.has(position)) return;
    const c = community[position] as number;
    groups.set(c, [...(groups.get(c) ?? []), file]);
  });

  const ids = new IdPool();
  const fragments: Record<string, FragmentSpec> = {};
  withRoot(fragments);
  const clusterOf = new Map<string, string>();
  for (const [, members] of [...groups].sort((x, y) =>
    compare(x[1][0] as string, y[1][0] as string),
  )) {
    const folder = dominantDirectory(members);
    const id = ids.take(folder === '' ? 'top' : folder);
    fragments[id] = {
      ...(input.labels?.[id]
        ? { label: input.labels[id] }
        : { label: folder === '' ? 'top level' : folder }),
      files: members,
    };
    for (const member of members) clusterOf.set(member, id);
  }

  // Files no import touches go where their folder's other files went, if that is clear.
  const byFolder = new Map<string, Map<string, number>>();
  for (const [file, id] of clusterOf) {
    const folder = directoryOf(file);
    const tally = byFolder.get(folder) ?? new Map<string, number>();
    tally.set(id, (tally.get(id) ?? 0) + 1);
    byFolder.set(folder, tally);
  }
  for (const file of files) {
    if (clusterOf.has(file)) continue;
    const tally = byFolder.get(directoryOf(file));
    if (!tally) continue;
    const [winner] = [...tally].sort((x, y) => y[1] - x[1] || compare(x[0], y[0]));
    if (winner) (fragments[winner[0]] as { files: string[] }).files.push(file);
  }
  return {
    manifestVersion: 1,
    algorithm: { id: 'import-clusters', version: 1 },
    fallback: 'root',
    fragments,
  };
}
