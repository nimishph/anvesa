import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
  readonly token?: string;
  readonly retriever?: LiveRetriever;
}

interface SearchPayload {
  readonly query?: string;
  readonly wql?: string;
  readonly weights?: Record<string, number>;
  readonly scope?: string;
  readonly limit?: number;
}

export interface LiveRetriever {
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
        rejectBody(new InvalidArgumentError('body', 'valid JSON', body));
      }
    });
    req.on('error', (err) => rejectBody(toCodeLensError(err, 'read request body')));
  });
}

export async function startUiServer(options: ServerOptions = {}) {
  const port = options.port ?? (Number(process.env.ANVESA_PORT) || 3847);
  const projectRoot = resolve(options.root ?? process.cwd());
  const shouldOpen = options.open !== false;
  const sessionToken = options.token ?? randomBytes(16).toString('hex');

  let retriever: LiveRetriever | null = options.retriever ?? null;
  let ownRetriever = false;
  let retrieverLoadError: string | null = null;

  if (!retriever) {
    try {
      const { loadProjectConfig, Retriever } = await import('../../retriever/src/index.ts');
      try {
        const config = await loadProjectConfig(projectRoot);
        const opened = await Retriever.open({
          root: projectRoot,
          config,
        });
        retriever = opened as unknown as LiveRetriever;
        ownRetriever = true;
      } catch (err) {
        retrieverLoadError = err instanceof Error ? err.message : String(err);
      }
    } catch {
      retrieverLoadError = 'Retriever package not linked yet or running standalone';
    }
  }

  const server = createServer(async (req, res) => {
    // 1. Host header validation to prevent DNS rebinding attacks
    const host = req.headers.host;
    const hostName = host?.split(':')[0]?.toLowerCase();
    if (hostName !== 'localhost' && hostName !== '127.0.0.1') {
      sendText(res, 'Forbidden: Invalid Host header', 403);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const pathname = parsedUrl.pathname;

    // --- REST API Endpoints ---
    if (pathname.startsWith('/api/')) {
      // 2. Token authentication for all API endpoints to prevent cross-site queries
      const token = req.headers['x-anvesa-token'] ?? parsedUrl.searchParams.get('token');
      if (!token || token !== sessionToken) {
        sendJson(res, { error: 'Unauthorized: Missing or invalid session token' }, 401);
        return;
      }

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
    const rawUrl = req.url ?? '';
    let decodedUrl = '';
    try {
      decodedUrl = decodeURIComponent(rawUrl);
    } catch {
      // Malformed URI is treated as an empty string for traversal checks
      decodedUrl = '';
    }

    if (rawUrl.includes('..') || pathname.includes('..') || decodedUrl.includes('..')) {
      sendText(res, 'Forbidden: Path traversal not allowed', 403);
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const resolvedPath = resolve(PUBLIC_DIR, relativePath);
    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
      sendText(res, 'Forbidden: Path traversal not allowed', 403);
      return;
    }

    let filePath = resolvedPath;
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      if (!extname(pathname)) {
        filePath = join(PUBLIC_DIR, 'index.html');
      } else {
        sendText(res, 'File not found', 404);
        return;
      }
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
    token: sessionToken,
    root: projectRoot,
    close: async () => {
      server.close();
      if (ownRetriever && retriever) {
        await retriever.close();
      }
      if (runningInstance === activeInstance) {
        runningInstance = undefined;
      }
    },
  };
  runningInstance = activeInstance;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      rejectPromise(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const rawUrl = `http://127.0.0.1:${port}`;
      const displayUrl = buildDashboardUrl(rawUrl, {
        token: sessionToken,
        ...options.queryParams,
      });
      process.stdout.write(
        `\n  \x1b[38;2;99;102;241m▲\x1b[0m \x1b[1m\x1b[38;2;255;255;255manvesa ui\x1b[0m — interactive web dashboard\n`,
      );
      process.stdout.write(`  \x1b[90mURL:\x1b[0m     \x1b[36m${displayUrl}\x1b[0m\n`);
      process.stdout.write(`  \x1b[90mRoot:\x1b[0m    ${projectRoot}\n`);
      process.stdout.write(
        `  \x1b[90mStatus:\x1b[0m  ${retriever ? '\x1b[32mlive index connected\x1b[0m' : '\x1b[33mpreview mode (ready to index)\x1b[0m'}\n\n`,
      );
      resolvePromise();
      if (shouldOpen) {
        openBrowser(displayUrl);
      }
    });
  });

  return {
    server,
    port,
    token: sessionToken,
    close: activeInstance.close,
  };
}

let runningInstance:
  | {
      port: number;
      token: string;
      root: string;
      close: () => Promise<void>;
    }
  | undefined;

export async function closeRunningUi(): Promise<void> {
  if (runningInstance) {
    await runningInstance.close();
  }
}

/**
 * Ensure the Anvesa UI server is running. If already running, reuses the instance
 * and opens the browser with the requested query parameters.
 */
export async function ensureUiRunning(
  options: ServerOptions = {},
): Promise<{ port: number; url: string; token: string; close: () => Promise<void> }> {
  if (runningInstance && (options.port === undefined || runningInstance.port === options.port)) {
    const baseUrl = `http://127.0.0.1:${runningInstance.port}`;
    const url = buildDashboardUrl(baseUrl, {
      token: runningInstance.token,
      ...options.queryParams,
    });
    if (options.open !== false) {
      openBrowser(url);
    }
    return {
      port: runningInstance.port,
      token: runningInstance.token,
      url,
      close: runningInstance.close,
    };
  }

  try {
    const instance = await startUiServer({
      ...options,
      open: false,
    });
    const baseUrl = `http://127.0.0.1:${instance.port}`;
    const url = buildDashboardUrl(baseUrl, {
      token: instance.token,
      ...options.queryParams,
    });
    if (options.open !== false) {
      openBrowser(url);
    }
    return {
      port: instance.port,
      token: instance.token,
      url,
      close: instance.close,
    };
  } catch (err: unknown) {
    const isAddrInUse = (err as { code?: string })?.code === 'EADDRINUSE';
    if (isAddrInUse) {
      const port = options.port ?? (Number(process.env.ANVESA_PORT) || 3847);
      const baseUrl = `http://127.0.0.1:${port}`;
      const url = buildDashboardUrl(baseUrl, options.queryParams);
      if (options.open !== false) {
        openBrowser(url);
      }
      return {
        port,
        token: '',
        url,
        close: async () => {
          // Reused instance is managed by its original creator
        },
      };
    }
    throw err;
  }
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
