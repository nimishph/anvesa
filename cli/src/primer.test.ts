import { describe, expect, it } from 'bun:test';
import { DEFAULT_RRF_K } from '@cntxt-labs/anvesa-retriever';
import { COMMANDS } from './commands.ts';
import { getPrimer, PRIMER_TOPIC_NAMES, PRIMER_TOPICS, renderPrimer } from './primer.ts';

describe('anvesa primer CLI & MCP Tool (anv-35b)', () => {
  it('returns index table of contents when called with no topic or help/index/toc', () => {
    const index = getPrimer();
    expect(index.topic).toBe('index');
    expect(index.title).toContain('Available Topics');
    expect(index.availableTopics.length).toBe(PRIMER_TOPIC_NAMES.length);
    expect(index.content).toContain('anvesa primer <topic>');

    const fromEmpty = getPrimer('');
    expect(fromEmpty.topic).toBe('index');

    const fromHelp = getPrimer('help');
    expect(fromHelp.topic).toBe('index');

    const fromToc = getPrimer('toc');
    expect(fromToc.topic).toBe('index');
  });

  it('retrieves every canonical topic with strict token-frugal bounds (<= 65 lines)', () => {
    for (const topicName of PRIMER_TOPIC_NAMES) {
      const topic = getPrimer(topicName);
      expect(topic.topic).toBe(topicName);
      expect(topic.title.length).toBeGreaterThan(5);
      expect(topic.description?.length ?? 0).toBeGreaterThan(10);
      expect(topic.content).toContain('# ');

      // Token frugality constraint: max 65 lines per topic
      expect(topic.lineCount).toBeLessThanOrEqual(65);
    }
  });

  it('throws informative error for unknown topic naming valid topics', () => {
    expect(() => getPrimer('nonexistent-topic')).toThrow(
      /one of: overview, wql, fusion, graph, indexing, grammars/,
    );
  });

  it('renders with and without compact mode', () => {
    const topic = getPrimer('fusion');
    const normal = renderPrimer(topic, false);
    expect(normal).toContain('*Anvesa Primer (fusion)*');

    const compact = renderPrimer(topic, true);
    expect(compact).not.toContain('*Anvesa Primer');
    expect(compact.trim()).toBe(topic.content.trim());
  });

  it('guarantees zero-drift: all core CLI subcommands are documented in primer topics', () => {
    const registeredSubcommands = [
      ...Object.keys(COMMANDS),
      'channel',
      'grammar',
      'mapping',
      'model',
      'redteam',
      'fragments',
      'pattern',
      'mcp',
    ];

    expect(registeredSubcommands).toContain('primer');

    // Aggregate all primer content
    const allPrimerText = Object.values(PRIMER_TOPICS)
      .map((t) => t.content)
      .join('\n');

    for (const cmd of registeredSubcommands) {
      // Each command must be referenced in primer topics
      const pattern = new RegExp(`\\b${cmd}\\b`, 'i');
      expect(pattern.test(allPrimerText)).toBe(true);
    }
  });

  it('guarantees zero-drift: key MCP tools are documented in primer topics', () => {
    const mcpTools = [
      'search',
      'query',
      'callers',
      'callees',
      'neighbors',
      'dependents',
      'map',
      'explain',
      'status',
      'index',
      'primer',
    ];

    const allPrimerText = Object.values(PRIMER_TOPICS)
      .map((t) => t.content)
      .join('\n');

    for (const tool of mcpTools) {
      const pattern = new RegExp(`\\b${tool}\\b`, 'i');
      expect(pattern.test(allPrimerText)).toBe(true);
    }
  });

  it('guarantees zero-drift: engine constants match code constants', () => {
    const fusionTopic = getPrimer('fusion').content;
    expect(fusionTopic).toContain(`k = ${DEFAULT_RRF_K}`);
  });
});
