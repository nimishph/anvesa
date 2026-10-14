import { describe, expect, test } from 'bun:test';
import { startUiServer } from './server.ts';

interface ApiResponse {
  readonly success: boolean;
}

describe('anvesa-ui server', () => {
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
