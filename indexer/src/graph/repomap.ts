import type { IndexStore } from '../store/index.ts';
import { CALL_EDGE_KINDS, IMPORT_EDGE_KINDS } from './edges.ts';

export interface RepoMapOptions {
  /** Maximum directory depth to display (1-based, default: unlimited). */
  readonly depth?: number;
  /** Approximate token budget (characters / 4). */
  readonly budget?: number;
  /** Maximum symbols to show per file (default: 5). */
  readonly maxSymbolsPerFile?: number;
  /** Filter to files within this directory prefix. */
  readonly scope?: string;
}

export interface RepoMapSymbol {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly signature?: string | undefined;
  readonly callers: number;
  readonly score: number;
}

export interface RepoMapFile {
  readonly path: string;
  readonly score: number;
  readonly importers: number;
  readonly symbols: readonly RepoMapSymbol[];
}

export interface RepoMapTreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly score: number;
  readonly children?: readonly RepoMapTreeNode[] | undefined;
  readonly symbols?: readonly RepoMapSymbol[] | undefined;
  readonly importers?: number | undefined;
}

export interface RepoMapResult {
  readonly totalFiles: number;
  readonly totalSymbols: number;
  readonly files: readonly RepoMapFile[];
  readonly tree: RepoMapTreeNode;
}

/**
 * Computes PageRank over the code graph (files connected by imports, symbols connected by calls)
 * to score architectural centrality.
 */
export function computeGraphPageRank(
  nodes: readonly string[],
  edges: readonly { from: string; to: string }[],
  iterations = 20,
  damping = 0.85,
): Map<string, number> {
  const nodeSet = new Set(nodes);
  for (const edge of edges) {
    nodeSet.add(edge.from);
    nodeSet.add(edge.to);
  }

  const allNodes = [...nodeSet];
  const N = allNodes.length;
  if (N === 0) return new Map();

  const outNeighbors = new Map<string, string[]>();
  const inNeighbors = new Map<string, string[]>();
  for (const n of allNodes) {
    outNeighbors.set(n, []);
    inNeighbors.set(n, []);
  }

  for (const edge of edges) {
    outNeighbors.get(edge.from)?.push(edge.to);
    inNeighbors.get(edge.to)?.push(edge.from);
  }

  let ranks = new Map<string, number>();
  const initial = 1 / N;
  for (const n of allNodes) {
    ranks.set(n, initial);
  }

  for (let it = 0; it < iterations; it += 1) {
    const nextRanks = new Map<string, number>();
    const base = (1 - damping) / N;

    for (const n of allNodes) {
      let incomingSum = 0;
      const ins = inNeighbors.get(n) ?? [];
      for (const src of ins) {
        const outDeg = outNeighbors.get(src)?.length ?? 1;
        incomingSum += (ranks.get(src) ?? initial) / (outDeg || 1);
      }
      nextRanks.set(n, base + damping * incomingSum);
    }
    ranks = nextRanks;
  }

  // Normalize scores so max score is 1.0 (or 0 if empty)
  let maxScore = 0;
  for (const score of ranks.values()) {
    if (score > maxScore) maxScore = score;
  }
  if (maxScore > 0) {
    for (const [k, score] of ranks.entries()) {
      ranks.set(k, score / maxScore);
    }
  }

  return ranks;
}

/**
 * Builds a graph-weighted repository map identifying the most central files and symbols.
 */
export async function generateRepoMap(
  store: IndexStore,
  options: RepoMapOptions = {},
): Promise<RepoMapResult> {
  const maxSymbols = options.maxSymbolsPerFile ?? 5;
  const scope = options.scope ? options.scope.replace(/\/$/, '') : undefined;

  // 1. Gather all files and edges
  const filesPage = await store.files({ limit: 100_000 });
  const indexedFiles = filesPage.items.filter(
    (f) => f.status === 'indexed' && (!scope || f.path === scope || f.path.startsWith(`${scope}/`)),
  );

  const edgesPage = await store.findEdges({ limit: 200_000 });
  const allEdges = edgesPage.items;

  // 2. Count incoming callers per symbol and incoming imports per file
  const callersCount = new Map<string, number>();
  const importersCount = new Map<string, number>();

  const graphEdges: { from: string; to: string }[] = [];
  for (const edge of allEdges) {
    if (CALL_EDGE_KINDS.includes(edge.kind as (typeof CALL_EDGE_KINDS)[number])) {
      callersCount.set(edge.to, (callersCount.get(edge.to) ?? 0) + 1);
      graphEdges.push({ from: edge.from, to: edge.to });
    } else if (IMPORT_EDGE_KINDS.includes(edge.kind as (typeof IMPORT_EDGE_KINDS)[number])) {
      importersCount.set(edge.to, (importersCount.get(edge.to) ?? 0) + 1);
      graphEdges.push({ from: edge.from, to: edge.to });
    }
  }

  // 3. Compute PageRank
  const nodeIds = indexedFiles.map((f) => f.path);
  const ranks = computeGraphPageRank(nodeIds, graphEdges);

  // 4. Fetch symbols for each file and rank them
  const resultFiles: RepoMapFile[] = [];
  let totalSymbols = 0;

  for (const file of indexedFiles) {
    const fileSymbolsPage = await store.findSymbols({ path: file.path, limit: 1000 });
    const symbols = fileSymbolsPage.items;
    totalSymbols += symbols.length;

    const scoredSymbols: RepoMapSymbol[] = symbols.map((s) => {
      const callers = callersCount.get(s.id) ?? callersCount.get(s.name) ?? 0;
      const score = ranks.get(s.id) ?? ranks.get(s.name) ?? callers * 0.1;
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        line: s.startLine,
        signature: s.signature,
        callers,
        score,
      };
    });

    // Sort symbols by (score desc, callers desc, line asc)
    scoredSymbols.sort((a, b) => b.score - a.score || b.callers - a.callers || a.line - b.line);

    const fileImporters = importersCount.get(file.path) ?? 0;
    const fileScore =
      ranks.get(file.path) ??
      fileImporters * 0.2 + scoredSymbols.reduce((sum, s) => sum + s.score, 0);

    resultFiles.push({
      path: file.path,
      score: fileScore,
      importers: fileImporters,
      symbols: scoredSymbols.slice(0, maxSymbols),
    });
  }

  // Sort files by (score desc, importers desc, path asc)
  resultFiles.sort(
    (a, b) => b.score - a.score || b.importers - a.importers || a.path.localeCompare(b.path),
  );

  // 5. Build directory tree
  const tree = buildTree(resultFiles, options.depth);

  return {
    totalFiles: indexedFiles.length,
    totalSymbols,
    files: resultFiles,
    tree,
  };
}

interface MutableDirNode {
  name: string;
  path: string;
  isDir: boolean;
  score: number;
  importers?: number | undefined;
  children: Map<string, MutableDirNode>;
  symbols?: readonly RepoMapSymbol[] | undefined;
}

function buildTree(files: readonly RepoMapFile[], maxDepth?: number): RepoMapTreeNode {
  const root: MutableDirNode = {
    name: '.',
    path: '',
    isDir: true,
    score: 1.0,
    children: new Map(),
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as string;
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      if (maxDepth !== undefined && i + 1 > maxDepth && !isFile) {
        break;
      }

      let child = current.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          isDir: !isFile,
          score: isFile ? file.score : 0,
          children: new Map(),
          ...(isFile && file.importers !== undefined ? { importers: file.importers } : {}),
          ...(isFile && file.symbols !== undefined ? { symbols: file.symbols } : {}),
        };
        current.children.set(part, child);
      }
      if (!isFile) {
        child.score = Math.max(child.score, file.score);
      }
      current = child;
    }
  }

  return toImmutableTreeNode(root);
}

function toImmutableTreeNode(node: MutableDirNode): RepoMapTreeNode {
  const children = [...node.children.values()].map(toImmutableTreeNode).sort((a, b) => {
    // Directories first, then sorted by score descending
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return b.score - a.score || a.name.localeCompare(b.name);
  });

  return {
    name: node.name,
    path: node.path,
    isDir: node.isDir,
    score: node.score,
    ...(node.importers !== undefined ? { importers: node.importers } : {}),
    ...(node.symbols !== undefined ? { symbols: node.symbols } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}
