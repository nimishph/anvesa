import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AggregateFailureError,
  Deadline,
  DeadlineExceededError,
  OperationAbortedError,
} from '@sutras/code-lens-core';
import {
  GrammarIncompatibleError,
  GrammarIntegrityError,
  GrammarMissingError,
  RuntimeDisposedError,
  RuntimeInitError,
  TreeDisposedError,
  UnknownLanguageError,
} from './errors.ts';
import { sha256Hex } from './files.ts';
import { installGrammar } from './install.ts';
import { LanguageRegistry } from './languages.ts';
import { GrammarLock } from './lockfile.ts';
import { SyntaxRuntime } from './runtime.ts';
import { directorySource, type GrammarSource } from './sources.ts';
import { grammarBytes, makeTempDir, npmSource, type TempDir } from './test-support.ts';

let dir: TempDir;
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await dir.cleanup();
});

/** Raised by the fetch trap if anything under test reaches for the network. */
class UnreachableNetwork extends Error {}

const runtimes: SyntaxRuntime[] = [];
function runtime(overrides: Partial<ConstructorParameters<typeof SyntaxRuntime>[0]> = {}) {
  const created = new SyntaxRuntime({ sources: [npmSource], ...overrides });
  runtimes.push(created);
  return created;
}
afterAll(async () => {
  await Promise.all(runtimes.map((r) => r.dispose()));
});

const brokenSource = 'function ( { const = ;';

describe('parsing real grammars', () => {
  test('parses TypeScript and exposes the tree', async () => {
    const rt = runtime();
    const tree = await rt.parse('export const answer: number = 42;', { language: 'typescript' });
    expect(tree.root.type).toBe('program');
    expect(tree.hasErrors).toBe(false);
    expect(tree.root.text).toContain('answer');
    tree.dispose();
  });

  test('picks the grammar from the path, including tsx and vue', async () => {
    const rt = runtime();
    await rt.withTree('const a = <div/>;', { path: 'ui/View.tsx' }, (tree) => {
      expect(tree.language.key).toBe('tsx');
      expect(tree.hasErrors).toBe(false);
    });
    await rt.withTree('const b = 1;', { language: 'vue' }, (tree) => {
      expect(tree.language.key).toBe('vue');
    });
    // Vue and tsx share one grammar, so it is loaded once.
    expect(rt.loadedGrammars()).toEqual(['tsx']);
  });

  test('a path no language claims is an error that lists what is known', async () => {
    const rt = runtime();
    const failure = await rt.parse('x', { path: 'notes/README' }).catch((e) => e);
    expect(failure).toBeInstanceOf(UnknownLanguageError);
    expect(failure.context.known).toContain('typescript');
    expect(failure.context.extensions).toContain('.ts');
  });

  test('broken source still yields a tree and reports where it is broken', async () => {
    const rt = runtime();
    await rt.withTree(brokenSource, { language: 'typescript' }, (tree) => {
      expect(tree.hasErrors).toBe(true);
      const issues = [...tree.errors()];
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(['error', 'missing']).toContain(issue.kind);
        expect(issue.endIndex).toBeGreaterThanOrEqual(issue.startIndex);
      }
    });
  });

  test('errors() is lazy: taking one issue does not walk the rest', async () => {
    const rt = runtime();
    await rt.withTree(brokenSource, { language: 'typescript' }, (tree) => {
      const first = tree.errors().next();
      expect(first.done).toBe(false);
    });
  });
});

describe('tree lifetime', () => {
  test('tracks live trees and frees them on dispose, idempotently', async () => {
    const rt = runtime();
    const tree = await rt.parse('const x = 1;', { language: 'javascript' });
    expect(rt.liveTrees).toBe(1);
    tree.dispose();
    tree.dispose();
    expect(rt.liveTrees).toBe(0);
  });

  test('using a tree after dispose is a typed error, not a wasm crash', async () => {
    const rt = runtime();
    const tree = await rt.parse('const x = 1;', { language: 'javascript' }, { path: 'a.js' });
    tree.dispose();
    expect(() => tree.root).toThrow(TreeDisposedError);
    expect(tree.isDisposed).toBe(true);
  });

  test('withTree disposes even when the work throws', async () => {
    const rt = runtime();
    const failure = await rt
      .withTree('const x = 1;', { language: 'javascript' }, () => {
        throw new OperationAbortedError('caller work');
      })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(OperationAbortedError);
    expect(rt.liveTrees).toBe(0);
  });

  test('`using` releases the tree at scope exit', async () => {
    const rt = runtime();
    {
      using tree = await rt.parse('const x = 1;', { language: 'javascript' });
      expect(rt.liveTrees).toBe(1);
      expect(tree.isDisposed).toBe(false);
    }
    expect(rt.liveTrees).toBe(0);
  });
});

describe('grammar loading', () => {
  test('many simultaneous parses load a grammar once', async () => {
    let lookups = 0;
    const counting: GrammarSource = {
      name: 'counting',
      async locate(grammar) {
        lookups += 1;
        return npmSource.locate(grammar);
      },
    };
    const rt = runtime({ sources: [counting] });
    const trees = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        rt.parse(`const v${i} = ${i};`, { language: 'javascript' }),
      ),
    );
    expect(trees).toHaveLength(25);
    expect(lookups).toBe(1);
    for (const tree of trees) tree.dispose();
  });

  test('a missing grammar reports every place it looked, and installing it later fixes it', async () => {
    const grammars = join(dir.path, 'late-install');
    await mkdir(grammars, { recursive: true });
    const custom = new LanguageRegistry();
    custom.register({
      key: 'mylang',
      extensions: ['.my'],
      grammar: { id: 'mylang', npmPackage: 'tree-sitter-mylang', file: 'tree-sitter-mylang.wasm' },
    });
    const rt = runtime({
      registry: custom,
      sources: [directorySource('user', grammars), npmSource],
    });

    const failure = await rt.parse('x', { language: 'mylang' }).catch((e) => e);
    expect(failure).toBeInstanceOf(GrammarMissingError);
    expect(failure.searched.map((miss: { source: string }) => miss.source)).toEqual([
      'user',
      'npm',
    ]);
    expect(failure.hint).toContain('grammar install');

    // Provide the grammar (a tsx build stands in for a real one) and the same runtime recovers.
    const source = join(dir.path, 'mylang-src.wasm');
    await writeFile(source, await grammarBytes('tsx'));
    await installGrammar({
      registry: custom,
      language: 'mylang',
      source: { kind: 'file', path: source },
      destinationDir: grammars,
      lock: GrammarLock.empty(join(dir.path, 'late.lock.json')),
    });
    const tree = await rt.parse('const x = 1;', { language: 'mylang' });
    expect(tree.hasErrors).toBe(false);
    tree.dispose();
  });

  test('bytes that do not match the lock are never loaded', async () => {
    const grammars = join(dir.path, 'tampered');
    await mkdir(grammars, { recursive: true });
    const real = await grammarBytes('javascript');
    await writeFile(join(grammars, 'tree-sitter-javascript.wasm'), real);
    const lock = GrammarLock.empty(join(dir.path, 'tampered.lock.json'));
    lock.set({
      id: 'javascript',
      npmPackage: 'tree-sitter-javascript',
      version: '1.0.0',
      file: 'tree-sitter-javascript.wasm',
      sha256: 'b'.repeat(64),
    });
    const rt = runtime({ sources: [directorySource('user', grammars)], locks: [lock] });

    const failure = await rt.parse('x', { language: 'javascript' }).catch((e) => e);
    expect(failure).toBeInstanceOf(GrammarIntegrityError);
    expect(failure.actualSha256).toBe(sha256Hex(real));
    expect(rt.loadedGrammars()).toEqual([]);

    const status = (await rt.status()).find((s) => s.language.key === 'javascript');
    expect(status?.grammar.state).toBe('corrupt');
  });

  test('bytes that match the lock load, and status says they were vouched for', async () => {
    const grammars = join(dir.path, 'trusted');
    await mkdir(grammars, { recursive: true });
    const real = await grammarBytes('javascript');
    await writeFile(join(grammars, 'tree-sitter-javascript.wasm'), real);
    const lock = GrammarLock.empty(join(dir.path, 'trusted.lock.json'));
    lock.set({
      id: 'javascript',
      npmPackage: 'tree-sitter-javascript',
      version: '1.0.0',
      file: 'tree-sitter-javascript.wasm',
      sha256: sha256Hex(real),
    });
    const rt = runtime({ sources: [directorySource('user', grammars)], locks: [lock] });
    await rt.withTree('const a = 1;', { language: 'javascript' }, (tree) => {
      expect(tree.hasErrors).toBe(false);
    });
    const status = (await rt.status()).find((s) => s.language.key === 'javascript');
    expect(status?.grammar).toMatchObject({ state: 'ready', locked: true });
  });

  test('a file that is not WebAssembly is reported as incompatible, not as a crash', async () => {
    const grammars = join(dir.path, 'garbage');
    await mkdir(grammars, { recursive: true });
    await writeFile(join(grammars, 'tree-sitter-javascript.wasm'), 'not wasm at all');
    const rt = runtime({ sources: [directorySource('user', grammars)] });
    const failure = await rt.parse('x', { language: 'javascript' }).catch((e) => e);
    expect(failure).toBeInstanceOf(GrammarIncompatibleError);
  });

  test('a wasm module that is not a tree-sitter grammar is reported as incompatible with its cause', async () => {
    const grammars = join(dir.path, 'wrong-wasm');
    await mkdir(grammars, { recursive: true });
    // A valid, empty WebAssembly module: magic + version, no sections.
    await writeFile(
      join(grammars, 'tree-sitter-javascript.wasm'),
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    const rt = runtime({ sources: [directorySource('user', grammars)] });
    const failure = await rt.parse('x', { language: 'javascript' }).catch((e) => e);
    expect(failure).toBeInstanceOf(GrammarIncompatibleError);
    expect(failure.cause).toBeDefined();
  });

  test('preload reports every failure and still loads what it can', async () => {
    const custom = new LanguageRegistry();
    custom.register({
      key: 'ghost',
      extensions: ['.ghost'],
      grammar: { id: 'ghost', npmPackage: 'tree-sitter-ghost', file: 'tree-sitter-ghost.wasm' },
    });
    const rt = runtime({ registry: custom });
    const failure = await rt.preload(['javascript', 'ghost', 'go']).catch((e) => e);
    expect(failure).toBeInstanceOf(AggregateFailureError);
    expect(failure.failures.map((f: { code: string }) => f.code)).toEqual([
      'SYNTAX_GRAMMAR_MISSING',
      'SYNTAX_GRAMMAR_MISSING',
    ]);
    expect(rt.loadedGrammars()).toEqual(['javascript']);
  });

  test('status reports each language without loading any grammar', async () => {
    const rt = runtime();
    const all = await rt.status();
    const state = (key: string) => all.find((s) => s.language.key === key)?.grammar;
    expect(state('typescript')?.state).toBe('ready');
    expect(state('tsx')?.state).toBe('ready');
    expect(state('go')?.state).toBe('missing');
    expect(rt.loadedGrammars()).toEqual([]);
  });

  test('unload frees a grammar and it reloads on demand', async () => {
    const rt = runtime();
    (await rt.parse('const a = 1;', { language: 'javascript' })).dispose();
    expect(rt.loadedGrammars()).toEqual(['javascript']);
    await rt.unload('javascript');
    expect(rt.loadedGrammars()).toEqual([]);
    (await rt.parse('const a = 1;', { language: 'javascript' })).dispose();
    expect(rt.loadedGrammars()).toEqual(['javascript']);
  });
});

describe('offline operation', () => {
  test('loading and parsing never touch the network', async () => {
    const original = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(String(input));
      return Promise.reject(new UnreachableNetwork('the network must not be used'));
    }) as unknown as typeof fetch;
    try {
      const rt = runtime();
      await rt.preload(['javascript', 'typescript', 'tsx']);
      await rt.withTree('const a = 1;', { path: 'a.ts' }, (tree) => {
        expect(tree.hasErrors).toBe(false);
      });
      await rt.status();
      const missing = await rt.parse('x', { language: 'go' }).catch((e) => e);
      expect(missing).toBeInstanceOf(GrammarMissingError);
    } finally {
      globalThis.fetch = original;
    }
    expect(attempts).toEqual([]);
  });
});

describe('deadlines', () => {
  test('a cancelled caller stops the parse before it starts', async () => {
    const rt = runtime();
    const controller = new AbortController();
    controller.abort();
    const failure = await rt
      .parse(
        'const a = 1;',
        { language: 'javascript' },
        { deadline: Deadline.of({ signal: controller.signal }) },
      )
      .catch((e) => e);
    expect(failure).toBeInstanceOf(OperationAbortedError);
    expect(rt.liveTrees).toBe(0);
  });

  test('a time budget cuts a long parse short, even though parsing is synchronous', async () => {
    const rt = runtime();
    await rt.preload(['javascript']);
    const huge = Array.from(
      { length: 400_000 },
      (_, i) => `function f${i}(a, b) { return a + b * ${i}; }`,
    ).join('\n');
    const started = performance.now();
    const failure = await rt
      .parse(huge, { language: 'javascript' }, { deadline: Deadline.of({ timeoutMs: 25 }) })
      .catch((e) => e);
    const elapsed = performance.now() - started;
    expect(failure).toBeInstanceOf(DeadlineExceededError);
    expect(rt.liveTrees).toBe(0);
    // It was abandoned well before a full parse of this input would finish.
    expect(elapsed).toBeLessThan(5000);
  });

  test('the same runtime keeps working after a parse was cancelled', async () => {
    const rt = runtime();
    const huge = Array.from({ length: 200_000 }, (_, i) => `const v${i} = ${i};`).join('\n');
    await rt
      .parse(huge, { language: 'javascript' }, { deadline: Deadline.of({ timeoutMs: 10 }) })
      .catch((e) => e);
    await rt.withTree('const ok = 1;', { language: 'javascript' }, (tree) => {
      expect(tree.hasErrors).toBe(false);
    });
  });
});

describe('lifecycle', () => {
  test('a disposed runtime refuses work with a typed error', async () => {
    const rt = runtime();
    (await rt.parse('const a = 1;', { language: 'javascript' })).dispose();
    await rt.dispose();
    await rt.dispose();
    const failure = await rt.parse('x', { language: 'javascript' }).catch((e) => e);
    expect(failure).toBeInstanceOf(RuntimeDisposedError);
  });

  test('the parser runtime cannot be started twice with different wasm locations', async () => {
    (await runtime().parse('const a = 1;', { language: 'javascript' })).dispose();
    const other = runtime({ runtimeWasm: join(dir.path, 'elsewhere.wasm') });
    const failure = await other.parse('x', { language: 'typescript' }).catch((e) => e);
    expect(failure).toBeInstanceOf(RuntimeInitError);
    expect(failure.context.requested).toContain('elsewhere.wasm');
  });
});
