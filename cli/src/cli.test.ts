import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type Embedder,
  ModelCache,
  nativeLanguageKeys,
  npmPackageSource,
  SyntaxRuntime,
} from '@cntxt-labs/anvesa-retriever';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';
import { serveMcp } from './mcp.ts';
import { parseOptions } from './options.ts';
import { renderIndex } from './render.ts';

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

/** The notes channel module, copied into the project so a test can change it. */
function ownCopyOfNotesChannel(root: string): string {
  const copy = join(root, 'notes-channel.ts');
  copyFileSync(NOTES_CHANNEL, copy);
  return copy;
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'anvesa-cli-'));
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

/**
 * Every registered language is parsed natively where the addon is built, so nothing would be
 * missing. These tests are about fetching and pinning wasm grammars, which is what a machine
 * without the addon does: they run with it turned off.
 */
function onWasmOnly(): void {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.ANVESA_DISABLE_NATIVE;
    process.env.ANVESA_DISABLE_NATIVE = '1';
  });
  afterEach(() => {
    if (before === undefined) delete process.env.ANVESA_DISABLE_NATIVE;
    else process.env.ANVESA_DISABLE_NATIVE = before;
  });
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

  test('<command> --help shows that command, not the whole help, and does not run it', async () => {
    const root = makeProject();
    const help = await cli(root, 'channel', 'add', '--help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('channel add|list|show|test|index|pin|remove');
    expect(help.out).not.toContain('grammar list');
    expect(existsSync(join(root, '.anvesa'))).toBe(false);
  });

  test('prints its version', async () => {
    const ran = await cli(makeProject(), '--version');
    expect(ran.code).toBe(0);
    expect(ran.out).toMatch(/^anvesa \d+\.\d+\.\d+/);
  });

  describe('init offers what this machine and project need', () => {
    onWasmOnly();
    /** A parser the fake registry serves: the smallest thing that is a WebAssembly module. */
    const WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const served: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      const address = String(url);
      served.push(address);
      const response = new Response(WASM, { headers: { 'content-length': String(WASM.length) } });
      Object.defineProperty(response, 'url', {
        value: address.replace('@latest', '@0.25.0'),
      });
      return response;
    }) as typeof fetch;

    /** A project with one Python file, and a home with no parsers or models in it. */
    function pythonProject(): { root: string; home: string; models: string } {
      const root = makeProject();
      writeFileSync(join(root, 'tool.py'), 'def run():\n    return 1\n');
      const home = mkdtempSync(join(tmpdir(), 'anvesa-home-'));
      const models = mkdtempSync(join(tmpdir(), 'anvesa-models-'));
      roots.push(home, models);
      return { root, home, models };
    }

    /** Answers to prompts, in order; the questions asked are kept. */
    function scripted(answers: string[]) {
      const asked: string[] = [];
      return {
        asked,
        prompt: async (question: string) => {
          asked.push(question);
          return answers.shift();
        },
      };
    }

    test('without a terminal or --yes it only says what it would do, and downloads nothing', async () => {
      const { root, home, models } = pythonProject();
      served.length = 0;
      const ran = await cliWith(
        { grammars: { home }, fetch: fakeFetch },
        root,
        'init',
        '--models',
        models,
      );
      expect(ran.code).toBe(0);
      expect(served).toEqual([]);
      expect(ran.out).toContain('encoder: not installed');
      expect(ran.out).toContain('anvesa model install');
      expect(ran.out).toContain('parser python: 1 files not indexed');
      expect(ran.out).toContain('anvesa grammar install python --user --download');
    });

    test('it asks which encoder, shows the whole list for this machine, and which one it recommends', async () => {
      const { root, home, models } = pythonProject();
      const dialogue = scripted(['s', 'n']);
      const ran = await cliWith(
        { grammars: { home }, fetch: fakeFetch, prompt: dialogue.prompt },
        root,
        'init',
        '--models',
        models,
      );
      expect(ran.code).toBe(0);
      expect(ran.err).toContain('This machine:');
      for (const id of ['all-MiniLM-L6-v2', 'bge-small-en-v1.5', 'jina-embeddings-v2-base-code']) {
        expect(ran.err).toContain(id);
      }
      expect(ran.err).toContain('recommended');
      expect(dialogue.asked[0]).toContain('Install which?');
      expect(dialogue.asked[1]).toContain('Download parsers');
      expect(ran.out).toContain('skipped at your request');
    });

    test('a parser picked from the list is downloaded with progress, and works afterwards', async () => {
      const { root, home, models } = pythonProject();
      served.length = 0;
      const dialogue = scripted(['s', 'python']);
      const ran = await cliWith(
        { grammars: { home }, fetch: fakeFetch, prompt: dialogue.prompt },
        root,
        'init',
        '--models',
        models,
      );
      expect(ran.code).toBe(0);
      expect(served).toEqual([
        'https://unpkg.com/tree-sitter-python@latest/tree-sitter-python.wasm',
      ]);
      expect(ran.err).toContain('python parser');
      expect(ran.err).toMatch(/100%/);
      expect(ran.out).toContain('parser python: installed');
      expect(existsSync(join(home, 'grammars', 'tree-sitter-python.wasm'))).toBe(true);
      const listed = json(await cliWith({ grammars: { home } }, root, 'grammar', 'list', '--json'));
      // biome-ignore lint/suspicious/noExplicitAny: asserting a JSON shape
      expect(listed.find((row: any) => row.language === 'python').state).toBe('ready');
    });

    test('a list of languages downloads only those; --no-network downloads nothing and says so', async () => {
      const { root, home, models } = pythonProject();
      served.length = 0;
      const none = await cliWith(
        { grammars: { home }, fetch: fakeFetch, prompt: scripted(['s', 'y']).prompt },
        root,
        'init',
        '--models',
        models,
        '--no-network',
      );
      expect(served).toEqual([]);
      expect(none.out).toContain('network use is off');

      const other = await cliWith(
        { grammars: { home }, fetch: fakeFetch, prompt: scripted(['s', 'ruby']).prompt },
        root,
        'init',
        '--models',
        models,
      );
      expect(served).toEqual([]);
      expect(other.out).toContain('parser python: 1 files not indexed');
    });

    test('a failed download is reported, not hidden, and does not stop init', async () => {
      const { root, home, models } = pythonProject();
      const broken = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
      const ran = await cliWith(
        { grammars: { home }, fetch: broken, prompt: scripted(['s', 'y']).prompt },
        root,
        'init',
        '--models',
        models,
      );
      expect(ran.code).toBe(0);
      expect(ran.out).toContain('parser python: download failed');
      expect(ran.out).toContain('503');
    });

    test('--model must be a built-in encoder or one installed here', async () => {
      const { root, home, models } = pythonProject();
      const ran = await cliWith(
        { grammars: { home } },
        root,
        'init',
        '--models',
        models,
        '--model',
        'nope',
      );
      expect(ran.code).toBe(2);
      expect(ran.err).toContain('bge-small-en-v1.5');
    });
  });

  test('init scaffolds the ignore file and both configs, keeps them on a second run, and --force overwrites', async () => {
    const root = makeProject();
    const first = await cli(root, 'init', '--json');
    expect(first.code).toBe(0);
    expect(json(first)).toMatchObject({
      created: ['.anvesaignore', '.anvesa/workspace.json', '.anvesa/config.json'],
      kept: [],
    });
    expect(readFileSync(join(root, '.anvesaignore'), 'utf8')).toContain('node_modules');
    expect(JSON.parse(readFileSync(join(root, '.anvesa/workspace.json'), 'utf8'))).toEqual({
      version: 1,
      packages: [],
      discover: true,
      exclude: [],
      nestedRepos: 'include',
      followSymlinks: false,
    });
    expect(JSON.parse(readFileSync(join(root, '.anvesa/config.json'), 'utf8'))).toEqual({
      channels: {},
    });
    // A scaffolded workspace.json is what index actually reads without erroring.
    expect((await cli(root, 'index')).code).toBe(0);

    writeFileSync(join(root, '.anvesaignore'), '# edited by hand\n');
    const second = await cli(root, 'init', '--json');
    expect(json(second)).toMatchObject({
      created: [],
      kept: ['.anvesaignore', '.anvesa/workspace.json', '.anvesa/config.json'],
    });
    expect(readFileSync(join(root, '.anvesaignore'), 'utf8')).toBe('# edited by hand\n');

    const forced = await cli(root, 'init', '--force', '--json');
    expect(json(forced)).toMatchObject({
      created: ['.anvesaignore', '.anvesa/workspace.json', '.anvesa/config.json'],
      kept: [],
    });
    expect(readFileSync(join(root, '.anvesaignore'), 'utf8')).toContain('node_modules');
  });

  test('index reports live progress on stderr, never on stdout', async () => {
    const root = makeProject();
    // Non-interactive (the default for a pipe or a log): a plain "linking" line, no \r rewriting.
    const piped = await cliWith({ isTTY: false }, root, 'index', '--json');
    expect(piped.code).toBe(0);
    expect(piped.err).toContain('linking');
    expect(piped.err).not.toContain('\r');
    expect(() => JSON.parse(piped.out)).not.toThrow();

    // A terminal: the running count is written in place with \r, ending in "— linking".
    const tty = await cliWith({ isTTY: true }, root, 'index', '--force');
    expect(tty.code).toBe(0);
    expect(tty.err).toContain('\r');
    expect(tty.err).toContain('indexing:');
    expect(tty.err).toContain('— linking\n');
  });

  test('index ends with what the index holds per channel, even when the run changed nothing', async () => {
    const root = makeProject();
    const first = await cli(root, 'index', '--json');
    const channels = JSON.parse(first.out).channels as {
      name: string;
      cards: number;
      sources: number;
    }[];
    const symbols = channels.find((channel) => channel.name === 'symbols');
    expect(symbols?.cards).toBeGreaterThan(0);
    expect(symbols?.sources).toBeGreaterThan(0);

    // A second run embeds nothing, but the totals still say what is there.
    const again = await cli(root, 'index');
    expect(again.out).toContain('index totals:');
    expect(again.out).toMatch(
      new RegExp(`\\n  symbols\\s+${symbols?.cards} cards?\\s+${symbols?.sources} files?`),
    );
  });

  test('index draws a bar against the files the walk listed, on a terminal', async () => {
    const root = makeProject();
    const tty = await cliWith({ isTTY: true }, root, 'index');
    expect(tty.err).toMatch(/indexing: \[[█░]{24}\] +\d+% {2}\d+\/\d+ files/);
    expect(tty.err).toMatch(/100% {2}(\d+)\/\1 files.* — linking\n/);
    const piped = await cliWith({ isTTY: false }, root, 'index', '--force');
    expect(piped.err).toMatch(/indexing: (\d+)\/\1 seen \(100%\)/);
  });

  test('index names the model and its embedding size, and --show-walk lists each path walked', async () => {
    const root = makeProject();
    const walked = await cliWith({ isTTY: false }, root, 'index', '--show-walk');
    expect(walked.code).toBe(0);
    expect(walked.out).toContain(
      `model: ${embedder.info.id} (embedding size ${embedder.info.dimensions}, ${embedder.info.maxTokens} max tokens)`,
    );
    expect(walked.err).toContain('walk: src/config.ts (added)');
    expect(walked.out).not.toContain('walk:');

    const again = await cliWith({ isTTY: true }, root, 'index', '--show-walk', '--json');
    expect(again.err).toMatch(/walk: src\/config.ts \((unchanged|touched)\)\n/);
    expect(JSON.parse(again.out).embedder).toEqual({
      id: embedder.info.id,
      dimensions: embedder.info.dimensions,
      maxTokens: embedder.info.maxTokens,
    });

    const quiet = await cli(root, 'index');
    expect(quiet.err).not.toContain('walk:');

    const own = { embedder: undefined, env: { ANVESA_MODELS: join(root, 'no-models') } };
    const bare = await cliWith(own, root, 'index', '--no-dense');
    expect(bare.out).toContain('model: none');
    expect(
      JSON.parse((await cliWith(own, root, 'index', '--no-dense', '--json')).out).embedder,
    ).toBeNull();
  });

  test('run from a subdirectory, a command finds the nearest project above it', async () => {
    const root = makeProject();
    expect((await cli(root, 'index')).code).toBe(0);
    const inside = join(root, 'src');
    const status = await cliWith({ cwd: inside }, inside, 'status', '--json');
    expect(status.code).toBe(0);
    expect(json(status).root).toBe(root);
    expect(existsSync(join(inside, '.anvesa'))).toBe(false);

    // --root still names the project exactly; init scaffolds where it is run, not above.
    const named = await cliWith({ cwd: inside }, inside, 'status', '--root', '.', '--json');
    expect(json(named).root).toBe(inside);
    expect((await cliWith({ cwd: inside }, inside, 'init', '--no-download')).code).toBe(0);
    expect(existsSync(join(inside, '.anvesa', 'config.json'))).toBe(true);
  });

  test('--scope narrows search, query and retrieve; a scope that can never match is a usage error', async () => {
    const root = makeProject();
    expect((await cli(root, 'index')).code).toBe(0);
    const paths = (ran: Ran) => [
      ...new Set(json(ran).items.map((item: { path: string }) => item.path)),
    ];
    const everywhere = paths(await cli(root, 'search', 'parse configuration', '--json'));
    expect(everywhere.length).toBeGreaterThan(1);
    expect(
      paths(await cli(root, 'search', 'parse configuration', '--scope', 'docs', '--json')),
    ).toEqual(['docs/guide.md']);
    expect(
      paths(await cli(root, 'query', '//function', '--scope', 'src/config.ts', '--json')),
    ).toEqual(['src/config.ts']);

    // Refused before anything is opened: no project is created where there was none.
    const fresh = mkdtempSync(join(tmpdir(), 'anvesa-cli-'));
    roots.push(fresh);
    for (const bad of ['../x', '/etc', 'C:/code']) {
      const refused = await cli(fresh, 'search', 'parse', '--scope', bad);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('--scope');
    }
    expect((await cli(fresh, 'index', '--scope', '../x')).code).toBe(2);
    expect(existsSync(join(fresh, '.anvesa'))).toBe(false);
  });

  test('index records the model it embedded with; another model is named, not a silent zero', async () => {
    const root = makeProject();
    const first = await cli(root, 'index');
    expect(first.code).toBe(0);
    expect(first.err).toContain('recorded "model": "test-words"');
    const config = JSON.parse(readFileSync(join(root, '.anvesa', 'config.json'), 'utf8'));
    expect(config.model).toBe('test-words');
    expect((await cli(root, 'index')).err).not.toContain('recorded');

    const other = { embedder: { ...embedder, info: { ...embedder.info, id: 'other-model' } } };
    const status = await cliWith(other, root, 'status');
    expect(status.out).toContain('embedded with: test-words');
    expect(status.out).toContain(
      'warning: the index was embedded with test-words, not other-model',
    );
    const searched = await cliWith(other, root, 'search', 'parse the configuration file');
    expect(searched.code).toBe(1);
    expect(searched.err).toContain('RETRIEVER_MODEL_MISMATCH');
    expect(searched.err).toContain('--model test-words');
  });

  test('init --model takes a model the user installed, and records it', async () => {
    const root = makeProject();
    const models = join(root, 'models');
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'model.onnx'), 'a stand-in graph');
    copyFileSync(
      resolve(import.meta.dir, '../../embedder/src/__fixtures__/bpe.tokenizer.json'),
      join(source, 'tokenizer.json'),
    );
    await new ModelCache(models).installCustom({
      id: 'my-encoder',
      maxTokens: 128,
      pooling: 'cls',
      source,
      files: { model: join(source, 'model.onnx'), tokenizer: join(source, 'tokenizer.json') },
      validate: async () => 8,
    });

    const ran = await cli(
      root,
      'init',
      '--no-download',
      '--models',
      models,
      '--model',
      'my-encoder',
    );
    expect(ran.code).toBe(0);
    const config = JSON.parse(readFileSync(join(root, '.anvesa', 'config.json'), 'utf8'));
    expect(config.model).toBe('my-encoder');
    expect((await cli(root, 'model', 'verify', 'my-encoder', '--models', models)).code).toBe(0);

    const unknown = await cli(
      root,
      'init',
      '--no-download',
      '--models',
      models,
      '--model',
      'ghost',
    );
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('my-encoder');
  });

  test('where names the project in use, how it was found, and its paths', async () => {
    const root = makeProject();
    const inside = join(root, 'src');
    const bare = await cliWith({ cwd: inside }, inside, 'where');
    expect(bare.code).toBe(0);
    expect(bare.out).toContain(`root    ${inside} (no project here or above; current directory)`);
    expect(bare.out).toContain('(not created; defaults in use)');
    expect(existsSync(join(inside, '.anvesa'))).toBe(false);

    expect((await cli(root, 'index')).code).toBe(0);
    const found = await cliWith({ cwd: inside }, inside, 'where');
    expect(found.out).toContain(`root    ${root} (nearest project above ${inside})`);
    const config = join(root, '.anvesa', 'config.json');
    expect((await cliWith({ cwd: inside }, inside, 'where', 'config')).out).toBe(`${config}\n`);
    expect(json(await cliWith({ cwd: inside }, inside, 'where', '--json'))).toMatchObject({
      root,
      config,
      index: join(root, '.anvesa', 'index.db'),
      sharded: false,
    });
    expect(json(await cli(root, 'where', '--root', 'src', '--json')).foundBy).toBe(
      'named by --root',
    );
    expect((await cli(root, 'where', 'nope')).code).toBe(2);

    // A config that does not validate is still located, and said to be invalid.
    mkdirSync(join(root, '.anvesa'), { recursive: true });
    writeFileSync(config, '{ not json');
    const broken = await cli(root, 'where');
    expect(broken.code).toBe(0);
    expect(broken.out).toContain('(invalid:');
  });

  test('a slow model is never mistaken for a stall: progress names the file being embedded', async () => {
    const root = makeProject();
    const slow: Embedder = {
      ...embedder,
      embed: async (texts) => {
        await Bun.sleep(40);
        return embedder.embed(texts);
      },
    };
    const piped = await cliWith(
      { isTTY: false, embedder: slow, progressIntervalMs: 15 },
      root,
      'index',
    );
    expect(piped.code).toBe(0);
    expect(piped.err).toMatch(/— embedding (src|docs)\/\S+ \(\d+ s on it\), \d+ s in\n/);
    // The last line before linking says how much was embedded.
    expect(piped.err).toMatch(/embedded \(\d+ cards\) — linking\n/);

    const tty = await cliWith({ isTTY: true, embedder: slow }, root, 'index', '--force');
    expect(tty.err).toMatch(/\d+ embedded \(\d+ cards\)/);
  });

  test('an index that cannot be upgraded names the copy it took first', async () => {
    const root = makeProject();
    expect((await cli(root, 'index')).code).toBe(0);
    // Wind the version back on a file whose tables are a whole schema ahead: the next open takes
    // its copy first, then cannot finish, and has to say where the copy is.
    const path = join(root, '.anvesa', 'index.db');
    const raw = new Database(path);
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    const failed = await cli(root, 'status');
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain(`${path}.backup-v1`);
    expect(existsSync(`${path}.backup-v1`)).toBe(true);
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

  test('--no-dense is --no-embed by another name', async () => {
    expect(parseOptions(['--no-dense']).values['no-embed']).toBe(true);
    const root = makeProject();
    const own = { embedder: undefined, env: { ANVESA_MODELS: join(root, 'no-models') } };
    const indexed = await cliWith(own, root, 'index', '--json', '--no-dense');
    expect(indexed.code).toBe(0);
    expect(JSON.parse(indexed.out).report.complete).toBe(true);
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
    // The rank-based fused score is not a confidence signal; bestScore is.
    expect(search.items[0].bestScore).toBeGreaterThan(0);

    const text = await cli(root, 'search', 'parse the configuration file');
    expect(text.out).toContain('src/config.ts');
    expect(text.out).toContain('untrusted');
    expect(text.out).toMatch(/best \d\.\d{3}/);

    const structural = json(await cli(root, 'query', '//function[@name="validate"]', '--json'));
    // biome-ignore lint/suspicious/noExplicitAny: asserting a JSON shape
    expect(structural.items.map((h: any) => h.name)).toEqual(['validate']);

    const callers = json(await cli(root, 'callers', 'validate', '--json'));
    expect(JSON.stringify(callers)).toContain('src/config.ts');

    // In text, a caller or callee says where it is, what it looks like, and where the call is.
    const callerText = (await cli(root, 'callers', 'validate')).out;
    expect(callerText).toMatch(/callers of src\/config\.ts#validate\s+src\/config\.ts:\d+/);
    expect(callerText).toMatch(/parseConfig\s+src\/config\.ts:\d+(-\d+)?\s+parseConfig\(text/);
    expect(callerText).toContain('calls at :2');
    const calleeText = (await cli(root, 'callees', 'parseConfig')).out;
    expect(calleeText).toMatch(
      /validate\s+src\/config\.ts:\d+(-\d+)?\s+validate\(text.*\(resolved\)\s+calls at :2/,
    );

    const dependents = json(await cli(root, 'dependents', 'src/config.ts', '--json'));
    expect(JSON.stringify(dependents)).toContain('src/server.ts');

    const limitedDependents = json(
      await cli(root, 'dependents', 'src/config.ts', '--limit', '1', '--json'),
    ) as { dependents: Array<unknown> };
    expect(limitedDependents.dependents).toHaveLength(1);

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

  test('a search can leave a lane out or weigh it, and a bad weight is a usage error', async () => {
    const root = makeProject();
    await cli(root, 'index');
    const question = 'run the installer to set the service up';
    const lanes = async (...extra: string[]) =>
      (
        json(await cli(root, 'search', question, '--json', ...extra)).lanes as { name: string }[]
      ).map((l) => l.name);
    expect(await lanes()).toEqual(expect.arrayContaining(['symbols', 'docs']));
    expect(await lanes('--exclude', 'docs')).toEqual(['symbols']);
    expect(await lanes('--weight', 'docs=0')).toEqual(['symbols']);
    expect(await lanes('--weight', 'symbols=0.5', '--weight', 'docs=2')).toEqual(
      expect.arrayContaining(['symbols', 'docs']),
    );
    for (const bad of ['docs', 'docs=x', '=1', 'docs=-1']) {
      expect((await cli(root, 'search', question, '--weight', bad)).code).toBe(2);
    }
    expect((await cli(root, 'search', question, '--exclude', 'nope')).code).toBe(2);
  });

  test('conjunction queries combine semantic intent and WQL constraints via CLI', async () => {
    const root = makeProject();
    await cli(root, 'index');

    // 1. search with --wql flag
    const searchFlag = json(
      await cli(root, 'search', 'listen requests', '--wql', '//function', '--json'),
    );
    expect(searchFlag.conjunction).toEqual({ semantic: 'listen requests', wql: '//function' });
    expect(searchFlag.items[0].title).toBe('startServer');

    // 2. search with inline &&
    const searchInline = json(await cli(root, 'search', 'listen requests && //function', '--json'));
    expect(searchInline.conjunction).toEqual({ semantic: 'listen requests', wql: '//function' });
    expect(searchInline.items[0].title).toBe('startServer');

    // 3. search text output displays conjunction header
    const searchText = (await cli(root, 'search', 'listen requests && //function')).out;
    expect(searchText).toContain('conjunction: semantic "listen requests" && wql "//function"');

    // 4. query with --semantic flag
    const queryFlag = json(
      await cli(root, 'query', '//function', '--semantic', 'listen requests', '--json'),
    );
    expect(queryFlag.conjunction).toEqual({ semantic: 'listen requests', wql: '//function' });
    expect(queryFlag.items[0].name).toBe('startServer');
    expect(queryFlag.items[0].score).toBeGreaterThan(0);

    // 5. query with inline &&
    const queryInline = json(await cli(root, 'query', '//function && listen requests', '--json'));
    expect(queryInline.conjunction).toEqual({ semantic: 'listen requests', wql: '//function' });
    expect(queryInline.items[0].name).toBe('startServer');

    // 6. query text output displays conjunction header and score
    const queryText = (await cli(root, 'query', '//function && listen requests')).out;
    expect(queryText).toContain('conjunction: semantic "listen requests" && wql "//function"');
    expect(queryText).toMatch(/score \d\.\d{3}/);
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
    expect(scaffolded.out).toContain('created .anvesa/channels/runbooks/transformer.ts');
    expect(existsSync(join(root, '.anvesa/channels/runbooks/transformer.ts'))).toBe(true);
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

  test('channel index takes an async source, names why a record failed, and exits 1', async () => {
    const root = makeProject();
    const module = ownCopyOfNotesChannel(root);
    const text = readFileSync(module, 'utf8')
      .replace(
        'transform: (file: InputFile) => [',
        "transform: (file: InputFile) => (file.path === 'note:deploy' ? boom() : [",
      )
      .replace('attrs: { title: file.path } },\n  ],', 'attrs: { title: file.path } },\n  ]),')
      .replace('  files: () => [', '  files: async () => [')
      .concat("\nfunction boom(): never {\n  throw new Error('boom on deploy');\n}\n");
    writeFileSync(module, text);
    await cli(root, 'channel', 'add', 'notes', module);
    const indexed = await cli(root, 'channel', 'index', 'notes');
    expect(indexed.out).toContain('1 FAILED');
    expect(indexed.out).toContain('boom on deploy');
    expect(indexed.err).toContain('CLI_COMMAND_FAILED');
    expect(indexed.code).toBe(1);
  });

  test('a pinned channel module loads only while it has the bytes that were pinned', async () => {
    const root = makeProject();
    const module = ownCopyOfNotesChannel(root);
    await cli(root, 'channel', 'add', 'notes', module);
    expect((await cli(root, 'channel', 'list')).out).toContain('module not pinned');

    const pinned = json(await cli(root, 'channel', 'pin', 'notes', '--json'));
    expect(pinned.sha256).toMatch(/^[0-9a-f]{64}$/);
    const listed = await cli(root, 'channel', 'list');
    expect(listed.code).toBe(0);
    expect(listed.out).not.toContain('module not pinned');

    writeFileSync(module, `${readFileSync(module, 'utf8')}\n// changed after review\n`);
    // The changed module is not run: what needs the channel fails, and says why.
    const refused = await cli(root, 'channel', 'index', 'notes');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('RETRIEVER_CHANNEL_MODULE');
    expect(refused.err).toContain('checksum does not match');
    // Seeing which module is the problem, and questions that run no channel code, still work.
    const shown = await cli(root, 'channel', 'list');
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('not loaded:');
    expect(shown.out).toContain('checksum does not match');
    expect((await cli(root, 'status')).code).toBe(0);

    expect((await cli(root, 'channel', 'pin', 'notes')).code).toBe(0);
    expect((await cli(root, 'channel', 'list')).code).toBe(0);
  });

  test('a project that requires checksums refuses a module that is not pinned', async () => {
    const root = makeProject();
    const module = ownCopyOfNotesChannel(root);
    await cli(root, 'channel', 'add', 'notes', module);
    const configPath = join(root, '.anvesa/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, security: { requireChecksums: true } }));
    const refused = await cli(root, 'channel', 'index', 'notes');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('not pinned');
    expect(refused.err).toContain('anvesa channel pin notes');
    const listed = await cli(root, 'channel', 'list');
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('not loaded:');

    writeFileSync(configPath, JSON.stringify(config));
    await cli(root, 'channel', 'pin', 'notes');
    writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(configPath, 'utf8')),
        security: { requireChecksums: true },
      }),
    );
    expect((await cli(root, 'channel', 'list')).code).toBe(0);
  });

  test('--no-network proves that nothing was attempted, and refuses --download', async () => {
    const root = makeProject();
    const ran = await cli(root, 'index', '--no-network');
    expect(ran.code).toBe(0);
    expect(ran.err).toContain('network audit: no outbound connection was attempted');

    const quiet = await cli(root, 'status', '--no-network', '--json');
    expect(quiet.code).toBe(0);
    expect(quiet.err).toBe('');
    expect(() => json(quiet)).not.toThrow();

    const download = await cli(
      root,
      'model',
      'install',
      'bge-small-en-v1.5',
      '--download',
      '--no-network',
    );
    expect(download.code).toBe(2);
    expect(download.err).toContain('--no-network');

    const viaEnvironment = await cliWith({ env: { ANVESA_NO_NETWORK: '1' } }, root, 'status');
    expect(viaEnvironment.err).toContain('network audit');
  });

  test('a channel module that reaches for the network is stopped, and the run fails', async () => {
    const root = makeProject();
    const module = join(root, 'phone-home.ts');
    writeFileSync(
      module,
      readFileSync(NOTES_CHANNEL, 'utf8').replace(
        'export default',
        "await fetch('https://collector.example/notes').catch(() => undefined);\nexport default",
      ),
    );
    await cli(root, 'channel', 'add', 'notes', module);
    const blocked = await cli(root, 'channel', 'list', '--no-network');
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain('CLI_NETWORK_BLOCKED');
    expect(blocked.err).toContain('collector.example');
  });

  test('channel index on a channel that claims files keeps the cards `index` built', async () => {
    const root = makeProject();
    writeFileSync(join(root, 'oncall.txt'), 'To restart the queue worker, page the SRE on call.');
    expect((await cli(root, 'channel', 'add', 'runbooks')).code).toBe(0);
    expect((await cli(root, 'index')).code).toBe(0);
    const before = json(
      await cli(root, 'retrieve', 'runbooks', 'restart the queue worker', '--json'),
    );
    expect(before.items.length).toBeGreaterThan(0);

    const synced = await cli(root, 'channel', 'index', 'runbooks', '--json');
    expect(synced.code).toBe(0);
    expect(json(synced).removed).toEqual([]);
    const after = json(
      await cli(root, 'retrieve', 'runbooks', 'restart the queue worker', '--json'),
    );
    expect(after.items.length).toBe(before.items.length);
  });

  test('without a model the structural side still answers and dense says why it cannot', async () => {
    const root = makeProject();
    const own = { embedder: undefined, env: { ANVESA_MODELS: join(root, 'no-models') } };
    await cliWith(own, root, 'index', '--no-embed');
    const structural = await cliWith(own, root, 'query', '//function[@name="validate"]');
    expect(structural.code).toBe(0);
    expect(structural.out).toContain('validate');
    const dense = await cliWith(own, root, 'search', 'parse configuration');
    expect(dense.code).toBe(1);
    expect(dense.err).toContain('model');
  });
});

describe('native grammars', () => {
  test.skipIf(!nativeLanguageKeys().has('python'))(
    'a language compiled into the addon is ready without any wasm file',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'anvesa-native-'));
      const listed = await cliWith(
        { grammars: { npmFrom: import.meta.filename, home: join(root, 'home') } },
        root,
        'grammar',
        'list',
        '--json',
      );
      expect(listed.code).toBe(0);
      const rows = json(listed) as {
        language: string;
        state: string;
        detail: string;
        mapped?: boolean;
      }[];
      for (const language of ['python', 'go', 'rust', 'java', 'php', 'ruby', 'cpp']) {
        expect(rows.find((row) => row.language === language)).toMatchObject({
          state: 'ready',
          detail: 'native (compiled into the addon)',
          mapped: true,
        });
      }
      // Compiled in, and parseable, but nothing turns its parses into outlines yet: say so
      // rather than claiming it can be indexed.
      expect(rows.find((row) => row.language === 'csharp')).toMatchObject({
        state: 'ready',
        detail: 'native (compiled into the addon)',
        mapped: false,
      });

      const rendered = await cliWith(
        { grammars: { npmFrom: import.meta.filename, home: join(root, 'home') } },
        root,
        'grammar',
        'list',
      );
      expect(rendered.out).toContain('* python');
      expect(rendered.out).toContain('no structural mapping: cannot be indexed');
      expect(rendered.out).not.toContain('* csharp');
      rmSync(root, { recursive: true, force: true });
    },
  );
});

describe('grammars', () => {
  onWasmOnly();
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
    expect(existsSync(join(root, '.anvesa/grammars/tree-sitter-typescript.wasm'))).toBe(true);
    expect(existsSync(join(root, '.anvesa/grammars.lock.json'))).toBe(true);

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

describe('bringing your own model', () => {
  test('a name that is not built in needs a source, and a bad pooling is a usage error', async () => {
    const root = makeProject();
    const cache = join(root, 'models');
    const noSource = await cliWith({}, root, 'model', 'install', 'mine', '--models', cache);
    expect(noSource.code).toBe(2);
    const noFrom = await cliWith(
      {},
      root,
      'model',
      'install',
      'mine',
      '--download',
      '--models',
      cache,
    );
    expect(noFrom.code).toBe(2);
    expect(noFrom.err).toContain('bring in your own');
    const bad = await cliWith(
      {},
      root,
      'model',
      'install',
      'mine',
      '--from',
      root,
      '--pooling',
      'max',
      '--models',
      cache,
    );
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('mean or cls');
    const listed = await cliWith({}, root, 'model', 'list', '--json', '--models', cache);
    expect(json(listed).map((m: { id: string }) => m.id)).not.toContain('mine');
  });

  // The real thing, where a MiniLM is at hand (ANVESA_TEST_MODELS, as the embedder tests).
  const library = process.env.ANVESA_TEST_MODELS;
  (library ? test : test.skip)(
    'installs from a folder, lists it, verifies it, pins it, and indexes with it',
    async () => {
      const root = makeProject();
      const cache = join(root, 'models');
      const source = join(library as string, 'all-MiniLM-L6-v2');
      const args = ['--models', cache];

      const installed = await cliWith(
        {},
        root,
        'model',
        'install',
        'mine',
        '--from',
        source,
        '--pooling',
        'mean',
        '--max-tokens',
        '256',
        ...args,
      );
      expect(installed.code).toBe(0);
      const listed = json(await cliWith({}, root, 'model', 'list', '--json', ...args));
      const mine = listed.find((m: { id: string }) => m.id === 'mine');
      expect(mine).toMatchObject({ installed: true, dimensions: 384, maxTokens: 256 });
      expect(mine.tier).toBeUndefined();
      expect((await cliWith({}, root, 'model', 'list', ...args)).out).toContain('custom');
      expect((await cliWith({}, root, 'model', 'verify', 'mine', ...args)).code).toBe(0);
      expect((await cliWith({}, root, 'model', 'verify', 'ghost', ...args)).code).toBe(2);

      // Dense indexing with it, through the real embedder, not the test double.
      const noDouble = { embedder: undefined, runtime };
      const indexed = await cliWith(noDouble, root, 'index', '--model', 'mine', ...args);
      expect(indexed.code).toBe(0);
      expect(indexed.out).toContain('dense:');
      const found = json(
        await cliWith(
          noDouble,
          root,
          'search',
          'parse the configuration file',
          '--model',
          'mine',
          '--json',
          ...args,
        ),
      );
      expect(found.items[0].path).toBe('src/config.ts');
    },
  );
});

describe('teaching it a language', () => {
  // C# has no bundled mapping (its grammar needs more than a mapping can say), so it stands for any
  // language a person teaches.
  const CSHARP = {
    'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    'server/Server.cs': `namespace App;

/// <summary>Answers requests.</summary>
public class Server
{
    private readonly string addr;

    public Server(string addr) { this.addr = addr; }

    /// <summary>Starts listening and blocks.</summary>
    public int Serve()
    {
        for (var i = 0; i < 3; i++) { Log(addr); }
        return 1;
    }

    public string Addr() { return addr; }

    private void Log(string text) { System.Console.WriteLine(text); }
}
`,
    'server/Config.cs': `namespace App;

public class Config
{
    /// <summary>Reads settings from the environment.</summary>
    public static Server Load()
    {
        var addr = System.Environment.GetEnvironmentVariable("ADDR");
        if (addr == null) { addr = ":8080"; }
        return new Server(addr);
    }

    public static int Helper(int x)
    {
        while (x < 10) { x += 1; }
        return x;
    }
}

public interface IThing { void Run(); }
`,
  };

  function csharpProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'anvesa-cs-'));
    roots.push(root);
    for (const [path, text] of Object.entries(CSHARP)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  const own = (root: string) => ({
    grammars: { npmFrom: import.meta.filename, home: join(root, 'home') },
  });

  test('without a mapping a language has no outline; a learned one gives it symbols, and is pinned', async () => {
    const root = csharpProject();
    const options = own(root);
    await cliWith(options, root, 'index', '--no-embed');
    const before = await cliWith(options, root, 'query', '//method', '--json');
    expect(before.code === 0 ? json(before).items : []).toEqual([]);

    const dry = await cliWith(
      options,
      root,
      'mapping',
      'train',
      'csharp',
      '--samples',
      'server',
      '--min-samples',
      '1',
      '--dry-run',
      '--json',
    );
    expect(dry.code).toBe(0);
    expect(json(dry).stored).toBeUndefined();
    expect(existsSync(join(root, '.anvesa', 'mappings', 'csharp.json'))).toBe(false);

    const trained = await cliWith(
      options,
      root,
      'mapping',
      'train',
      'csharp',
      '--samples',
      'server',
      '--min-samples',
      '1',
    );
    expect(trained.code).toBe(0);
    expect(trained.out).toContain('method_declaration');
    expect(trained.out).toContain('class_declaration');
    expect(trained.out).toContain('kept in project');
    expect(existsSync(join(root, '.anvesa', 'mappings', 'csharp.json'))).toBe(true);
    expect(existsSync(join(root, '.anvesa', 'mappings', 'csharp.golden.json'))).toBe(true);
    expect(existsSync(join(root, '.anvesa', 'mappings.lock.json'))).toBe(true);

    const listed = json(await cliWith(options, root, 'mapping', 'list', '--json'));
    // biome-ignore lint/suspicious/noExplicitAny: asserting a JSON shape
    const learned = listed.find((m: any) => m.mapping.name === 'csharp');
    expect(learned).toMatchObject({ tier: 'project', languages: ['csharp'] });
    // biome-ignore lint/suspicious/noExplicitAny: asserting a JSON shape
    expect(listed.some((m: any) => m.tier === 'bundled' && m.mapping.name === 'python')).toBe(true);

    const indexed = await cliWith(options, root, 'index', '--no-embed', '--force');
    expect(indexed.code).toBe(0);
    const found = json(await cliWith(options, root, 'query', '//method[@name="Serve"]', '--json'));
    expect(found.items.map((hit: { path: string }) => hit.path)).toEqual(['server/Server.cs']);
    const classes = json(await cliWith(options, root, 'query', '//class', '--json'));
    expect(classes.items.map((hit: { name: string }) => hit.name).sort()).toEqual([
      'Config',
      'Server',
    ]);
    expect((await cliWith(options, root, 'mapping', 'verify')).code).toBe(0);
    expect((await cliWith(options, root, 'mapping', 'check', 'csharp')).code).toBe(0);
    const shown = await cliWith(options, root, 'mapping', 'show', 'csharp');
    expect(JSON.parse(shown.out).nodeTypeMap.class_declaration).toBe('class');
  });

  test('every path after --samples is a sample, and too few samples is refused', async () => {
    const root = csharpProject();
    const options = own(root);
    const both = await cliWith(
      options,
      root,
      'mapping',
      'train',
      'csharp',
      '--samples',
      'server/Server.cs',
      'server/Config.cs',
      '--min-samples',
      '1',
      '--dry-run',
      '--json',
    );
    expect(both.code).toBe(0);
    expect(json(both).samples).toBe(2);

    const few = await cliWith(options, root, 'mapping', 'train', 'csharp', '--samples', 'server');
    expect(few.code).toBe(1);
    expect(few.err).toContain('too few to trust');
    expect(existsSync(join(root, '.anvesa', 'mappings', 'csharp.json'))).toBe(false);
  });

  test('--assist asks a model with the key from the environment, and reports what it rejected', async () => {
    const root = csharpProject();
    const train = ['mapping', 'train', 'csharp', '--samples', 'server', '--min-samples', '1'];
    const missing = await cliWith(own(root), root, ...train, '--assist');
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('OPENROUTER_API_KEY');
    const offline = await cliWith(
      { ...own(root), env: { OPENROUTER_API_KEY: 'k', ANVESA_NO_NETWORK: '1' } },
      root,
      ...train,
      '--assist',
    );
    expect(offline.code).toBe(2);

    let authorization = '';
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      authorization = (init.headers as Record<string, string>).authorization ?? '';
      const prompt: string = JSON.parse(String(init.body)).messages.at(-1).content;
      const lastLine = prompt.split(String.fromCharCode(10)).at(-1) ?? '[]';
      const asked = JSON.parse(lastLine) as { type: string }[];
      const suggestions = [
        { type: asked[0]?.type, tag: 'none' },
        { type: 'invented_node', tag: 'class', nameChild: 'identifier' },
      ];
      const content = JSON.stringify({ suggestions });
      return new Response(
        JSON.stringify({ model: 'vendor/model-a', choices: [{ message: { content } }] }),
      );
    }) as unknown as typeof fetch;
    const ran = await cliWith(
      { ...own(root), env: { OPENROUTER_API_KEY: 'secret-test-key' }, fetch: fakeFetch },
      root,
      ...train,
      '--assist',
      '--dry-run',
    );
    expect(ran.code).toBe(0);
    expect(authorization).toBe('Bearer secret-test-key');
    expect(ran.out).toContain('assistant vendor/model-a: asked about');
    expect(ran.out).toContain('invented_node');
    const kept = readFileSync(join(root, '.anvesa', 'assist', 'csharp.json'), 'utf8');
    expect(kept).not.toContain('secret-test-key');
  });

  test('--tags reads the grammar’s own definitions before the heuristics', async () => {
    const root = csharpProject();
    const query = [
      '(class_declaration name: (identifier) @name) @definition.class',
      '(method_declaration name: (identifier) @name) @definition.method',
      '(struct_declaration name: (identifier) @name) @definition.struct',
    ].join('\n');
    writeFileSync(join(root, 'tags.scm'), query);
    const ran = await cliWith(
      own(root),
      root,
      'mapping',
      'train',
      'csharp',
      '--samples',
      'server',
      '--min-samples',
      '1',
      '--tags',
      'tags.scm',
    );
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('tags.scm: 3 rules; 2 used');
    expect(ran.out).toContain('struct_declaration');
    expect(ran.out).toContain('does not occur in the samples');
    const shown = JSON.parse((await cliWith(own(root), root, 'mapping', 'show', 'csharp')).out);
    expect(shown.nodeTypeMap.method_declaration).toBe('method');
    const missing = await cliWith(
      own(root),
      root,
      'mapping',
      'train',
      'csharp',
      '--samples',
      'server',
      '--tags',
      'nope.scm',
    );
    expect(missing.code).toBe(2);
  });

  test('a mapping that was changed after it was recorded stops everything, until it is recorded again', async () => {
    const root = csharpProject();
    const options = own(root);
    await cliWith(
      options,
      root,
      'mapping',
      'train',
      'csharp',
      '--samples',
      'server',
      '--min-samples',
      '1',
    );
    const path = join(root, '.anvesa', 'mappings', 'csharp.json');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('"method"', '"func"'));

    const index = await cliWith(options, root, 'index', '--no-embed');
    expect(index.code).toBe(1);
    expect(index.err).toContain('STRUCTURAL_MAPPING_INTEGRITY');
    expect(index.err).toContain('differs from the recorded checksum');

    const verify = await cliWith(options, root, 'mapping', 'verify');
    expect(verify.code).toBe(1);
    expect(verify.err).toContain('csharp is modified');
    expect((await cliWith(options, root, 'mapping', 'lock', 'csharp')).code).toBe(0);
    expect((await cliWith(options, root, 'mapping', 'verify')).code).toBe(0);
    // Recorded, so it is used; and what it now says is no longer what was learned.
    expect((await cliWith(options, root, 'index', '--no-embed')).code).toBe(0);
    const check = await cliWith(options, root, 'mapping', 'check', 'csharp');
    expect(check.code).toBe(1);
    expect(check.err).toContain('no longer come out as recorded');
  });

  test('forking a bundled mapping gives one to edit, and removing it goes back to the bundled one', async () => {
    const root = csharpProject();
    const options = own(root);
    const forked = await cliWith(options, root, 'mapping', 'fork', 'python', '--json');
    expect(forked.code).toBe(0);
    expect(existsSync(join(root, '.anvesa', 'mappings', 'python.json'))).toBe(true);
    type Listed = { mapping: { name: string }; tier: string };
    const inEffect = (ran: Ran) =>
      (json(ran) as Listed[]).filter((m) => m.mapping.name === 'python').map((m) => m.tier);
    expect(inEffect(await cliWith(options, root, 'mapping', 'list', '--json'))).toEqual([
      'bundled',
      'project',
    ]);
    expect((await cliWith(options, root, 'mapping', 'remove', 'python')).out).toContain('removed');
    expect(inEffect(await cliWith(options, root, 'mapping', 'list', '--json'))).toEqual([
      'bundled',
    ]);
    expect((await cliWith(options, root, 'mapping', 'show', 'klingon')).code).toBe(2);
    expect((await cliWith(options, root, 'mapping', 'train', 'csharp')).code).toBe(2);
    expect(
      (await cliWith(options, root, 'mapping', 'train', 'csharp', '--samples', 'nowhere')).code,
    ).toBe(2);
  });
});

describe('sharded indexing', () => {
  test('is proposed from the index, turned on, built, kept in step with the manifest, and turned off', async () => {
    const root = makeProject();
    await cli(root, 'index');
    const before = json(await cli(root, 'search', 'parse the configuration file', '--json'));

    const proposed = await cli(root, 'fragments', 'propose', '--json');
    expect(proposed.code).toBe(0);
    expect(Object.keys(json(proposed).manifest.fragments).sort()).toEqual(['docs', 'root', 'src']);
    expect(existsSync(join(root, '.anvesa', 'fragments.json'))).toBe(false);
    const text = await cli(root, 'fragments', 'propose');
    expect(text.out).toContain('not written');
    expect((await cli(root, 'fragments', 'propose', '--tier', 'nope')).code).toBe(2);
    expect((await cli(root, 'fragments', 'propose', '--resolution', '0')).code).toBe(2);
    expect((await cli(root, 'fragments', 'propose', '--tier', 'clusters', '--json')).code).toBe(0);

    const off = await cli(root, 'fragments', 'status');
    expect(off.out).toContain('sharded indexing is off');

    const enabled = await cli(root, 'fragments', 'enable');
    expect(enabled.code).toBe(0);
    expect(existsSync(join(root, '.anvesa', 'fragments.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, '.anvesa', 'config.json'), 'utf8')).indexing).toEqual(
      {
        fragments: 'on',
      },
    );
    // Proposing again would replace what every machine follows.
    const again = await cli(root, 'fragments', 'propose', '--write');
    expect(again.code).toBe(1);
    expect(again.err).toContain('CLI_COMMAND_FAILED');
    expect((await cli(root, 'fragments', 'propose', '--write', '--force')).code).toBe(0);

    const built = await cli(root, 'index');
    expect(built.code).toBe(0);
    expect(existsSync(join(root, '.anvesa', 'shards', 'src.db'))).toBe(true);
    const after = json(await cli(root, 'search', 'parse the configuration file', '--json'));
    expect(after.items.map((r: { path: string }) => r.path)).toEqual(
      before.items.map((r: { path: string }) => r.path),
    );

    const status = await cli(root, 'fragments', 'status');
    expect(status.out).toContain('sharded by path-prior@1');
    expect(status.out).toContain('every file is where the manifest says');
    const statusJson = json(await cli(root, 'fragments', 'status', '--json'));
    expect(statusJson.drift.shards.map((s: { id: string }) => s.id)).toEqual(['docs', 'src']);

    // A committed change to the manifest is noticed, and acted on by the next index.
    const path = join(root, '.anvesa', 'fragments.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.overrides = { 'src/server.ts': 'docs' };
    writeFileSync(path, JSON.stringify(manifest));
    const drifted = await cli(root, 'fragments', 'status');
    expect(drifted.out).toContain('misplaced: src/server.ts is in src, belongs in docs');
    const settled = await cli(root, 'fragments', 'settle');
    expect(settled.out).toContain('1 files');
    await cli(root, 'index');
    expect((await cli(root, 'fragments', 'status')).out).toContain(
      'every file is where the manifest says',
    );
    const moved = json(await cli(root, 'query', '//function[@name="startServer"]', '--json'));
    expect(moved.items.map((h: { path: string }) => h.path)).toEqual(['src/server.ts']);

    const disabled = await cli(root, 'fragments', 'disable');
    expect(disabled.code).toBe(0);
    expect((await cli(root, 'fragments', 'status')).out).toContain('sharded indexing is off');
    // Turned off on purpose, the manifest that stays behind is not warned about.
    expect((await cli(root, 'index', '--force')).out).not.toContain('is not used');
    expect((await cli(root, 'fragments', 'frobnicate')).code).toBe(2);
  });

  test('a manifest the config never turned on is warned about by index, until a choice is made', async () => {
    const root = makeProject();
    await cli(root, 'index');
    expect((await cli(root, 'fragments', 'propose', '--write')).code).toBe(0);

    const warned = await cli(root, 'index');
    expect(warned.code).toBe(0);
    expect(warned.out).toContain('warning: .anvesa/fragments.json is not used');
    expect(warned.out).toContain('anvesa fragments enable');
    expect(existsSync(join(root, '.anvesa', 'shards'))).toBe(false);
    expect(json(await cli(root, 'index', '--json')).report.warnings).toContainEqual(
      expect.stringContaining('fragments.json is not used'),
    );

    writeFileSync(join(root, '.anvesa', 'config.json'), '{"indexing":{"fragments":"off"}}');
    expect((await cli(root, 'index')).out).not.toContain('is not used');
  });

  test('turning it on with no manifest at hand is refused by the commands that need one; enable proposes from an index', async () => {
    const root = makeProject();
    mkdirSync(join(root, '.anvesa'), { recursive: true });
    writeFileSync(join(root, '.anvesa', 'config.json'), '{"indexing":{"fragments":"on"}}');
    const status = await cli(root, 'status');
    expect(status.code).toBe(1);
    expect(status.err).toContain('fragments enable');
    // enable works from the state that stopped everything else: it looks at the index as it is.
    await cli(root, 'index', '--json').then(() => undefined);
    const enabled = await cli(root, 'fragments', 'enable');
    expect(enabled.code).toBe(1);
    expect(enabled.err).toContain('has no index yet');
  });
});

describe('red-team rules a project brings', () => {
  const widgetRule = {
    id: 'config-talk',
    category: 'injection',
    severity: 'high',
    description: 'Text about configuration.',
    pattern: '\\bconfiguration\\b',
    flags: 'i',
    message: 'Mentions configuration.',
    fixtures: { attack: ['load the Configuration file'], benign: ['load the settings file'] },
  };
  const policyPath = (root: string) => join(root, '.anvesa', 'redteam.json');
  const writePolicy = (root: string, policy: unknown) => {
    mkdirSync(join(root, '.anvesa'), { recursive: true });
    writeFileSync(policyPath(root), JSON.stringify(policy));
  };

  test('channel test shows the text that would be stored, after sanitizing', async () => {
    const root = makeProject();
    writePolicy(root, {
      rules: [
        {
          id: 'internal-hostname',
          category: 'exfiltration',
          severity: 'medium',
          description: 'an internal hostname',
          pattern: '\\b[a-z0-9-]+\\.corp\\.example\\b',
          message: 'internal hostname',
          replacement: '[host]',
          fixtures: { attack: ['send it to db1.corp.example'], benign: ['see the example docs'] },
        },
      ],
      actions: { 'third-party': { 'internal-hostname': 'sanitize' } },
    });
    await cli(root, 'channel', 'add', 'runbooks', '--template', 'file');
    writeFileSync(
      join(root, 'ops.txt'),
      'The nightly job runs on db1.corp.example and nowhere else.\n',
    );
    const tested = await cli(root, 'channel', 'test', 'runbooks', 'ops.txt');
    expect(tested.out).toContain('1 sanitized');
    expect(tested.out).toContain('[host]');
    expect(tested.out).not.toContain('db1.corp.example');
  });

  test('a project with no file has the built-in rules; a file adds rules and changes what trust levels do', async () => {
    const root = makeProject();
    const plain = json(await cli(root, 'redteam', 'list', '--json'));
    expect(plain.every((r: { source: string }) => r.source === 'built in')).toBe(true);
    expect(plain.map((r: { id: string }) => r.id)).toContain('instruction-override');
    expect((await cli(root, 'redteam', 'verify')).out).toContain('0 added by policy');
    await cli(root, 'index');
    expect((await cli(root, 'redteam', 'scan')).code).toBe(0);

    writePolicy(root, {
      rules: [widgetRule],
      actions: {
        'first-party': { 'config-talk': 'quarantine' },
        'third-party': { 'config-talk': 'flag' },
      },
    });
    const listed = json(await cli(root, 'redteam', 'list', '--json'));
    const rule = listed.find((r: { id: string }) => r.id === 'config-talk');
    expect(rule).toMatchObject({
      severity: 'high',
      actions: { 'first-party': 'quarantine', 'third-party': 'flag' },
    });
    expect(rule.source).toContain('redteam.json');
    expect((await cli(root, 'redteam', 'verify')).out).toContain('1 added by policy');

    // Without any change to code, the gate now refuses the cards that mention configuration.
    const scan = await cli(root, 'redteam', 'scan');
    expect(scan.code).toBe(1);
    expect(scan.out).toContain('would quarantine src/config.ts (symbols): config-talk');
    expect(scan.err).toContain('CLI_COMMAND_FAILED');
    await cli(root, 'index', '--force');
    const status = json(await cli(root, 'status', '--json'));
    const symbols = status.channels.find((c: { name: string }) => c.name === 'symbols');
    expect(symbols.quarantined).toBeGreaterThan(0);

    // And turning a built-in rule off is the same kind of change.
    writePolicy(root, { actions: { 'third-party': { 'mixed-script-words': 'off' } } });
    const off = json(await cli(root, 'redteam', 'list', '--json')).find(
      (r: { id: string }) => r.id === 'mixed-script-words',
    );
    expect(off.actions['third-party']).toBe('off');
  });

  test('a file that does not check out stops everything, naming the field or the fixture', async () => {
    const root = makeProject();
    const bad = async (policy: unknown) => {
      writePolicy(root, policy);
      return cli(root, 'redteam', 'verify');
    };

    const noFixtures = await bad({ rules: [{ ...widgetRule, fixtures: undefined }] });
    expect(noFixtures.code).toBe(1);
    expect(noFixtures.err).toContain('DENSE_DEFINITION_INVALID');
    expect(noFixtures.err).toContain('rules[0].fixtures');

    const missesAttack = await bad({
      rules: [{ ...widgetRule, fixtures: { attack: ['nothing here'], benign: ['a gadget'] } }],
    });
    expect(missesAttack.err).toContain('DENSE_RULE_FIXTURE');
    expect(missesAttack.err).toContain('attack fixture');

    const clash = await bad({ rules: [{ ...widgetRule, id: 'instruction-override' }] });
    expect(clash.err).toContain('already defined by the built-in rules');

    const ghost = await bad({ actions: { untrusted: { 'no-such-rule': 'flag' } } });
    expect(ghost.err).toContain('names no rule');

    writeFileSync(policyPath(root), '{oops');
    const notJson = await cli(root, 'status');
    expect(notJson.code).toBe(1);
    expect(notJson.err).toContain('RETRIEVER_CONFIG');
    // Every command that opens the project is stopped, not only the red-team ones.
    writePolicy(root, { rules: [{ ...widgetRule, pattern: '(' }] });
    expect((await cli(root, 'index')).code).toBe(1);
  });

  test('rules learned elsewhere come from a module the file lists, and are checked the same way', async () => {
    const root = makeProject();
    writeFileSync(
      join(root, 'learned.ts'),
      `export default ({ root }: { root: string }) => ({
  rules: [{
    id: 'learned-widget', category: 'poisoning', severity: 'medium', pattern: 'gadget',
    fixtures: { attack: ['a gadget'], benign: ['a widget'] },
  }],
  actions: { 'first-party': { 'learned-widget': 'flag' } },
});
`,
    );
    writePolicy(root, { sources: ['./learned.ts'] });
    const listed = json(await cli(root, 'redteam', 'list', '--json'));
    const learned = listed.find((r: { id: string }) => r.id === 'learned-widget');
    expect(learned.source).toContain('learned.ts');
    expect(learned.actions['first-party']).toBe('flag');

    // A module is loaded once per process, so the broken one is another file.
    writeFileSync(join(root, 'broken.ts'), 'export default { rules: [{ id: "x" }] };\n');
    writePolicy(root, { sources: ['./broken.ts'] });
    const invalid = await cli(root, 'redteam', 'verify');
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('broken.ts');
    expect(invalid.err).toContain('rules[0]');

    writePolicy(root, { sources: ['./missing.ts'] });
    expect((await cli(root, 'redteam', 'verify')).err).toContain('RETRIEVER_CHANNEL_MODULE');
    writePolicy(root, { sources: 'nope' });
    expect((await cli(root, 'redteam', 'verify')).err).toContain('sources');
    expect((await cli(root, 'redteam', 'frobnicate')).code).toBe(2);
  });
});

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

describe('mcp server', () => {
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

  test('search, query and retrieve take a scope; one that could never match is a typed error', async () => {
    const root = makeProject();
    expect((await cli(root, 'index')).code).toBe(0);
    const session = await connect(root);
    try {
      const { client } = session;
      const paths = (body: { items: { path: string }[] }) => [
        ...new Set(body.items.map((item) => item.path)),
      ];
      const searched = await call(client, 'search', {
        query: 'parse configuration',
        scope: 'docs',
      });
      expect(searched.isError).toBe(false);
      expect(paths(searched.body)).toEqual(['docs/guide.md']);
      const queried = await call(client, 'query', { wql: '//function', scope: 'src/server.ts' });
      expect(paths(queried.body)).toEqual(['src/server.ts']);
      const retrieved = await call(client, 'retrieve_symbols', {
        query: 'parse configuration',
        scope: 'src/config.ts',
      });
      expect(retrieved.isError).toBe(false);
      const refused = await call(client, 'search', { query: 'parse', scope: '../outside' });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.body)).toContain('CORE_INVALID_ARGUMENT');
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

      const mcpConjSearch = await call(client, 'search', {
        query: 'parse configuration',
        wql: '//function',
      });
      expect(mcpConjSearch.isError).toBe(false);
      expect(mcpConjSearch.body.conjunction).toEqual({
        semantic: 'parse configuration',
        wql: '//function',
      });
      expect(mcpConjSearch.body.items[0].path).toBe('src/config.ts');

      const mcpConjQuery = await call(client, 'query', {
        wql: '//function',
        semantic: 'parse configuration',
      });
      expect(mcpConjQuery.isError).toBe(false);
      expect(mcpConjQuery.body.conjunction).toEqual({
        semantic: 'parse configuration',
        wql: '//function',
      });
      expect(mcpConjQuery.body.items[0].name).toBe('parseConfig');
      expect(mcpConjQuery.body.items[0].score).toBeGreaterThan(0);

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
    expect(session.stderr()).toContain('anvesa mcp: serving');
  });
});

describe('declarative patterns', () => {
  test('--limit overrides the limit a pattern file sets, and a cut page does not claim a total', async () => {
    const root = makeProject();
    await cli(root, 'index');
    const patternsDir = join(root, '.anvesa', 'patterns');
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(
      join(patternsDir, 'every-function.json'),
      JSON.stringify({
        name: 'every-function',
        description: 'Every function',
        target: { kind: 'function', nameRegex: '.' },
        limit: 1,
      }),
    );
    const byFile = await cli(root, 'pattern', 'run', 'every-function');
    expect(byFile.out).toContain('1 matches, more after these (next cursor:');
    const byFlag = json(
      await cli(root, 'pattern', 'run', 'every-function', '--limit', '2', '--json'),
    );
    expect(byFlag.items).toHaveLength(2);
  });

  test('lists patterns, runs parameterized patterns via CLI and MCP', async () => {
    const root = makeProject();
    await cli(root, 'index');

    // Initially no patterns
    const emptyList = await cli(root, 'pattern', 'list');
    expect(emptyList.code).toBe(0);
    expect(emptyList.out).toContain('no patterns found');

    // Add a pattern to .anvesa/patterns/
    const patternsDir = join(root, '.anvesa', 'patterns');
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(
      join(patternsDir, 'functions-by-name.json'),
      JSON.stringify({
        name: 'functions-by-name',
        description: 'Find functions by exact or prefix name',
        target: {
          kind: 'function',
          name: '$name',
        },
        params: [{ name: 'name', required: true }],
      }),
    );

    // List patterns
    const listed = await cli(root, 'pattern', 'list');
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('functions-by-name');
    expect(listed.out).toContain('params: $name (required)');

    // Run pattern with parameter
    const ran = await cli(root, 'pattern', 'run', 'functions-by-name', 'name=parseConfig');
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('pattern: functions-by-name -> wql: //function[@name="parseConfig"]');
    expect(ran.out).toContain('parseConfig  src/config.ts:2');

    // MCP tools test
    const session = await connect(root);
    try {
      const { client } = session;
      const mcpList = await call(client, 'pattern_list', {});
      expect(mcpList.isError).toBe(false);
      expect(mcpList.body.patterns).toHaveLength(1);
      expect(mcpList.body.patterns[0].name).toBe('functions-by-name');
      expect(mcpList.body.invalid).toHaveLength(0);

      const mcpRun = await call(client, 'pattern_run', {
        name: 'functions-by-name',
        args: { name: 'validate' },
      });
      expect(mcpRun.isError).toBe(false);
      expect(mcpRun.body.wql).toBe('//function[@name="validate"]');
      expect(mcpRun.body.items).toHaveLength(1);
      expect(mcpRun.body.items[0].name).toBe('validate');
    } finally {
      await session.close();
    }
  });
  test('pattern list reports invalid files with a reason and a typed code', async () => {
    const root = makeProject();
    const patternsDir = join(root, '.anvesa', 'patterns');
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(join(patternsDir, 'broken.json'), '{ not json');
    writeFileSync(
      join(patternsDir, 'bad-kind.json'),
      JSON.stringify({ name: 'bad-kind', target: { kind: 'no-such-kind' } }),
    );
    const listed = await cli(root, 'pattern', 'list');
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('invalid broken.json');
    expect(listed.out).toContain('CORE_INVALID_ARGUMENT');
    expect(listed.out).toContain('invalid bad-kind.json');
    expect(listed.out).toContain('STRUCTURAL_INVALID_ARGUMENT');
  });

  test('status on an unindexed directory does not create .anvesa/ directory', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'anvesa-unindexed-'));
    roots.push(emptyRoot);
    const result = await cli(emptyRoot, 'status');
    expect(result.code).toBe(0);
    expect(result.out).toContain('not indexed');
    expect(existsSync(join(emptyRoot, '.anvesa'))).toBe(false);
  });

  test('renderIndex suggests grammar install when files are quarantined due to missing grammar', () => {
    const report = {
      complete: true as const,
      resumedAfterInterruption: false,
      reextracted: false,
      files: {
        seen: 5,
        unchanged: 0,
        touched: 0,
        added: 2,
        modified: 0,
        quarantined: 2,
        stillQuarantined: 0,
        removed: 0,
        skippedLanguage: 0,
        unsupported: new Map<string, number>(),
        outOfScope: 0,
        unreadable: [],
        ignored: 0,
      },
      quarantined: [
        {
          path: 'a.php',
          reason: 'parse-failed' as const,
          message: 'No grammar available for "php" (grammar "tree-sitter-php")',
        },
        {
          path: 'b.php',
          reason: 'parse-failed' as const,
          message: 'No grammar available for "php" (grammar "tree-sitter-php")',
        },
      ],
      link: undefined,
      relinked: 0,
      dense: undefined,
      elapsedMs: 120,
    };
    const rendered = renderIndex({ report, synced: [] });
    expect(rendered).toContain(
      "advice: 2 files quarantined because 'php' grammar is missing. Run: anvesa grammar install php --download",
    );
  });

  test('renderIndex suggests mapping train when files are quarantined for want of a mapping', () => {
    const report = {
      complete: true as const,
      resumedAfterInterruption: false,
      reextracted: false,
      files: {
        seen: 1,
        unchanged: 0,
        touched: 0,
        added: 1,
        modified: 0,
        quarantined: 1,
        stillQuarantined: 0,
        removed: 0,
        skippedLanguage: 0,
        unsupported: new Map<string, number>(),
        outOfScope: 0,
        unreadable: [],
        ignored: 0,
      },
      quarantined: [
        {
          path: 'Button.cs',
          reason: 'parse-failed' as const,
          message: 'No W-expression mapping is registered for language "csharp"',
        },
      ],
      link: undefined,
      relinked: 0,
      dense: undefined,
      elapsedMs: 120,
    };
    const rendered = renderIndex({ report, synced: [] });
    expect(rendered).toContain(
      "advice: 1 file quarantined because 'csharp' has no structural mapping. Run: anvesa mapping train csharp --samples <dir>",
    );
    expect(rendered).not.toContain('grammar install csharp');
  });

  test('repomap, routes, issue, and mapping audit work end to end', async () => {
    const root = makeProject();
    writeFileSync(
      join(root, 'src', 'router.ts'),
      `import { parseConfig } from './config';
app.get('/api/users', (req, res) => res.json([]));
app.post('/api/checkout', (req, res) => res.json({ ok: true }));
`,
    );

    const indexed = await cli(root, 'index');
    expect(indexed.code).toBe(0);

    // 1. repomap
    const mapText = await cli(root, 'map');
    expect(mapText.code).toBe(0);
    expect(mapText.out).toContain('repomap');
    expect(mapText.out).toContain('src/');

    const mapJson = await cli(root, 'map', '--json');
    expect(mapJson.code).toBe(0);
    const parsedMap = json(mapJson);
    expect(parsedMap.totalFiles).toBeGreaterThanOrEqual(3);
    expect(parsedMap.tree).toBeDefined();

    // 2. routes
    const routesText = await cli(root, 'routes');
    expect(routesText.code).toBe(0);
    expect(routesText.out).toContain('/api/users');
    expect(routesText.out).toContain('/api/checkout');

    const routesFiltered = await cli(root, 'routes', 'POST', '--json');
    expect(routesFiltered.code).toBe(0);
    const postRoutes = json(routesFiltered);
    expect(postRoutes).toHaveLength(1);
    expect(postRoutes[0].route).toBe('/api/checkout');
    expect(postRoutes[0].method).toBe('POST');

    // 3. issue
    const issueRan = await cli(root, 'issue', 'Fix bug in router', '--json');
    expect(issueRan.code).toBe(0);
    const issueData = json(issueRan);
    expect(issueData.title).toBe('Fix bug in router');
    expect(issueData.url).toContain('github.com/nimishph/anvesa/issues/new');
    expect(issueData.body).toContain('Diagnostics (Sanitized)');
    expect(issueData.body).toContain('Anvesa Version');
    expect(issueData.body).not.toContain(root);

    // 4. mapping audit
    const auditRan = await cli(root, 'mapping', 'audit', 'typescript', '--json');
    expect(auditRan.code).toBe(0);
    const auditData = json(auditRan);
    expect(auditData.language).toBe('typescript');
    expect(auditData.mappedCount).toBeGreaterThan(0);
  });

  test('mapping refine with no samples looks over --root, not cwd', async () => {
    const root = makeProject();
    const elsewhere = mkdtempSync(join(tmpdir(), 'anvesa-cwd-'));
    roots.push(elsewhere);
    const ran = await cliWith(
      { cwd: elsewhere },
      elsewhere,
      'mapping',
      'refine',
      'typescript',
      '--root',
      root,
      '--dry-run',
      '--json',
    );
    expect(ran.err).toBe('');
    expect(ran.code).toBe(0);
    expect(json(ran).language).toBe('typescript');
  });

  test('renderIndex counts files that are not source, most common first', () => {
    const rendered = renderIndex({
      report: {
        complete: true as const,
        resumedAfterInterruption: false,
        reextracted: false,
        files: {
          seen: 0,
          unchanged: 0,
          touched: 0,
          added: 0,
          modified: 0,
          quarantined: 0,
          stillQuarantined: 0,
          removed: 0,
          skippedLanguage: 0,
          unsupported: new Map([
            ['', 1],
            ['.md', 4],
          ]),
          outOfScope: 0,
          unreadable: [],
          ignored: 0,
        },
        quarantined: [],
        link: undefined,
        relinked: 0,
        dense: undefined,
        elapsedMs: 1,
      },
      synced: [],
    });
    expect(rendered).toContain('not source: 4 .md, 1 with no extension');
  });

  test('renderIndex names the eight most common kinds of non-source file and sums the rest', () => {
    const unsupported = new Map(
      Array.from({ length: 11 }, (_, i) => [`.x${String(i).padStart(2, '0')}`, 20 - i]),
    );
    const rendered = renderIndex({
      report: {
        complete: true as const,
        resumedAfterInterruption: false,
        reextracted: false,
        files: {
          seen: 0,
          unchanged: 0,
          touched: 0,
          added: 0,
          modified: 0,
          quarantined: 0,
          stillQuarantined: 0,
          removed: 0,
          skippedLanguage: 0,
          unsupported,
          outOfScope: 0,
          unreadable: [],
          ignored: 0,
        },
        quarantined: [],
        link: undefined,
        relinked: 0,
        dense: undefined,
        elapsedMs: 1,
      },
      synced: [],
    });
    expect(rendered).toContain(
      'not source: 20 .x00, 19 .x01, 18 .x02, 17 .x03, 16 .x04, 15 .x05, 14 .x06, 13 .x07, 33 more in 3 other kinds',
    );
  });
});
