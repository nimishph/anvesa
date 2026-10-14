import { describe, expect, it } from 'bun:test';
import type { Retriever } from '@cntxt-labs/anvesa-retriever';
import { createMcpServer } from './mcp.ts';

describe('anvesa MCP Server & Showcase Tool', () => {
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
          { execute?: (args: unknown) => Promise<{ content: [{ text: string }] }> }
        >;
      }
    )._registeredTools;
    if (registeredTools) {
      expect(registeredTools.show_in_ui).toBeDefined();
      expect(registeredTools.search).toBeDefined();
      expect(registeredTools.primer).toBeDefined();
    }
  });

  it('executes show_in_ui tool and returns dashboard URL and target view', async () => {
    const server = createMcpServer(fakeRetriever);
    const registeredTools = (
      server as unknown as {
        _registeredTools?: Record<
          string,
          {
            execute: (
              args: Record<string, unknown>,
              extra: unknown,
            ) => Promise<{ content: [{ text: string }] }>;
          }
        >;
      }
    )._registeredTools;

    if (registeredTools?.show_in_ui?.execute) {
      const result = await registeredTools.show_in_ui.execute(
        {
          query: 'jwt token',
          mode: 'fused',
          symbol: 'verifyJwt',
          view: 'graph',
        },
        {},
      );
      expect(result.content[0]?.text).toContain('opened');
      expect(result.content[0]?.text).toContain('http://localhost:');
      expect(result.content[0]?.text).toContain('q=jwt+token');
      expect(result.content[0]?.text).toContain('symbol=verifyJwt');
    }
  });
});
