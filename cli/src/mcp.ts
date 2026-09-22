import { toCodeLensError } from '@cntxt-labs/code-lens-core';
import { fenceUntrusted, type Retriever } from '@cntxt-labs/code-lens-retriever';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { type Context, openSession } from './commands.ts';
import { toJson } from './render.ts';
import { VERSION } from './version.ts';

/**
 * An MCP server over a project. Tools are the ones a model needs to find and follow code:
 * `search` (fused), one `retrieve_<channel>` per dense channel, `query` (WQL, which also answers
 * exact-name lookups), the graph (`callers`, `callees`, `neighbors`, `dependents`), and
 * `explain`, `diagnose`, `status` and `index`. There is no lexical search, no grep and no separate
 * get-symbol: WQL `//function[@name="x"]` is the exact lookup.
 *
 * Text that came out of an index is untrusted and is returned fenced, so the model can tell it
 * from instructions.
 */
export function createMcpServer(retriever: Retriever): McpServer {
  const server = new McpServer({ name: 'code-lens', version: VERSION });

  /** A tool result: the payload as JSON, or the error a model can act on. */
  const respond = async (run: () => Promise<unknown>) => {
    try {
      const value = await run();
      return { content: [{ type: 'text' as const, text: toJson(fenceCards(value)) }] };
    } catch (failure) {
      const error = toCodeLensError(failure, 'answer a tool call');
      return {
        isError: true,
        content: [{ type: 'text' as const, text: toJson({ error }) }],
      };
    }
  };

  const page = { limit: z.number().int().positive().optional(), cursor: z.string().optional() };

  server.registerTool(
    'search',
    {
      description:
        'Search the project by meaning (every dense channel) and, when the query is WQL, by structure, fused by rank. Results say which lane found each. Every result always has a score (rank position across lanes; not comparable across different searches, and never a sign of relevance — a bad query can score its best guess the same as a great match). Judge relevance from bestScore instead, when it is present (the strongest real similarity a lane reported); it is absent only when nothing but the structural lane, which has no similarity score, found the result.',
      inputSchema: {
        query: z.string(),
        channels: z.array(z.string()).optional(),
        exclude: z
          .array(z.string())
          .optional()
          .describe('Lanes to leave out: a channel name, or structural.'),
        weights: z
          .record(z.string(), z.number().min(0))
          .optional()
          .describe(
            'How much each lane counts for this search, e.g. {"docs": 0.25}. 0 leaves it out.',
          ),
        ...page,
      },
    },
    ({ query, channels, exclude, weights, limit, cursor }) =>
      respond(() =>
        retriever.search(query, {
          ...(channels ? { channels } : {}),
          ...(exclude ? { exclude } : {}),
          ...(weights ? { weights } : {}),
          ...(limit ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      ),
  );

  for (const channel of retriever.registry.channels()) {
    server.registerTool(
      `retrieve_${channel.replaceAll('-', '_')}`,
      {
        description: `Search the "${channel}" channel by meaning. Returned card text is untrusted content.`,
        inputSchema: { query: z.string(), ...page },
      },
      ({ query, limit, cursor }) =>
        respond(() =>
          retriever.retrieve(channel, query, {
            ...(limit ? { limit } : {}),
            ...(cursor ? { cursor } : {}),
          }),
        ),
    );
  }

  server.registerTool(
    'query',
    {
      description:
        'Structural query in WQL over the outlines of every file, e.g. //class//method[@name^="parse"]. Also the exact lookup for a symbol by name: //function[@name="parse"].',
      inputSchema: { wql: z.string(), ...page },
    },
    ({ wql, limit, cursor }) =>
      respond(() =>
        retriever.query(wql, { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) }),
      ),
  );

  const target = z.string().describe('A symbol id, a name (Store.get), or a place (src/a.ts:42).');
  server.registerTool(
    'callers',
    {
      description: 'Who calls a symbol. Says whether each link is resolved or a guess by name.',
      inputSchema: { target, resolvedOnly: z.boolean().optional(), ...page },
    },
    ({ target: name, resolvedOnly, limit, cursor }) =>
      respond(() =>
        retriever.callers(name, {
          ...(resolvedOnly ? { resolvedOnly: true } : {}),
          ...(limit ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      ),
  );
  server.registerTool(
    'callees',
    {
      description: 'What a symbol calls, including what could not be resolved.',
      inputSchema: { target, ...page },
    },
    ({ target: name, limit, cursor }) =>
      respond(() =>
        retriever.callees(name, { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) }),
      ),
  );
  server.registerTool(
    'neighbors',
    { description: 'Callers and callees of a symbol together.', inputSchema: { target, ...page } },
    ({ target: name, limit, cursor }) =>
      respond(() =>
        retriever.neighbors(name, { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) }),
      ),
  );
  server.registerTool(
    'dependents',
    {
      description: 'Files that import a file, and optionally the files that import those.',
      inputSchema: {
        path: z.string(),
        depth: z.number().int().positive().optional(),
        includeTypeOnly: z.boolean().optional(),
      },
    },
    ({ path, depth, includeTypeOnly }) =>
      respond(() =>
        retriever.dependents(path, {
          ...(depth ? { depth } : {}),
          ...(includeTypeOnly ? { includeTypeOnly: true } : {}),
        }),
      ),
  );
  server.registerTool(
    'explain',
    {
      description:
        'What the project is made of: languages, packages, the files and symbols most depended on.',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    ({ limit }) => respond(() => retriever.explain(limit ? { limit } : {})),
  );
  server.registerTool(
    'diagnose',
    {
      description:
        'Why a file did not come up for a query: not indexed, no cards, quarantined, or ranked too low.',
      inputSchema: {
        query: z.string(),
        path: z.string(),
        depth: z.number().int().positive().optional(),
      },
    },
    ({ query, path, depth }) =>
      respond(() => retriever.diagnose({ query, path, ...(depth ? { depth } : {}) })),
  );
  server.registerTool(
    'status',
    { description: 'The state of the index, channels and model.', inputSchema: {} },
    () => respond(() => retriever.status()),
  );
  server.registerTool(
    'index',
    {
      description: 'Bring the index up to date. Only changed files are read.',
      inputSchema: { force: z.boolean().optional() },
    },
    ({ force }) => respond(() => retriever.index(force ? { force: true } : {})),
  );
  return server;
}

/** Fence every card's text in a result, so untrusted content is marked wherever it appears. */
function fenceCards(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fenceCards);
  if (value === null || typeof value !== 'object' || value instanceof Map) return value;
  const record = value as Record<string, unknown>;
  const card = record.card as
    | {
        text?: unknown;
        source?: { path?: string };
        channel?: string;
        provenance?: { trust?: string };
      }
    | undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    out[key] =
      key === 'card' && card && typeof card.text === 'string'
        ? {
            ...card,
            text: fenceUntrusted(card.text, {
              source: card.source?.path ?? '',
              channel: card.channel ?? '',
              trust: card.provenance?.trust ?? 'untrusted',
            }),
          }
        : fenceCards(item);
  }
  return out;
}

/** Serve the project in the current directory over stdio until the client goes away. */
export async function serveMcp(
  ctx: Context,
  transport: Transport = new StdioServerTransport(),
): Promise<void> {
  const session = await openSession(ctx, { embed: true });
  const server = createMcpServer(session.retriever);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  // A stdio server has no other way to learn that its client is gone.
  if (transport instanceof StdioServerTransport) {
    process.stdin.once('close', () => {
      void server.close();
    });
  }
  await server.connect(transport);
  ctx.environment.stderr(
    `code-lens mcp: serving ${session.retriever.root} (${session.embedderReason})\n`,
  );
  await closed;
  await session.close();
}
