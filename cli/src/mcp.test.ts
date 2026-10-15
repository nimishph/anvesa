import { afterAll, describe, expect, it } from 'bun:test';
import type { Retriever } from '@cntxt-labs/anvesa-retriever';
import { closeRunningUi } from '@cntxt-labs/anvesa-ui';
import { createMcpServer } from './mcp.ts';

describe('anvesa MCP Server & Showcase Tool', () => {
  afterAll(async () => {
    await closeRunningUi();
  });

  const fakeRetriever = {
    root: '/workspace/test-repo',
    registry: {
      channels: () => ['symbols', 'docs'],
    },
    patterns: {
      inspect: () => [],
      run: async () => ({ hits: [] }),
    },
  } as unknown as Retriever;

  it('registers the show_in_ui tool with parameter schema', () => {
    const server = createMcpServer(fakeRetriever);
    expect(server).toBeDefined();

    const registeredTools = (
      server as unknown as {
        _registeredTools?: Record<
          string,
          { handler?: (args: unknown, extra: unknown) => Promise<{ content: [{ text: string }] }> }
        >;
      }
    )._registeredTools;
    expect(registeredTools).toBeDefined();
    expect(registeredTools?.show_in_ui).toBeDefined();
    expect(registeredTools?.search).toBeDefined();
    expect(registeredTools?.primer).toBeDefined();
  });

  it('executes show_in_ui tool and returns dashboard URL and target view', async () => {
    const server = createMcpServer(fakeRetriever);
    const registeredTools = (
      server as unknown as {
        _registeredTools?: Record<
          string,
          {
            handler?: (
              args: Record<string, unknown>,
              extra: unknown,
            ) => Promise<{ content: [{ text: string }] }>;
          }
        >;
      }
    )._registeredTools;

    const tool = registeredTools?.show_in_ui;
    expect(tool).toBeDefined();
    expect(typeof tool?.handler).toBe('function');

    const result = await tool?.handler?.(
      {
        query: 'jwt token',
        mode: 'fused',
        symbol: 'verifyJwt',
        view: 'graph',
      },
      {},
    );
    expect(result).toBeDefined();
    const text = result?.content[0]?.text ?? '';
    expect(text).toContain('opened');
    expect(text).toMatch(/http:\/\/(localhost|127\.0\.0\.1):/);
    expect(text).toContain('q=jwt+token');
    expect(text).toContain('symbol=verifyJwt');
    expect(text).toContain('token=');
  });
});
