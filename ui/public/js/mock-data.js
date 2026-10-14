/**
 * ANVESA UI — High-fidelity dataset for offline demo & fallback previews.
 * Accurately models Anvesa's retrieval facts, RRF scores, AST graph nodes, and repo maps.
 */

window.ANVESA_MOCK = {
  status: {
    root: 'e:/AI projects/sutras/anvesa',
    indexed: true,
    index: {
      files: 148,
      quarantinedFiles: 0,
      symbols: 2418,
      calls: 4102,
      imports: 1890,
      edges: 5992,
      byLanguage: [
        { language: 'typescript', files: 104, symbols: 1840 },
        { language: 'rust', files: 22, symbols: 320 },
        { language: 'python', files: 12, symbols: 180 },
        { language: 'json', files: 10, symbols: 78 },
      ],
    },
    embedder: {
      id: 'bge-base-en-v1.5',
      dimensions: 768,
      maxTokens: 512,
      pooling: 'mean',
      provider: 'CPU (DirectML available)',
    },
    channels: [
      { name: 'symbols', cards: 2418, sources: 148, quarantined: 0, enabled: true },
      { name: 'docs', cards: 620, sources: 84, quarantined: 0, enabled: true },
      { name: 'comments', cards: 412, sources: 62, quarantined: 0, enabled: true },
    ],
    fragments: {
      enabled: true,
      tier: 'path',
      databases: [
        { name: 'core.db', cards: 820, size: '4.2 MB' },
        { name: 'retriever.db', cards: 980, size: '7.8 MB' },
        { name: 'syntax.db', cards: 618, size: '5.1 MB' },
      ],
    },
  },

  searchResults: [
    {
      id: 'sym:retriever:search',
      name: 'search',
      container: 'Retriever',
      kind: 'method',
      path: 'retriever/src/retriever.ts',
      lines: '142-188',
      score: 0.942,
      bestScore: 0.912,
      lanes: ['dense:symbols', 'dense:docs', 'structural:wql'],
      docSummary:
        'Search the project by meaning (dense channels) and by structure (WQL), fused by reciprocal rank fusion (RRF).',
      code: `export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResultPage> {
  const startedAt = performance.now();
  const { wql, weights, scope, limit = DEFAULT_SEARCH_LIMIT } = options;
  
  // 1. Structural query pass via AST matching
  const structuralHits = wql ? await this.structuralEngine.query(wql, { scope }) : [];
  
  // 2. Dense semantic retrieval pass across registered channels
  const denseHits = await retrieveDense(this.vectorStore, this.embedder, query, { weights, scope });
  
  // 3. Reciprocal Rank Fusion (RRF)
  return fuse(denseHits, structuralHits, { k: DEFAULT_RRF_K, limit });
}`,
      security: { screened: true, quarantined: false, untrustedFenced: true },
    },
    {
      id: 'sym:retriever:fuse',
      name: 'fuse',
      container: 'fuse.ts',
      kind: 'function',
      path: 'retriever/src/fuse.ts',
      lines: '34-68',
      score: 0.895,
      bestScore: 0.874,
      lanes: ['dense:symbols'],
      docSummary: 'Compute reciprocal rank fusion scores over heterogeneous retrieval lanes.',
      code: `export function fuse(
  lanes: ReadonlyArray<LaneResults>,
  options: FuseOptions = {}
): FusedResultPage {
  const k = options.k ?? DEFAULT_RRF_K;
  const scores = new Map<string, FusedScore>();
  
  for (const lane of lanes) {
    const weight = options.weights?.[lane.name] ?? 1.0;
    lane.hits.forEach((hit, rank) => {
      const contribution = weight / (k + rank + 1);
      const existing = scores.get(hit.id) ?? { rrf: 0, bestSim: 0, lanes: [] };
      existing.rrf += contribution;
      existing.bestSim = Math.max(existing.bestSim, hit.similarity ?? 0);
      existing.lanes.push(lane.name);
      scores.set(hit.id, existing);
    });
  }
  return rankResults(scores, options.limit);
}`,
      security: { screened: true, quarantined: false, untrustedFenced: true },
    },
    {
      id: 'sym:structural:parseWql',
      name: 'parseWql',
      container: 'StructuralEngine',
      kind: 'function',
      path: 'structural/src/wql.ts',
      lines: '52-94',
      score: 0.841,
      bestScore: 0.825,
      lanes: ['dense:symbols', 'structural:wql'],
      docSummary: 'Parses structural XPath-like query syntax into an AST predicate tree.',
      code: `export function parseWql(wqlString: string): WqlQuery {
  const lexer = new WqlLexer(wqlString);
  const tokens = lexer.tokenize();
  return parseTokensToAst(tokens);
}`,
      security: { screened: true, quarantined: false, untrustedFenced: true },
    },
    {
      id: 'sym:cli:openSession',
      name: 'openSession',
      container: 'commands.ts',
      kind: 'function',
      path: 'cli/src/commands.ts',
      lines: '78-124',
      score: 0.785,
      bestScore: 0.761,
      lanes: ['dense:symbols'],
      docSummary:
        'Open project configuration, model cache, and initialize active retriever session.',
      code: `export async function openSession(
  ctx: Context,
  options: { embed: boolean; monolith?: boolean }
): Promise<Session> {
  const projectRoot = root(ctx);
  const config = await loadProjectConfig(projectRoot);
  const retriever = await Retriever.open({ root: projectRoot, config });
  return { retriever, close: () => retriever.close() };
}`,
      security: { screened: true, quarantined: false, untrustedFenced: true },
    },
  ],

  graphData: {
    'Retriever.search': {
      symbol: {
        id: 'sym:Retriever.search',
        name: 'Retriever.search',
        kind: 'method',
        path: 'retriever/src/retriever.ts:142',
        doc: 'Main entry point for fused semantic + structural retrieval.',
      },
      callers: [
        {
          id: 'cli:searchCommand',
          name: 'searchCommand',
          kind: 'function',
          path: 'cli/src/commands.ts:643',
        },
        { id: 'mcp:searchTool', name: 'searchTool', kind: 'tool', path: 'cli/src/mcp.ts:61' },
        {
          id: 'test:retrieverIntegration',
          name: 'testRetriever',
          kind: 'test',
          path: 'retriever/src/retriever.test.ts:45',
        },
      ],
      callees: [
        { id: 'sym:fuse', name: 'fuse', kind: 'function', path: 'retriever/src/fuse.ts:34' },
        {
          id: 'sym:retrieveDense',
          name: 'retrieveDense',
          kind: 'function',
          path: 'dense/src/retrieve.ts:28',
        },
        {
          id: 'sym:StructuralEngine.query',
          name: 'StructuralEngine.query',
          kind: 'method',
          path: 'structural/src/engine.ts:89',
        },
        {
          id: 'sym:splitConjunction',
          name: 'splitConjunction',
          kind: 'function',
          path: 'retriever/src/conjunction.ts:18',
        },
      ],
      neighbors: [
        {
          id: 'sym:Retriever.status',
          name: 'Retriever.status',
          kind: 'method',
          path: 'retriever/src/retriever.ts:205',
        },
        {
          id: 'sym:Retriever.repoMap',
          name: 'Retriever.repoMap',
          kind: 'method',
          path: 'retriever/src/retriever.ts:312',
        },
      ],
    },
    openSession: {
      symbol: {
        id: 'sym:openSession',
        name: 'openSession',
        kind: 'function',
        path: 'cli/src/commands.ts:78',
        doc: 'Opens project index, loads model cache and instantiates Retriever.',
      },
      callers: [
        {
          id: 'cli:search',
          name: 'COMMANDS.search',
          kind: 'handler',
          path: 'cli/src/commands.ts:643',
        },
        {
          id: 'cli:callers',
          name: 'COMMANDS.callers',
          kind: 'handler',
          path: 'cli/src/commands.ts:697',
        },
        { id: 'cli:map', name: 'COMMANDS.map', kind: 'handler', path: 'cli/src/commands.ts:747' },
        { id: 'mcp:serveMcp', name: 'serveMcp', kind: 'function', path: 'cli/src/mcp.ts:32' },
      ],
      callees: [
        {
          id: 'sym:loadProjectConfig',
          name: 'loadProjectConfig',
          kind: 'function',
          path: 'retriever/src/config.ts:42',
        },
        {
          id: 'sym:openProjectEmbedder',
          name: 'openProjectEmbedder',
          kind: 'function',
          path: 'retriever/src/models.ts:95',
        },
        {
          id: 'sym:Retriever.open',
          name: 'Retriever.open',
          kind: 'method',
          path: 'retriever/src/retriever.ts:97',
        },
      ],
      neighbors: [],
    },
  },

  repomap: {
    files: [
      {
        path: 'retriever/src/retriever.ts',
        pageRank: 0.182,
        symbols: [
          { name: 'Retriever', kind: 'class', callers: 42, pageRank: 0.14 },
          { name: 'Retriever.search', kind: 'method', callers: 18, pageRank: 0.08 },
          { name: 'Retriever.callers', kind: 'method', callers: 12, pageRank: 0.06 },
        ],
      },
      {
        path: 'cli/src/commands.ts',
        pageRank: 0.145,
        symbols: [
          { name: 'COMMANDS', kind: 'const', callers: 8, pageRank: 0.09 },
          { name: 'openSession', kind: 'function', callers: 14, pageRank: 0.07 },
        ],
      },
      {
        path: 'structural/src/wql.ts',
        pageRank: 0.112,
        symbols: [
          { name: 'parseWql', kind: 'function', callers: 16, pageRank: 0.06 },
          { name: 'StructuralEngine', kind: 'class', callers: 22, pageRank: 0.08 },
        ],
      },
      {
        path: 'indexer/src/workspace.ts',
        pageRank: 0.095,
        symbols: [
          { name: 'Workspace', kind: 'class', callers: 15, pageRank: 0.06 },
          { name: 'generateRepoMap', kind: 'function', callers: 7, pageRank: 0.04 },
        ],
      },
    ],
  },

  routes: [
    {
      method: 'POST',
      path: '/api/search',
      handler: 'handleSearch',
      file: 'ui/src/server.ts:132',
      framework: 'Built-in HTTP',
    },
    {
      method: 'GET',
      path: '/api/status',
      handler: 'handleStatus',
      file: 'ui/src/server.ts:114',
      framework: 'Built-in HTTP',
    },
    {
      method: 'GET',
      path: '/api/graph/callers',
      handler: 'handleCallers',
      file: 'ui/src/server.ts:178',
      framework: 'Built-in HTTP',
    },
    {
      method: 'GET',
      path: '/api/repomap',
      handler: 'handleRepoMap',
      file: 'ui/src/server.ts:224',
      framework: 'Built-in HTTP',
    },
    {
      method: 'GET',
      path: '/api/routes',
      handler: 'handleRoutes',
      file: 'ui/src/server.ts:238',
      framework: 'Built-in HTTP',
    },
  ],

  grammars: [
    { language: 'typescript', engine: 'Native Addon', version: '0.23.2', status: 'Ready' },
    { language: 'javascript', engine: 'Native Addon', version: '0.25.0', status: 'Ready' },
    { language: 'tsx', engine: 'Native Addon', version: '0.23.2', status: 'Ready' },
    { language: 'python', engine: 'Native Addon', version: '0.21.0', status: 'Ready' },
    { language: 'rust', engine: 'Native Addon', version: '0.21.2', status: 'Ready' },
    { language: 'go', engine: 'Native Addon', version: '0.25.0', status: 'Ready' },
    { language: 'c-sharp', engine: 'WASM Grammar', version: '0.23.5', status: 'Ready' },
    { language: 'java', engine: 'WASM Grammar', version: '0.21.0', status: 'Ready' },
    { language: 'ruby', engine: 'WASM Grammar', version: '0.20.0', status: 'Ready' },
  ],

  redteamPolicies: [
    {
      name: 'Prompt Injection Screen',
      status: 'Active (Strict)',
      desc: 'Prevents adversarial text injection from altering agent control flow before indexing.',
    },
    {
      name: 'Secret & Credential Mask',
      status: 'Active',
      desc: 'Auto-detects API tokens, RSA keys, and secrets to fence untrusted values.',
    },
    {
      name: 'Untrusted Card Fencing',
      status: 'Active (Mandatory)',
      desc: 'Guarantees any retrieved text passed to an AI model is fenced within safe delimiters.',
    },
    {
      name: 'Module Checksum Verification',
      status: 'Enforced',
      desc: 'Requires SHA-256 validation for any custom dense channel or syntax module.',
    },
  ],
};
