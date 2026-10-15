import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { ASSETS } from './assets.ts';
import { buildDashboardUrl, ensureUiRunning, startUiServer } from './server.ts';

interface ApiResponse {
  readonly success: boolean;
}

/** The status of a GET whose path is sent exactly as given. */
function rawStatus(port: number, path: string): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
    });
    socket.on('end', () => resolveStatus(Number(response.split(' ')[1])));
    socket.on('error', rejectStatus);
  });
}

/** Holds a port, as another program would. */
async function occupy(port: number): Promise<() => Promise<void>> {
  const blocker = createServer();
  await new Promise<void>((done, fail) => {
    blocker.once('error', fail);
    blocker.listen(port, '127.0.0.1', done);
  });
  return () => new Promise((done) => blocker.close(() => done()));
}

describe('anvesa-ui server', () => {
  test('buildDashboardUrl constructs target URLs with search parameters', () => {
    expect(buildDashboardUrl('http://localhost:3847')).toBe('http://localhost:3847');
    expect(
      buildDashboardUrl('http://localhost:3847', {
        q: 'authentication token',
        mode: 'fused',
        wql: '//class//method',
        symbol: 'Retriever.search',
      }),
    ).toBe(
      'http://localhost:3847/?q=authentication+token&mode=fused&wql=%2F%2Fclass%2F%2Fmethod&symbol=Retriever.search',
    );
  });

  test('ensureUiRunning starts or reuses running instance', async () => {
    const running = await ensureUiRunning({
      port: 3899,
      open: false,
      queryParams: { q: 'token' },
    });
    try {
      expect(running.port).toBe(3899);
      expect(running.url).toContain('q=token');

      // Second call reuses running instance
      const second = await ensureUiRunning({
        open: false,
        queryParams: { symbol: 'fuse' },
      });
      expect(second.port).toBe(3899);
      expect(second.url).toContain('symbol=fuse');
    } finally {
      await running.close();
    }
  });

  test('serves web assets and requires session token for JSON API endpoints', async () => {
    const instance = await startUiServer({ port: 3898, open: false });

    try {
      // Static assets are accessible without token
      const resIndex = await fetch('http://127.0.0.1:3898/');
      expect(resIndex.status).toBe(200);
      expect(resIndex.headers.get('content-type')).toContain('text/html');

      // API calls without token are rejected with 401
      const resUnauth = await fetch('http://127.0.0.1:3898/api/status');
      expect(resUnauth.status).toBe(401);

      // API calls with invalid token are rejected with 401
      const resBadToken = await fetch('http://127.0.0.1:3898/api/status', {
        headers: { 'X-Anvesa-Token': 'invalid-token' },
      });
      expect(resBadToken.status).toBe(401);

      // API calls with valid token in header succeed
      const resStatus = await fetch('http://127.0.0.1:3898/api/status', {
        headers: { 'X-Anvesa-Token': instance.token },
      });
      expect(resStatus.status).toBe(200);
      const statusJson = (await resStatus.json()) as ApiResponse;
      expect(statusJson.success).toBe(true);

      // API calls with valid token in query param succeed
      const resSearch = await fetch(`http://127.0.0.1:3898/api/search?token=${instance.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'parse' }),
      });
      expect(resSearch.status).toBe(200);
      const searchJson = (await resSearch.json()) as ApiResponse;
      expect(searchJson.success).toBe(true);

      const resRoutes = await fetch(`http://127.0.0.1:3898/api/routes?token=${instance.token}`);
      expect(resRoutes.status).toBe(200);
      const routesJson = (await resRoutes.json()) as ApiResponse;
      expect(routesJson.success).toBe(true);
    } finally {
      await instance.close();
    }
  });

  test('rejects requests with invalid Host header and blocks path traversal', async () => {
    const instance = await startUiServer({ port: 3897, open: false });

    try {
      // Invalid Host header returns 403 Forbidden
      const resBadHost = await fetch('http://127.0.0.1:3897/', {
        headers: { Host: 'evil-site.com' },
      });
      expect(resBadHost.status).toBe(403);

      // HTTP clients normalise `..` away, so the request line is written by hand. Bun's parser
      // may refuse it (400) before the handler does (403); either way nothing is read.
      for (const path of ['/../package.json', '/%2e%2e/package.json', '/js/../../package.json']) {
        const status = await rawStatus(3897, path);
        expect([400, 403, 404]).toContain(status);
      }

      // Only the dashboard's own files are served
      expect(await rawStatus(3897, '/package.json')).toBe(404);
      expect(await rawStatus(3897, '/js/app.js')).toBe(200);

      // Non-existent static files with extensions return 404
      const resNotFound = await fetch('http://127.0.0.1:3897/nonexistent.js');
      expect(resNotFound.status).toBe(404);
    } finally {
      await instance.close();
    }
  });

  test('a port asked for that is taken is an error, and nothing is left running', async () => {
    const release = await occupy(3896);
    try {
      await expect(startUiServer({ port: 3896, open: false })).rejects.toThrow(/port/);
      // The failed start did not register itself, so the next call starts afresh.
      const started = await ensureUiRunning({ port: 3895, open: false });
      try {
        expect(started.port).toBe(3895);
      } finally {
        await started.close();
      }
    } finally {
      await release();
    }
  });

  test('with no port asked for, a taken default falls back to a free port', async () => {
    const previous = process.env.ANVESA_PORT;
    delete process.env.ANVESA_PORT;
    // When something else already holds the default port, that is the case under test.
    const release = await occupy(3847).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') throw err;
      return undefined;
    });
    try {
      const instance = await startUiServer({ open: false });
      try {
        expect(instance.port).not.toBe(3847);
        expect(instance.port).toBeGreaterThan(0);
        const res = await fetch(`http://127.0.0.1:${instance.port}/api/status`, {
          headers: { 'X-Anvesa-Token': instance.token },
        });
        expect(res.status).toBe(200);
      } finally {
        await instance.close();
      }
    } finally {
      await release?.();
      if (previous !== undefined) process.env.ANVESA_PORT = previous;
    }
  });

  test('every dashboard script parses as a module', () => {
    // The browser scripts are outside lint and typecheck, so a syntax error would ship silently.
    const transpiler = new Bun.Transpiler({ loader: 'js' });
    const scripts = [...ASSETS].filter(([path]) => path.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, file] of scripts) {
      expect(() => transpiler.transformSync(readFileSync(file, 'utf8'))).not.toThrow();
    }
  });
});
