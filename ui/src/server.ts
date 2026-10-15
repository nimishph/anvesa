import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve } from 'node:path';
import { InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
import type { Retriever } from '@cntxt-labs/anvesa-retriever';
import { ASSETS } from './assets.ts';

const DEFAULT_PORT = 3847;

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

/** What the dashboard asks of a retriever. */
export type LiveRetriever = Pick<
  Retriever,
  | 'close'
  | 'status'
  | 'search'
  | 'query'
  | 'callers'
  | 'callees'
  | 'neighbors'
  | 'dependents'
  | 'repoMap'
  | 'routes'
>;

/** The port asked for: the option, then `ANVESA_PORT`. Undefined when neither names one. */
function requestedPort(options: ServerOptions): number | undefined {
  if (options.port !== undefined) return options.port;
  const fromEnv = Number(process.env.ANVESA_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : undefined;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (err: Error) => rejectListen(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolveListen((server.address() as AddressInfo).port);
    });
  });
}

/** Drops keys whose value is undefined, so optional options stay absent rather than undefined. */
function defined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
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

/**
 * Start the dashboard on 127.0.0.1. With no port asked for, it takes 3847, or a free port when
 * 3847 is taken; a port asked for that is taken is an error.
 */
export async function startUiServer(options: ServerOptions = {}) {
  const asked = requestedPort(options);
  const projectRoot = resolve(options.root ?? process.cwd());
  const shouldOpen = options.open !== false;
  const sessionToken = options.token ?? randomBytes(16).toString('hex');

  let retriever: LiveRetriever | null = options.retriever ?? null;
  let ownRetriever = false;
  let retrieverLoadError: string | null = null;
  // Set once listening; no request arrives before then.
  let port = 0;

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
              const result = await live.search(
                query,
                defined({
                  wql: body.wql,
                  weights: body.weights,
                  scope: body.scope,
                  limit: body.limit ?? 20,
                }),
              );
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
              const result = await live.query(
                wql,
                defined({ scope: body.scope, limit: body.limit ?? 20 }),
              );
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
              const repomap = await live.repoMap(
                defined({ budget: budget ? Number(budget) : undefined, scope }),
              );
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
              const routes = await live.routes(defined({ method, path: routePath }));
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
    // Only files in the asset table are served, so no path can reach anything else on disk.
    if ((req.url ?? '').includes('..')) {
      sendText(res, 'Forbidden: Path traversal not allowed', 403);
      return;
    }
    const asset =
      ASSETS.get(pathname === '/' ? '/index.html' : pathname) ??
      (extname(pathname) ? undefined : ASSETS.get('/index.html'));
    if (!asset) {
      sendText(res, 'File not found', 404);
      return;
    }
    try {
      const content = readFileSync(asset);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(asset)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch {
      sendText(res, 'File not found', 404);
    }
  });

  try {
    port = await listen(server, asked ?? DEFAULT_PORT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (asked !== undefined) {
      throw new InvalidArgumentError('port', 'a free port', asked, { cause: err });
    }
    port = await listen(server, 0);
  }

  // Opened only once the port is held, so a failed start leaves nothing open.
  if (!retriever) {
    try {
      const { loadProjectConfig, Retriever } = await import('@cntxt-labs/anvesa-retriever');
      const config = await loadProjectConfig(projectRoot);
      retriever = await Retriever.open({ root: projectRoot, config });
      ownRetriever = true;
    } catch (err) {
      retrieverLoadError = toCodeLensError(err, 'open the index').message;
    }
  }

  const activeInstance = {
    port,
    token: sessionToken,
    root: projectRoot,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (ownRetriever && retriever) {
        await retriever.close();
      }
      if (runningInstance === activeInstance) {
        runningInstance = undefined;
      }
    },
  };
  runningInstance = activeInstance;

  const displayUrl = buildDashboardUrl(`http://127.0.0.1:${port}`, {
    token: sessionToken,
    ...options.queryParams,
  });
  // stderr: under MCP, stdout carries the protocol.
  process.stderr.write(
    `\n  \x1b[38;2;99;102;241m▲\x1b[0m \x1b[1m\x1b[38;2;255;255;255manvesa ui\x1b[0m — interactive web dashboard\n`,
  );
  process.stderr.write(`  \x1b[90mURL:\x1b[0m     \x1b[36m${displayUrl}\x1b[0m\n`);
  process.stderr.write(`  \x1b[90mRoot:\x1b[0m    ${projectRoot}\n`);
  process.stderr.write(
    `  \x1b[90mStatus:\x1b[0m  ${retriever ? '\x1b[32mlive index connected\x1b[0m' : `\x1b[33mno index (${retrieverLoadError ?? 'not opened'})\x1b[0m`}\n\n`,
  );
  if (shouldOpen) {
    openBrowser(displayUrl);
  }

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

  const instance = await startUiServer({
    ...options,
    open: false,
  });
  const url = buildDashboardUrl(`http://127.0.0.1:${instance.port}`, {
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
}
