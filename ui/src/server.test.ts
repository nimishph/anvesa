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

  test('serves web assets and JSON API endpoints', async () => {
    const instance = await startUiServer({ port: 3898, open: false });

    try {
      const resIndex = await fetch('http://localhost:3898/');
      expect(resIndex.status).toBe(200);
      expect(resIndex.headers.get('content-type')).toContain('text/html');

      const resStatus = await fetch('http://localhost:3898/api/status');
      expect(resStatus.status).toBe(200);
      const statusJson = (await resStatus.json()) as ApiResponse;
      expect(statusJson.success).toBe(true);

      const resSearch = await fetch('http://localhost:3898/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'parse' }),
      });
      expect(resSearch.status).toBe(200);
      const searchJson = (await resSearch.json()) as ApiResponse;
      expect(searchJson.success).toBe(true);

      const resRoutes = await fetch('http://localhost:3898/api/routes');
      expect(resRoutes.status).toBe(200);
      const routesJson = (await resRoutes.json()) as ApiResponse;
      expect(routesJson.success).toBe(true);
    } finally {
      await instance.close();
    }
  });
});
