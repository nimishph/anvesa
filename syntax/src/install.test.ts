import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Deadline, DeadlineExceededError } from '@sutras/code-lens-core';
import {
  GrammarInstallError,
  GrammarIntegrityError,
  type NetworkForbiddenError,
  SyntaxSubsystemError,
} from './errors.ts';
import { sha256Hex } from './files.ts';
import { installGrammar } from './install.ts';
import { LanguageRegistry } from './languages.ts';
import { GrammarLock } from './lockfile.ts';
import { grammarBytes, makeTarball, makeTempDir, type TempDir } from './test-support.ts';

/** Stands in for an error thrown by the platform's fetch. */
class SocketError extends Error {}

const registry = new LanguageRegistry();
const tsxFile = 'tree-sitter-tsx.wasm';

let dir: TempDir;
let tsx: Uint8Array;
let js: Uint8Array;

beforeAll(async () => {
  dir = await makeTempDir();
  tsx = await grammarBytes('tsx');
  js = await grammarBytes('javascript');
});
afterAll(async () => {
  await dir.cleanup();
});

let counter = 0;
async function scratch() {
  counter += 1;
  const root = join(dir.path, `case-${counter}`);
  await mkdir(root, { recursive: true });
  return {
    root,
    dest: join(root, 'grammars'),
    lock: GrammarLock.empty(join(root, 'grammars.lock.json')),
  };
}

async function capture<T>(work: () => Promise<T>): Promise<SyntaxSubsystemError> {
  try {
    await work();
  } catch (thrown) {
    if (thrown instanceof SyntaxSubsystemError) return thrown;
    throw thrown;
  }
  throw new GrammarInstallError('test', 'validate', 'expected the operation to fail');
}

describe('local installs', () => {
  test('installs from a directory, checksums the bytes and records them as a local version', async () => {
    const s = await scratch();
    const source = join(s.root, 'src');
    await mkdir(source);
    await writeFile(join(source, tsxFile), tsx);

    const result = await installGrammar({
      registry,
      language: 'tsx',
      source: { kind: 'directory', path: source },
      destinationDir: s.dest,
      lock: s.lock,
    });

    expect(result.sha256).toBe(sha256Hex(tsx));
    expect(result.version).toBe('local');
    expect(result.matchedExistingLock).toBe(false);
    expect(sha256Hex(await readFile(join(s.dest, tsxFile)))).toBe(sha256Hex(tsx));
    const saved = await GrammarLock.load(s.lock.path);
    expect(saved.get('tsx')?.sha256).toBe(sha256Hex(tsx));
  });

  test('finds the file inside an unpacked npm package layout', async () => {
    const s = await scratch();
    const source = join(s.root, 'unpacked');
    await mkdir(join(source, 'package'), { recursive: true });
    await writeFile(join(source, 'package', tsxFile), tsx);
    const result = await installGrammar({
      registry,
      language: 'tsx',
      source: { kind: 'directory', path: source },
      destinationDir: s.dest,
      lock: s.lock,
    });
    expect(result.origin).toContain('package');
  });

  test('a directory without the grammar lists where it looked', async () => {
    const s = await scratch();
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'directory', path: s.root },
        destinationDir: s.dest,
        lock: s.lock,
      }),
    );
    expect(failure).toBeInstanceOf(GrammarInstallError);
    expect(failure.context.stage).toBe('locate');
    expect(failure.context.tried).toHaveLength(2);
  });

  test('installs a single file', async () => {
    const s = await scratch();
    const file = join(s.root, 'whatever-name.wasm');
    await writeFile(file, tsx);
    const result = await installGrammar({
      registry,
      language: 'tsx',
      source: { kind: 'file', path: file },
      destinationDir: s.dest,
      lock: s.lock,
    });
    expect(result.path).toBe(join(s.dest, tsxFile));
  });

  test('a missing file is a locate failure that keeps the underlying error', async () => {
    const s = await scratch();
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'file', path: join(s.root, 'nope.wasm') },
        destinationDir: s.dest,
        lock: s.lock,
      }),
    );
    expect(failure.context.stage).toBe('locate');
    expect(failure.cause).toBeDefined();
  });

  test('refuses a file that is not WebAssembly and writes nothing', async () => {
    const s = await scratch();
    const file = join(s.root, 'fake.wasm');
    await writeFile(file, 'definitely not wasm');
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'file', path: file },
        destinationDir: s.dest,
        lock: s.lock,
      }),
    );
    expect(failure.context.stage).toBe('validate');
    expect(
      await stat(s.dest).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(s.lock.entries()).toEqual([]);
  });

  test('rejects an unknown language before touching anything', async () => {
    const s = await scratch();
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'cobol',
        source: { kind: 'file', path: join(s.root, 'x') },
        destinationDir: s.dest,
        lock: s.lock,
      }),
    );
    expect(failure.code).toBe('SYNTAX_UNKNOWN_LANGUAGE');
  });
});

describe('the lock is the trust anchor', () => {
  const installFile = (s: Awaited<ReturnType<typeof scratch>>, file: string, updateLock = false) =>
    installGrammar({
      registry,
      language: 'tsx',
      source: { kind: 'file', path: file },
      destinationDir: s.dest,
      lock: s.lock,
      updateLock,
    });

  test('reinstalling the same bytes is recognised as matching the lock', async () => {
    const s = await scratch();
    const file = join(s.root, 'g.wasm');
    await writeFile(file, tsx);
    await installFile(s, file);
    expect((await installFile(s, file)).matchedExistingLock).toBe(true);
  });

  test('different bytes are rejected, and neither the file nor the lock changes', async () => {
    const s = await scratch();
    const good = join(s.root, 'good.wasm');
    const other = join(s.root, 'other.wasm');
    await writeFile(good, tsx);
    await writeFile(other, js);
    await installFile(s, good);

    const failure = (await capture(() => installFile(s, other))) as GrammarIntegrityError;
    expect(failure).toBeInstanceOf(GrammarIntegrityError);
    expect(failure.expectedSha256).toBe(sha256Hex(tsx));
    expect(failure.actualSha256).toBe(sha256Hex(js));
    expect(sha256Hex(await readFile(join(s.dest, tsxFile)))).toBe(sha256Hex(tsx));
    expect(s.lock.get('tsx')?.sha256).toBe(sha256Hex(tsx));
  });

  test('updateLock accepts the new bytes and re-pins', async () => {
    const s = await scratch();
    const good = join(s.root, 'good.wasm');
    const other = join(s.root, 'other.wasm');
    await writeFile(good, tsx);
    await writeFile(other, js);
    await installFile(s, good);
    await installFile(s, other, true);
    expect(s.lock.get('tsx')?.sha256).toBe(sha256Hex(js));
    expect(sha256Hex(await readFile(join(s.dest, tsxFile)))).toBe(sha256Hex(js));
  });

  test('a successful install leaves no temp files in the destination', async () => {
    const s = await scratch();
    const file = join(s.root, 'g.wasm');
    await writeFile(file, tsx);
    await installFile(s, file);
    expect(await readdir(s.dest)).toEqual([tsxFile]);
  });
});

describe('tarballs', () => {
  test('extracts the grammar from an npm-style archive', async () => {
    const s = await scratch();
    const archive = join(s.root, 'pkg.tgz');
    await writeFile(
      archive,
      makeTarball([
        { name: 'package/package.json', data: new TextEncoder().encode('{}') },
        { name: `package/${tsxFile}`, data: tsx },
      ]),
    );
    const result = await installGrammar({
      registry,
      language: 'tsx',
      source: { kind: 'tarball', path: archive },
      destinationDir: s.dest,
      lock: s.lock,
    });
    expect(result.sha256).toBe(sha256Hex(tsx));
    expect(result.origin).toContain('pkg.tgz');
  });

  test('an archive without the grammar says so', async () => {
    const s = await scratch();
    const archive = join(s.root, 'empty.tgz');
    await writeFile(archive, makeTarball([{ name: 'package/readme.md', data: new Uint8Array(3) }]));
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'tarball', path: archive },
        destinationDir: s.dest,
        lock: s.lock,
      }),
    );
    expect(failure.context.stage).toBe('extract');
  });

  test('a file that is not gzip is an extract failure with the cause kept', async () => {
    const s = await scratch();
    const archive = join(s.root, 'plain.tgz');
    await writeFile(archive, 'this is not gzip');
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'tarball', path: archive },
        destinationDir: s.dest,
        lock: s.lock,
      }),
    );
    expect(failure.context.stage).toBe('extract');
    expect(failure.cause).toBeDefined();
  });
});

describe('registry installs', () => {
  const respond = (bytes: Uint8Array, finalUrl: string, status = 200) => {
    const response = new Response(bytes.slice(), { status });
    Object.defineProperty(response, 'url', { value: finalUrl });
    return response;
  };

  test('offline mode refuses before any request is made', async () => {
    const s = await scratch();
    const requests: string[] = [];
    const failure = (await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'registry' },
        destinationDir: s.dest,
        lock: s.lock,
        offline: true,
        fetch: (async (url: string) => {
          requests.push(url);
          return respond(tsx, url);
        }) as unknown as typeof fetch,
      }),
    )) as NetworkForbiddenError;
    expect(failure.code).toBe('SYNTAX_NETWORK_FORBIDDEN');
    expect(requests).toEqual([]);
  });

  test('a floating "latest" is pinned to the concrete version the redirect reveals', async () => {
    const s = await scratch();
    const requests: string[] = [];
    const result = await installGrammar({
      registry,
      language: 'tsx',
      source: { kind: 'registry', baseUrl: 'https://mirror.test' },
      destinationDir: s.dest,
      lock: s.lock,
      fetch: (async (url: string) => {
        requests.push(url);
        return respond(tsx, `https://mirror.test/tree-sitter-typescript@0.23.2/${tsxFile}`);
      }) as unknown as typeof fetch,
    });
    expect(requests[0]).toBe(`https://mirror.test/tree-sitter-typescript@latest/${tsxFile}`);
    expect(result.version).toBe('0.23.2');
    expect(s.lock.get('tsx')?.version).toBe('0.23.2');
  });

  test('a later install asks for the pinned version, not latest', async () => {
    const s = await scratch();
    const requests: string[] = [];
    const fetcher = (async (url: string) => {
      requests.push(url);
      return respond(tsx, url);
    }) as unknown as typeof fetch;
    const base = {
      registry,
      language: 'tsx',
      source: { kind: 'registry', version: '0.23.2' } as const,
      destinationDir: s.dest,
      lock: s.lock,
      fetch: fetcher,
    };
    await installGrammar(base);
    await installGrammar({ ...base, source: { kind: 'registry' } });
    expect(requests[1]).toContain('tree-sitter-typescript@0.23.2');
  });

  test('a redirect that does not reveal a version cannot be pinned, so it is refused', async () => {
    const s = await scratch();
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'registry' },
        destinationDir: s.dest,
        lock: s.lock,
        fetch: (async (url: string) => respond(tsx, url)) as unknown as typeof fetch,
      }),
    );
    expect(failure.context.stage).toBe('fetch');
    expect(s.lock.entries()).toEqual([]);
  });

  test('an HTTP error carries the status', async () => {
    const s = await scratch();
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'registry' },
        destinationDir: s.dest,
        lock: s.lock,
        fetch: (async (url: string) =>
          respond(new Uint8Array(0), url, 404)) as unknown as typeof fetch,
      }),
    );
    expect(failure.context.status).toBe(404);
  });

  test('a network failure keeps the underlying error as its cause', async () => {
    const s = await scratch();
    const failure = await capture(() =>
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'registry' },
        destinationDir: s.dest,
        lock: s.lock,
        fetch: (async () =>
          Promise.reject(new SocketError('socket hang up'))) as unknown as typeof fetch,
      }),
    );
    expect(failure.context.stage).toBe('fetch');
    expect((failure.cause as Error).message).toBe('socket hang up');
  });

  test('an expired deadline stops the install before any request', async () => {
    const s = await scratch();
    const controller = new AbortController();
    controller.abort();
    const requests: string[] = [];
    await expect(
      installGrammar({
        registry,
        language: 'tsx',
        source: { kind: 'registry' },
        destinationDir: s.dest,
        lock: s.lock,
        deadline: Deadline.of({ signal: controller.signal }),
        fetch: (async (url: string) => {
          requests.push(url);
          return respond(tsx, url);
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  test('a fetch cut short by the deadline is reported as the deadline, not a generic fetch error', async () => {
    const s = await scratch();
    const deadline = Deadline.of({ timeoutMs: 20 });
    const failure = await installGrammar({
      registry,
      language: 'tsx',
      source: { kind: 'registry' },
      destinationDir: s.dest,
      lock: s.lock,
      deadline,
      // A real request holds a socket open, which keeps the event loop alive while the
      // (deliberately unref'd) deadline timer counts down. Model that with a ref'd interval.
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const socket = setInterval(() => undefined, 10);
          init?.signal?.addEventListener('abort', () => {
            clearInterval(socket);
            reject(init.signal?.reason);
          });
        })) as unknown as typeof fetch,
    }).catch((thrown) => thrown);
    expect(failure).toBeInstanceOf(DeadlineExceededError);
  });
});
