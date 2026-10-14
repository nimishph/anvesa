import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidArgumentError, toCodeLensError } from '../../core/src/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

export interface ServerOptions {
  readonly port?: number;
  readonly root?: string;
  readonly open?: boolean;
  readonly queryParams?: Readonly<Record<string, string>>;
}

interface SearchPayload {
  readonly query?: string;
  readonly wql?: string;
  readonly weights?: Record<string, number>;
  readonly scope?: string;
  readonly limit?: number;
}

interface LiveRetriever {
  close(): Promise<void>;
  status(): Promise<unknown>;
  search(query: string, opts: unknown): Promise<unknown>;
  query(wql: string, opts: unknown): Promise<unknown>;
  callers(symbol: string): Promise<unknown>;
  callees(symbol: string): Promise<unknown>;
  neighbors(symbol: string): Promise<unknown>;
  dependents(path: string): Promise<unknown>;
  repoMap(opts: unknown): Promise<unknown>;
  routes(opts: unknown): Promise<unknown>;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function sendText(
  res: ServerResponse,
  text: string,
  status = 200,
  type = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

export function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'linux') {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (err) {
    process.stderr.write(`anvesa ui: could not open browser automatically: ${String(err)}\n`);
  }
}

export function buildDashboardUrl(
  baseUrl: string,
  queryParams?: Readonly<Record<string, string>>,
): string {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return baseUrl;
  }
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(queryParams)) {
    if (val !== undefined && val !== '') {
      params.set(key, val);
    }
  }
  const qs = params.toString();
  return qs ? `${baseUrl}/?${qs}` : baseUrl;
}

async function readBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        rejectBody(new InvalidArgumentError('body', 'size within 2MB', 'exceeded'));
      }
    });
    req.on('end', () => {
      try {
        resolveBody(body ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        resolveBody({} as T);
      }
    });
    req.on('error', (err) => rejectBody(toCodeLensError(err, 'read request body')));
  });
}

export async function startUiServer(options: ServerOptions = {}) {
  const port = options.port ?? (Number(process.env.ANVESA_PORT) || 3847);
  const projectRoot = resolve(options.root ?? process.cwd());
  const shouldOpen = options.open !== false;

  let retriever: LiveRetriever | null = null;
  let retrieverLoadError: string | null = null;

  try {
    const { loadProjectConfig, Retriever } = await import('../../retriever/src/index.ts');
    try {
      const config = await loadProjectConfig(projectRoot);
      const opened = await Retriever.open({
        root: projectRoot,
        config,
      });
      retriever = opened as unknown as LiveRetriever;
    } catch (err) {
      retrieverLoadError = err instanceof Error ? err.message : String(err);
    }
  } catch {
    retrieverLoadError = 'Retriever package not linked yet or running standalone';
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;

    // --- REST API Endpoints ---
    if (pathname.startsWith('/api/')) {
      try {
        const live = retriever;
        if (pathname === '/api/status' && req.method === 'GET') {
          if (live) {
            try {
              const status = await live.status();
              return sendJson(res, { success: true, live: true, status, root: projectRoot });
            } catch (err) {
              const error = toCodeLensError(err, 'get status');
              return sendJson(res, {
                success: false,
                live: false,
                error: error.message,
                root: projectRoot,
              });
            }
          }
          return sendJson(res, {
            success: true,
            live: false,
            root: projectRoot,
            message:
              retrieverLoadError ?? 'Project not yet indexed. Running in demo / inspection mode.',
          });
        }

        if (pathname === '/api/search' && req.method === 'POST') {
          const body = await readBody<SearchPayload>(req);
          const query = body.query ?? '';
          if (live && query) {
            try {
              const result = await live.search(query, {
                wql: body.wql,
                weights: body.weights,
                scope: body.scope,
                limit: body.limit ?? 20,
              });
              return sendJson(res, { success: true, live: true, result });
            } catch (err) {
              const error = toCodeLensError(err, 'search');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
                query,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true, query });
        }

        if (pathname === '/api/query' && req.method === 'POST') {
          const body = await readBody<{
            readonly wql?: string;
            readonly scope?: string;
            readonly limit?: number;
          }>(req);
          const wql = body.wql ?? '';
          if (live && wql) {
            try {
              const result = await live.query(wql, {
                scope: body.scope,
                limit: body.limit ?? 20,
              });
              return sendJson(res, { success: true, live: true, result });
            } catch (err) {
              const error = toCodeLensError(err, 'query wql');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
                wql,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true, wql });
        }

        if (pathname === '/api/graph/callers' && req.method === 'GET') {
          const symbol = parsedUrl.searchParams.get('symbol') ?? '';
          if (live && symbol) {
            try {
              const callers = await live.callers(symbol);
              return sendJson(res, { success: true, live: true, callers });
            } catch (err) {
              const error = toCodeLensError(err, 'get callers');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
                symbol,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true, symbol });
        }

        if (pathname === '/api/graph/callees' && req.method === 'GET') {
          const symbol = parsedUrl.searchParams.get('symbol') ?? '';
          if (live && symbol) {
            try {
              const callees = await live.callees(symbol);
              return sendJson(res, { success: true, live: true, callees });
            } catch (err) {
              const error = toCodeLensError(err, 'get callees');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
                symbol,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true, symbol });
        }

        if (pathname === '/api/graph/neighbors' && req.method === 'GET') {
          const symbol = parsedUrl.searchParams.get('symbol') ?? '';
          if (live && symbol) {
            try {
              const neighbors = await live.neighbors(symbol);
              return sendJson(res, { success: true, live: true, neighbors });
            } catch (err) {
              const error = toCodeLensError(err, 'get neighbors');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
                symbol,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true, symbol });
        }

        if (pathname === '/api/graph/dependents' && req.method === 'GET') {
          const path = parsedUrl.searchParams.get('path') ?? '';
          if (live && path) {
            try {
              const dependents = await live.dependents(path);
              return sendJson(res, { success: true, live: true, dependents });
            } catch (err) {
              const error = toCodeLensError(err, 'get dependents');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
                path,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true, path });
        }

        if (pathname === '/api/repomap' && req.method === 'GET') {
          const budget = parsedUrl.searchParams.get('budget');
          const scope = parsedUrl.searchParams.get('scope') ?? undefined;
          if (live) {
            try {
              const repomap = await live.repoMap({
                budget: budget ? Number(budget) : undefined,
                scope,
              });
              return sendJson(res, { success: true, live: true, repomap });
            } catch (err) {
              const error = toCodeLensError(err, 'get repomap');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true });
        }

        if (pathname === '/api/routes' && req.method === 'GET') {
          const method = parsedUrl.searchParams.get('method') ?? undefined;
          const routePath = parsedUrl.searchParams.get('path') ?? undefined;
          if (live) {
            try {
              const routes = await live.routes({ method, path: routePath });
              return sendJson(res, { success: true, live: true, routes });
            } catch (err) {
              const error = toCodeLensError(err, 'get routes');
              return sendJson(res, {
                success: true,
                live: false,
                fallback: true,
                error: error.message,
              });
            }
          }
          return sendJson(res, { success: true, live: false, demo: true });
        }

        return sendJson(res, { error: 'Not found' }, 404);
      } catch (err) {
        const error = toCodeLensError(err, 'handle api request');
        return sendJson(res, { error: error.message }, 500);
      }
    }

    // --- Static File Serving ---
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let filePath = join(PUBLIC_DIR, relativePath);

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(PUBLIC_DIR, 'index.html');
    }

    try {
      const ext = extname(filePath);
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      const content = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch {
      sendText(res, 'File not found', 404);
    }
  });

  const activeInstance = {
    port,
    root: projectRoot,
    close: async () => {
      server.close();
      if (retriever) {
        await retriever.close();
      }
      if (runningInstance === activeInstance) {
        runningInstance = undefined;
      }
    },
  };
  runningInstance = activeInstance;

  server.listen(port, () => {
    const rawUrl = `http://localhost:${port}`;
    const displayUrl = buildDashboardUrl(rawUrl, options.queryParams);
    process.stdout.write(
      `\n  \x1b[38;2;99;102;241m▲\x1b[0m \x1b[1m\x1b[38;2;255;255;255manvesa ui\x1b[0m — interactive web dashboard\n`,
    );
    process.stdout.write(`  \x1b[90mURL:\x1b[0m     \x1b[36m${displayUrl}\x1b[0m\n`);
    process.stdout.write(`  \x1b[90mRoot:\x1b[0m    ${projectRoot}\n`);
    process.stdout.write(
      `  \x1b[90mStatus:\x1b[0m  ${retriever ? '\x1b[32mlive index connected\x1b[0m' : '\x1b[33mpreview mode (ready to index)\x1b[0m'}\n\n`,
    );
    if (shouldOpen) {
      openBrowser(displayUrl);
    }
  });

  return {
    server,
    port,
    close: activeInstance.close,
  };
}

let runningInstance:
  | {
      port: number;
      root: string;
      close: () => Promise<void>;
    }
  | undefined;

/**
 * Ensure the Anvesa UI server is running. If already running, reuses the instance
 * and opens the browser with the requested query parameters.
 */
export async function ensureUiRunning(
  options: ServerOptions = {},
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  if (runningInstance) {
    const baseUrl = `http://localhost:${runningInstance.port}`;
    const url = buildDashboardUrl(baseUrl, options.queryParams);
    if (options.open !== false) {
      openBrowser(url);
    }
    return {
      port: runningInstance.port,
      url,
      close: runningInstance.close,
    };
  }

  const instance = await startUiServer({
    ...options,
    open: false,
  });
  const baseUrl = `http://localhost:${instance.port}`;
  const url = buildDashboardUrl(baseUrl, options.queryParams);
  if (options.open !== false) {
    openBrowser(url);
  }
  return {
    port: instance.port,
    url,
    close: instance.close,
  };
}

// Direct execution from CLI: bun run src/server.ts
if (import.meta.main || process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let root: string | undefined;
  let open = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (args[i] === '--root' && args[i + 1]) {
      root = args[++i];
    } else if (args[i] === '--no-open') {
      open = false;
    }
  }

  startUiServer({
    ...(port !== undefined ? { port } : {}),
    ...(root !== undefined ? { root } : {}),
    open,
  });
}
