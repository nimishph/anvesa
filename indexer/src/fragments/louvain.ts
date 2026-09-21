/**
 * Communities in an undirected weighted graph, by the Louvain method: nodes move to the neighbouring
 * community that raises modularity most, until none moves, then communities become nodes and the
 * process repeats. Every choice is by a fixed order (node index, then community index), so the same
 * graph always gives the same communities: what a manifest committed on one machine says is what
 * another machine would have found.
 */
export interface Edge {
  readonly a: number;
  readonly b: number;
  readonly weight: number;
}

/** Below this, a move does not count as an improvement: it stops rounding noise from cycling. */
const MIN_GAIN = 1e-12;

interface Graph {
  readonly size: number;
  /** Neighbours of each node with the weight of the link. A self-loop is listed once. */
  readonly adjacency: readonly (readonly (readonly [number, number])[])[];
  /** Sum of a node's link weights, a self-loop counted twice. */
  readonly degree: Float64Array;
  /** Twice the total weight. */
  readonly total: number;
}

function buildGraph(size: number, edges: readonly Edge[]): Graph {
  const links = Array.from({ length: size }, () => new Map<number, number>());
  for (const { a, b, weight } of edges) {
    links[a]?.set(b, (links[a]?.get(b) ?? 0) + weight);
    if (a !== b) links[b]?.set(a, (links[b]?.get(a) ?? 0) + weight);
  }
  const degree = new Float64Array(size);
  const adjacency = links.map((map, node) => {
    const row = [...map].sort((x, y) => x[0] - y[0]);
    for (const [other, weight] of row)
      degree[node] = (degree[node] as number) + (other === node ? 2 * weight : weight);
    return row;
  });
  return { size, adjacency, degree, total: degree.reduce((sum, d) => sum + d, 0) };
}

/** One level: move nodes between communities until no move improves modularity. */
function localMoves(graph: Graph, resolution: number): Int32Array {
  const community = Int32Array.from({ length: graph.size }, (_, index) => index);
  const tot = Float64Array.from(graph.degree);
  let moved = true;
  while (moved) {
    moved = false;
    for (let node = 0; node < graph.size; node += 1) {
      const own = community[node] as number;
      const k = graph.degree[node] as number;
      const toCommunity = new Map<number, number>();
      for (const [other, weight] of graph.adjacency[node] as readonly (readonly [
        number,
        number,
      ])[]) {
        if (other === node) continue;
        const c = community[other] as number;
        toCommunity.set(c, (toCommunity.get(c) ?? 0) + weight);
      }
      // Take the node out of its community, then find where it fits best.
      tot[own] = (tot[own] as number) - k;
      const gain = (c: number): number =>
        (toCommunity.get(c) ?? 0) - (resolution * (tot[c] as number) * k) / graph.total;
      let best = own;
      let bestGain = gain(own);
      for (const c of [...toCommunity.keys()].sort((x, y) => x - y)) {
        const candidate = gain(c);
        if (candidate > bestGain + MIN_GAIN) {
          best = c;
          bestGain = candidate;
        }
      }
      tot[best] = (tot[best] as number) + k;
      if (best !== own) {
        community[node] = best;
        moved = true;
      }
    }
  }
  return community;
}

/**
 * The community of each of `size` nodes, numbered from 0 in order of each community's lowest node.
 * `resolution` above 1 gives smaller communities, below 1 larger ones.
 */
export function communities(size: number, edges: readonly Edge[], resolution = 1): Int32Array {
  let assignment = Int32Array.from({ length: size }, (_, index) => index);
  let graph = buildGraph(size, edges);
  if (graph.total === 0) return assignment;

  for (;;) {
    const level = localMoves(graph, resolution);
    const distinct = [...new Set(level)].sort((x, y) => x - y);
    if (distinct.length === graph.size) break;
    const index = new Map(distinct.map((c, position) => [c, position]));
    assignment = assignment.map((super_) => index.get(level[super_] as number) as number);
    const merged = new Map<string, Edge>();
    graph.adjacency.forEach((row, node) => {
      for (const [other, weight] of row) {
        if (other < node) continue;
        const a = index.get(level[node] as number) as number;
        const b = index.get(level[other] as number) as number;
        const key = a <= b ? `${a}:${b}` : `${b}:${a}`;
        const previous = merged.get(key);
        merged.set(key, {
          a: Math.min(a, b),
          b: Math.max(a, b),
          weight: (previous?.weight ?? 0) + weight,
        });
      }
    });
    graph = buildGraph(distinct.length, [...merged.values()]);
  }

  // Number communities by their lowest node so the numbering does not depend on how they formed.
  const first = new Map<number, number>();
  assignment.forEach((c, node) => {
    if (!first.has(c)) first.set(c, node);
  });
  const order = [...first].sort((x, y) => x[1] - y[1]).map(([c]) => c);
  const renumber = new Map(order.map((c, position) => [c, position]));
  return assignment.map((c) => renumber.get(c) as number);
}
