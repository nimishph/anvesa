import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Embedder, npmPackageSource, SyntaxRuntime } from '@sutras/code-lens-retriever';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';
import { serveMcp } from './mcp.ts';
import { parseOptions } from './options.ts';

const NOTES_CHANNEL = resolve(import.meta.dir, '../../retriever/src/__fixtures__/notes-channel.ts');

const roots: string[] = [];
const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
afterAll(async () => {
  await runtime.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Word-hash vectors: texts that share words are close. A test double, not a model. */
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const embedder: Embedder = {
  info: { id: 'test-words', dimensions: 256, maxTokens: 512 },
  count: (text) => words(text).length,
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Float32Array(256);
      for (const word of words(text)) {
        let hash = 7;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 256;
        vector[hash] = (vector[hash] as number) + 1;
      }
      if (vector.every((v) => v === 0)) vector[0] = 1;
      return vector;
    });
  },
};

const project = {
  'package.json': '{"name":"app"}',
  'src/config.ts': `/** Parse the configuration file into validated settings. */
export function parseConfig(text: string) { return validate(text); }
/** Check that settings are well formed. */
export function validate(text: string) { return text.length > 0; }
`,
  'src/server.ts': `import { parseConfig } from './config';
/** Start the http server and listen for requests. */
export function startServer() { return parseConfig('x'); }
`,
  'docs/guide.md': '# Guide\n## Install\nRun the installer to set the service up.\n',
};

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'code-lens-cli-'));
  roots.push(root);
  for (const [path, text] of Object.entries(project)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(root: string, ...argv: string[]): Promise<Ran> {
  return cliWith({}, root, ...argv);
}

async function cliWith(
  overrides: Partial<Environment>,
  root: string,
  ...argv: string[]
): Promise<Ran> {
  let out = '';
  let err = '';
  const environment: Environment = {
    cwd: root,
    env: {},
    embedder,
    runtime,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    ...overrides,
  };
  const code = await runCli(argv, environment);
  return { code, out, err };
}

// biome-ignore lint/suspicious/noExplicitAny: the shape is asserted by each test
const json = (ran: Ran): any => JSON.parse(ran.out);

describe('command line', () => {
  test('help lists the commands and exits 0; no command is a usage error', async () => {
    const root = makeProject();
    const help = await cli(root, '--help');
    expect(help.code).toBe(0);
    for (const word of ['index', 'retrieve', 'channel', 'mcp serve', 'diagnose'])
      expect(help.out).toContain(word);
    expect(help.out).not.toContain('get-symbol');
    expect((await cli(root)).code).toBe(2);
  });

  test('prints its version', async () => {
    const ran = await cli(makeProject(), '--version');
    expect(ran.code).toBe(0);
    expect(ran.out).toMatch(/^code-lens \d+\.\d+\.\d+/);
  });

  test('an unknown command or option is a usage error that says what was wrong', async () => {
    const root = makeProject();
    const unknown = await cli(root, 'frobnicate');
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown command "frobnicate"');
    const option = await cli(root, 'status', '--nope');
    expect(option.code).toBe(2);
    expect(option.err).toContain('CORE_INVALID_ARGUMENT');
    expect(() => parseOptions(['--limit'])).toThrow();
  });

  test('index, status, search, query, callers, dependents and explain work end to end', async () => {
    const root = makeProject();
    const before = await cli(root, 'search', 'parse configuration', '--json');
    expect(before.code).toBe(1);
    expect(before.err).toContain('index');

    const indexed = await cli(root, 'index', '--json');
    expect(indexed.code).toBe(0);
    expect(json(indexed).report.files.added).toBeGreaterThanOrEqual(3);

    const status = await cli(root, 'status');
    expect(status.out).toContain('symbols');

    const search = json(await cli(root, 'search', 'parse the configuration file', '--json'));
    expect(search.items[0].path).toBe('src/config.ts');
    expect(search.items[0].foundBy.length).toBeGreaterThan(0);

    const text = await cli(root, 'search', 'parse the configuration file');
    expect(text.out).toContain('src/config.ts');
    expect(text.out).toContain('untrusted');

    const structural = json(await cli(root, 'query', '//function[@name="validate"]', '--json'));
    // biome-ignore lint/suspicious/noExplicitAny: asserting a JSON shape
    expect(structural.items.map((h: any) => h.name)).toEqual(['validate']);

    const callers = json(await cli(root, 'callers', 'validate', '--json'));
    expect(JSON.stringify(callers)).toContain('src/config.ts');

    const dependents = json(await cli(root, 'dependents', 'src/config.ts', '--json'));
    expect(JSON.stringify(dependents)).toContain('src/server.ts');

    const explained = await cli(root, 'explain');
    expect(explained.out).toContain('languages');

    const diagnosed = await cli(
      root,
      'diagnose',
      'parse the configuration file',
      '--expect',
      'src/config.ts',
    );
    expect(diagnosed.code).toBe(0);
    expect(diagnosed.out).toContain('index:');
  });

  test('a limit is applied, reported and continued with a cursor', async () => {
    const root = makeProject();
    await cli(root, 'index');
    const first = json(await cli(root, 'query', '//function', '--limit', '2', '--json'));
    expect(first.items).toHaveLength(2);
    expect(first.limit).toMatchObject({ applied: 2, source: 'caller' });
    const second = json(
      await cli(
        root,
        'query',
        '//function',
        '--limit',
        '2',
        '--cursor',
        first.nextCursor,
        '--json',
      ),
    );
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items[0].name).not.toBe(first.items[0].name);
    expect((await cli(root, 'query', '//function', '--limit', '0')).code).toBe(2);
  });

  test('a channel goes from add to test to index to retrieve', async () => {
    const root = makeProject();
    const added = await cli(root, 'channel', 'make', 'notes', NOTES_CHANNEL);
    expect(added.code).toBe(0);
    expect(added.out).toContain('registered notes');

    const scaffolded = await cli(root, 'channel', 'add', 'runbooks', '--template', 'file');
    expect(scaffolded.out).toContain('created .code-lens/channels/runbooks/transformer.ts');
    expect(existsSync(join(root, '.code-lens/channels/runbooks/transformer.ts'))).toBe(true);
    expect((await cli(root, 'channel', 'create', 'runbooks')).code).toBe(0);

    await cli(root, 'channel', 'remove', 'runbooks');
    const listed = await cli(root, 'channel', 'list', '--json');
    // biome-ignore lint/suspicious/noExplicitAny: asserting a JSON shape
    expect(json(listed).map((c: any) => c.name)).toEqual(
      expect.arrayContaining(['symbols', 'docs', 'notes']),
    );
    expect((await cli(root, 'channel', 'show', 'notes')).out).toContain('custom.note');
    expect((await cli(root, 'channel', 'show', 'ghost')).code).toBe(2);

    const tested = await cli(root, 'channel', 'test', 'notes', 'src/config.ts');
    expect(tested.code).toBe(0);
    expect(tested.out).toContain('does not claim');

    await cli(root, 'index');
    const indexed = await cli(root, 'channel', 'index', 'notes', '--json');
    expect(json(indexed).channel).toBe('notes');

    const found = json(
      await cli(root, 'retrieve', 'notes', 'who restarts the queue worker', '--json'),
    );
    expect(found.items[0].card.source.path).toBe('note:oncall');
    const shown = await cli(root, 'retrieve', 'notes', 'who restarts the queue worker');
    expect(shown.out).toContain('note:oncall');
    expect((await cli(root, 'retrieve', 'ghost', 'x')).code).not.toBe(0);
  });

  test('without a model the structural side still answers and dense says why it cannot', async () => {
    const root = makeProject();
    const own = { embedder: undefined, env: { CODE_LENS_MODELS: join(root, 'no-models') } };
    await cliWith(own, root, 'index', '--no-embed');
    const structural = await cliWith(own, root, 'query', '//function[@name="validate"]');
    expect(structural.code).toBe(0);
    expect(structural.out).toContain('validate');
    const dense = await cliWith(own, root, 'search', 'parse configuration');
    expect(dense.code).toBe(1);
    expect(dense.err).toContain('model');
  });
});

describe('grammars', () => {
  const wasm = Bun.resolveSync(
    'tree-sitter-typescript/tree-sitter-typescript.wasm',
    import.meta.dir,
  );

  test('a grammar is missing, installed offline from a file, then ready and pinned', async () => {
    const root = makeProject();
    const own = { grammars: { home: join(root, 'home') } };
    const before = await cliWith(own, root, 'grammar', 'list', '--json');
    // biome-ignore lint/suspicious/noExplicitAny: asserting a JSON shape
    const row = (ran: Ran) => json(ran).find((r: any) => r.language === 'typescript');
    expect(row(before).state).toBe('missing');

    const installed = await cliWith(own, root, 'grammar', 'install', 'typescript', '--from', wasm);
    expect(installed.code).toBe(0);
    expect(installed.out).toContain('recorded in the lockfile');
    expect(existsSync(join(root, '.code-lens/grammars/tree-sitter-typescript.wasm'))).toBe(true);
    expect(existsSync(join(root, '.code-lens/grammars.lock.json'))).toBe(true);

    const after = await cliWith(own, root, 'grammar', 'list', '--json');
    expect(row(after)).toMatchObject({ state: 'ready' });
    expect(row(after).detail).toContain('checksum locked');
  });

  test('an install with no source and no permission to download is a usage error', async () => {
    const root = makeProject();
    const refused = await cliWith(
      { grammars: { home: join(root, 'home') } },
      root,
      'grammar',
      'install',
      'python',
    );
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('--from');
    const unknown = await cliWith({}, root, 'grammar', 'install', 'klingon', '--from', wasm);
    expect(unknown.code).not.toBe(0);
  });
});

describe('mcp server', () => {
  async function connect(root: string) {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    let err = '';
    const served = serveMcp(
      {
        environment: {
          cwd: root,
          env: {},
          embedder,
          runtime,
          stdout: () => undefined,
          stderr: (t) => {
            err += t;
          },
        },
        parsed: parseOptions([]),
      },
      serverSide,
    );
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    return {
      client,
      stderr: () => err,
      close: async () => {
        await client.close();
        await served;
      },
    };
  }

  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return { isError: result.isError === true, body: JSON.parse(text) };
  };

  test('lists the tools, one retrieve tool per channel, and no lexical tools', async () => {
    const root = makeProject();
    await cli(root, 'channel', 'add', 'notes', NOTES_CHANNEL);
    const session = await connect(root);
    try {
      const names = (await session.client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'search',
          'retrieve_symbols',
          'retrieve_docs',
          'retrieve_notes',
          'query',
          'callers',
          'callees',
          'neighbors',
          'dependents',
          'explain',
          'diagnose',
          'status',
          'index',
        ]),
      );
      for (const banned of ['search_lexical', 'grep', 'get_symbol'])
        expect(names).not.toContain(banned);
    } finally {
      await session.close();
    }
  });

  test('answers index, search, retrieve_<channel>, explain and diagnose; errors are typed', async () => {
    const root = makeProject();
    await cli(root, 'channel', 'add', 'notes', NOTES_CHANNEL);
    const session = await connect(root);
    try {
      const { client } = session;
      const early = await call(client, 'search', { query: 'parse configuration' });
      expect(early.isError).toBe(true);
      expect(early.body.error.code).toMatch(/^RETRIEVER_/);

      const indexed = await call(client, 'index', {});
      expect(indexed.isError).toBe(false);

      const searched = await call(client, 'search', { query: 'parse the configuration file' });
      expect(searched.body.items[0].path).toBe('src/config.ts');
      expect(searched.body.items[0].card.text).toContain('untrusted');

      const notes = await call(client, 'retrieve_notes', {
        query: 'who restarts the queue worker',
      });
      expect(notes.body.items[0].card.source.path).toBe('note:oncall');
      expect(notes.body.items[0].card.text).toContain('untrusted');

      const paged = await call(client, 'query', { wql: '//function', limit: 1 });
      expect(paged.body.items).toHaveLength(1);
      expect(paged.body.limit.applied).toBe(1);

      expect((await call(client, 'explain', {})).body.index.files).toBeGreaterThan(0);
      const diagnosed = await call(client, 'diagnose', {
        query: 'parse the configuration file',
        path: 'src/config.ts',
      });
      expect(diagnosed.body.verdict).toBeString();
      expect((await call(client, 'status', {})).body.channels.length).toBeGreaterThan(2);

      const bad = await call(client, 'callers', { target: 'nowhere.ts:1' });
      expect(bad.isError).toBe(true);
      expect(bad.body.error.code).toMatch(/^RETRIEVER_/);
    } finally {
      await session.close();
    }
    expect(session.stderr()).toContain('code-lens mcp: serving');
  });
});
