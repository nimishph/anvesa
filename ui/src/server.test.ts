import { describe, expect, test } from 'bun:test';
import { buildDashboardUrl, ensureUiRunning, startUiServer } from './server.ts';

interface ApiResponse {
  readonly success: boolean;
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

      // Raw path traversal attempts are blocked with 403
      const traversalStatus = await new Promise<number>((resolve) => {
        const { get } = require('node:http');
        get(
          { host: '127.0.0.1', port: 3897, path: '/../package.json' },
          (res: { statusCode: number }) => {
            resolve(res.statusCode);
          },
        );
      });
      expect(traversalStatus).toBe(403);

      // Non-existent static files with extensions return 404
      const resNotFound = await fetch('http://127.0.0.1:3897/nonexistent.js');
      expect(resNotFound.status).toBe(404);
    } finally {
      await instance.close();
    }
  });
});
