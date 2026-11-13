/**
 * The guidance an agent reads (the primer, skills/anvesa/SKILL.md, README.md) against the code it
 * describes. Each of these drifted before: WQL forms the parser rejected, attributes that do not
 * exist, MCP parameters under the wrong name, commands no guide mentioned (#49, #51). A change to a
 * command, a tool or the WQL grammar now fails here until the guides say the same thing.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KNOWN_ATTRIBUTES, parseWql, type Retriever } from '@cntxt-labs/anvesa-retriever';
import { COMMAND_HELP } from './help.ts';
import { createMcpServer } from './mcp.ts';
import { PRIMER_TOPICS } from './primer.ts';

const repo = resolve(import.meta.dir, '../..');
const skill = readFileSync(resolve(repo, 'skills/anvesa/SKILL.md'), 'utf8');
const readme = readFileSync(resolve(repo, 'README.md'), 'utf8');
const primer = Object.values(PRIMER_TOPICS)
  .map((topic) => topic.content)
  .join('\n');
const guides: Record<string, string> = { primer, 'SKILL.md': skill, 'README.md': readme };

/** Every first word a command line can start with. */
const commandKeys = COMMAND_HELP.flatMap((help) => help.keys).filter((key) => !key.startsWith('-'));

describe('the guides name every command, and only commands that exist', () => {
  test.each(commandKeys)('%s is in the primer or the skill', (key) => {
    const named = new RegExp(`(anvesa ${key}\\b|\`${key}\\b)`);
    expect(named.test(primer) || named.test(skill)).toBe(true);
  });

  test.each(Object.keys(guides))(
    'every `anvesa <command>` in the code of %s is a command',
    (name) => {
      // Code only, fenced blocks and inline spans: in prose "anvesa runs" is a sentence.
      const text = guides[name] as string;
      const code = [
        ...[...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] as string),
        ...[...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(
          (m) => m[1] as string,
        ),
      ].join('\n');
      const used = [...code.matchAll(/(?:^|[\s`'"(])anvesa ([a-z][a-z-]*)\b/gm)].map(
        (m) => m[1] as string,
      );
      expect([...new Set(used)].filter((word) => !commandKeys.includes(word))).toEqual([]);
    },
  );
});

/** WQL in a guide: backticked or single-quoted text that starts with `//`, conjunctions aside. */
function wqlIn(text: string): string[] {
  const found = [...text.matchAll(/`(\/\/[^`\n]+)`|'(\/\/[^'\n]+)'/g)]
    .map((m) => (m[1] ?? m[2] ?? '').trim())
    .filter((query) => !query.includes('&&') && !/\swhere\s/.test(query));
  return [...new Set(found)];
}

function attributesOf(predicate: {
  attr?: string;
  left?: unknown;
  right?: unknown;
  inner?: unknown;
}): string[] {
  const nested = [predicate.left, predicate.right, predicate.inner].filter(Boolean) as {
    attr?: string;
  }[];
  return [...(predicate.attr ? [predicate.attr] : []), ...nested.flatMap(attributesOf)];
}

describe('every WQL example parses and uses real attributes', () => {
  for (const [name, text] of Object.entries(guides)) {
    const queries = wqlIn(text);
    test(`${name} has WQL examples`, () => {
      if (name !== 'README.md') expect(queries.length).toBeGreaterThan(5);
    });
    test.each(queries)(`${name}: %s`, (query) => {
      const parsed = parseWql(query);
      const attributes = parsed.steps.flatMap((step) => step.predicates.flatMap(attributesOf));
      expect(attributes.filter((attr) => !KNOWN_ATTRIBUTES.has(attr))).toEqual([]);
    });
  }
});

describe('the skill describes the MCP tools as they are', () => {
  const server = createMcpServer({
    root: '/project',
    registry: { channels: () => ['symbols', 'docs'] },
    patterns: { inspect: () => [], run: async () => ({}) },
  } as unknown as Retriever);
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
    }
  )._registeredTools;
  /** Parameter names, `?` after an optional one, as the skill writes them. */
  const parametersOf = (name: string): string[] => {
    const shape = (registered[name]?.inputSchema?.shape ?? {}) as Record<
      string,
      { isOptional?: () => boolean }
    >;
    return Object.entries(shape)
      .map(([key, field]) => (field.isOptional?.() ? `${key}?` : key))
      .sort();
  };
  const documented = new Map(
    [...skill.matchAll(/^- `([a-z_<>]+)`[^:\n]*: parameters `\{(.*)\}`$/gm)].map((m) => [
      m[1] as string,
      [...(m[2] as string).matchAll(/"(\w+)"(\??):/g)].map((p) => `${p[1]}${p[2]}`).sort(),
    ]),
  );

  test.each(Object.keys(registered).filter((name) => !name.startsWith('retrieve_')))(
    '%s is documented with its parameters',
    (name) => {
      expect(documented.get(name)).toEqual(parametersOf(name));
    },
  );

  test('retrieve_<channel> is documented with its parameters', () => {
    expect(documented.get('retrieve_<channel>')).toEqual(parametersOf('retrieve_docs'));
  });

  test('the skill documents no tool the server does not have', () => {
    const tools = new Set([...Object.keys(registered), 'retrieve_<channel>']);
    expect([...documented.keys()].filter((name) => !tools.has(name))).toEqual([]);
  });
});
