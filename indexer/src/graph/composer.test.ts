import { describe, expect, test } from 'bun:test';
import type { ImportFact } from '../extract/index.ts';
import type { WorkspacePackage } from '../workspace/discover.ts';
import { composerCandidates, parseComposerConfig } from './composer.ts';
import { ImportResolver, type ResolverEnvironment } from './resolver.ts';

function environment(files: Record<string, string>): ResolverEnvironment {
  return {
    exists: async (path) => path in files,
    read: async (path) => files[path],
  };
}

const fact = (specifier: string, over: Partial<ImportFact> = {}): ImportFact => ({
  specifier,
  kind: 'static',
  relative: false,
  bindings: [],
  typeOnly: false,
  line: 1,
  ...over,
});

describe('Composer PSR-4 configuration', () => {
  test('parses autoload and autoload-dev psr-4 mappings, longest prefix first', () => {
    const json = JSON.stringify({
      name: 'pixart/app',
      autoload: {
        'psr-4': {
          'App\\': 'app/',
          'App\\Helpers\\': 'app/Helpers/Special/',
        },
      },
      'autoload-dev': {
        'psr-4': {
          'Tests\\': ['tests/', 'tests/legacy/'],
        },
      },
    });

    const config = parseComposerConfig(json, 'backend/composer.json');
    expect(config).toBeDefined();
    expect(config?.root).toBe('backend');
    expect(config?.rules).toEqual([
      { prefix: 'App\\Helpers\\', targets: ['app/Helpers/Special'] },
      { prefix: 'Tests\\', targets: ['tests', 'tests/legacy'] },
      { prefix: 'App\\', targets: ['app'] },
    ]);
  });

  test('parses PSR-0 mappings with underscore substitution', () => {
    const json = JSON.stringify({
      autoload: {
        'psr-0': {
          Acme_: 'src/',
        },
      },
    });

    const config = parseComposerConfig(json, 'composer.json');
    expect(config).toBeDefined();
    expect(config?.rules).toEqual([{ prefix: 'Acme_', targets: ['src'], isPsr0: true }]);

    const candidates = config ? composerCandidates(config, 'Acme_Util_String') : [];
    expect(candidates).toEqual(['src/Acme/Util/String.php']);
  });

  test('generates candidate paths with prefix stripped and longest prefix prioritized', () => {
    const config = parseComposerConfig(
      JSON.stringify({
        autoload: {
          'psr-4': {
            'App\\': 'app/',
            'App\\Helpers\\': 'app/Helpers/Special/',
          },
        },
      }),
      'backend/composer.json',
    );
    expect(config).toBeDefined();

    const candidates = config ? composerCandidates(config, 'App\\Helpers\\PixartOrderFacade') : [];
    expect(candidates).toEqual([
      'backend/app/Helpers/Special/PixartOrderFacade.php',
      'backend/app/Helpers/PixartOrderFacade.php',
    ]);
  });
});

describe('PHP ImportResolver with Composer', () => {
  test('resolves App\\Helpers\\PixartOrderFacade to backend/app/... via composer prefix mapping', async () => {
    const composerJson = JSON.stringify({
      name: 'pixart/backend',
      autoload: {
        'psr-4': {
          'App\\': 'app/',
          'Database\\Factories\\': 'database/factories/',
        },
      },
      'autoload-dev': {
        'psr-4': {
          'Tests\\': 'tests/',
        },
      },
    });

    const files = {
      'backend/composer.json': composerJson,
      'backend/app/Http/Controllers/OrderController.php': '',
      'backend/app/Helpers/PixartOrderFacade.php': '',
      'backend/database/factories/OrderFactory.php': '',
      'backend/tests/Unit/OrderTest.php': '',
    };

    const pkg: WorkspacePackage = {
      name: 'pixart/backend',
      root: 'backend',
      kind: 'generic',
      manifest: 'backend/composer.json',
      dependsOn: [],
    };

    const resolver = new ImportResolver(environment(files), [pkg]);

    // Test App\Helpers\PixartOrderFacade resolves to lowercase backend/app/...
    const facade = await resolver.resolve(
      'backend/app/Http/Controllers/OrderController.php',
      fact('App\\Helpers\\PixartOrderFacade'),
      'php',
    );
    expect(facade.resolution).toEqual({
      kind: 'file',
      path: 'backend/app/Helpers/PixartOrderFacade.php',
      via: 'module',
    });

    // Test database factories
    const factory = await resolver.resolve(
      'backend/app/Http/Controllers/OrderController.php',
      fact('Database\\Factories\\OrderFactory'),
      'php',
    );
    expect(factory.resolution).toEqual({
      kind: 'file',
      path: 'backend/database/factories/OrderFactory.php',
      via: 'module',
    });

    // Test autoload-dev tests
    const testCase = await resolver.resolve(
      'backend/tests/Unit/OrderTest.php',
      fact('Tests\\Unit\\OrderTest'),
      'php',
    );
    expect(testCase.resolution).toEqual({
      kind: 'file',
      path: 'backend/tests/Unit/OrderTest.php',
      via: 'module',
    });
  });

  test('resolves cross-package imports using other workspace composer configs', async () => {
    const backendComposer = JSON.stringify({
      autoload: { 'psr-4': { 'App\\': 'app/' } },
    });
    const sharedComposer = JSON.stringify({
      autoload: { 'psr-4': { 'Shared\\': 'src/' } },
    });

    const files = {
      'backend/composer.json': backendComposer,
      'backend/app/Http/Controllers/OrderController.php': '',
      'shared/composer.json': sharedComposer,
      'shared/src/Logger.php': '',
    };

    const pkgs: WorkspacePackage[] = [
      {
        name: 'backend',
        root: 'backend',
        kind: 'generic',
        manifest: 'backend/composer.json',
        dependsOn: [],
      },
      {
        name: 'shared',
        root: 'shared',
        kind: 'generic',
        manifest: 'shared/composer.json',
        dependsOn: [],
      },
    ];

    const resolver = new ImportResolver(environment(files), pkgs);
    const resolved = await resolver.resolve(
      'backend/app/Http/Controllers/OrderController.php',
      fact('Shared\\Logger'),
      'php',
    );
    expect(resolved.resolution).toEqual({
      kind: 'file',
      path: 'shared/src/Logger.php',
      via: 'module',
    });
  });

  test('fallback heuristic favors lowercase app directory when no composer.json exists', async () => {
    const files = {
      'backend/app/Http/Controllers/OrderController.php': '',
      'backend/app/Helpers/PixartOrderFacade.php': '',
    };
    const pkg: WorkspacePackage = {
      name: 'backend',
      root: 'backend',
      kind: 'generic',
      manifest: undefined,
      dependsOn: [],
    };

    const resolver = new ImportResolver(environment(files), [pkg]);
    const facade = await resolver.resolve(
      'backend/app/Http/Controllers/OrderController.php',
      fact('App\\Helpers\\PixartOrderFacade'),
      'php',
    );
    expect(facade.resolution).toEqual({
      kind: 'file',
      path: 'backend/app/Helpers/PixartOrderFacade.php',
      via: 'module',
    });
  });

  test('end-to-end: GraphLinker files import as source and finds callers of PixartOrderFacade.get', async () => {
    const composerJson = JSON.stringify({
      autoload: {
        'psr-4': {
          'App\\': 'app/',
        },
      },
    });

    const files = {
      'backend/composer.json': composerJson,
      'backend/app/Http/Controllers/OrderController.php': '',
      'backend/app/Helpers/PixartOrderFacade.php': '',
    };

    const pkg: WorkspacePackage = {
      name: 'backend',
      root: 'backend',
      kind: 'generic',
      manifest: 'backend/composer.json',
      dependsOn: [],
    };

    const resolver = new ImportResolver(environment(files), [pkg]);
    const { MemoryIndexStore } = await import('../store/memory-index-store.ts');
    const { GraphLinker } = await import('./link.ts');
    const { GraphQueries } = await import('./queries.ts');

    const store = new MemoryIndexStore();
    await store.replaceFile({
      path: 'backend/app/Helpers/PixartOrderFacade.php',
      language: 'php',
      packageRoot: 'backend',
      repo: '',
      size: 100,
      mtimeMs: 1,
      contentHash: 'h1',
      facts: {
        path: 'backend/app/Helpers/PixartOrderFacade.php',
        language: 'php',
        symbols: [
          {
            id: 'backend/app/Helpers/PixartOrderFacade.php#PixartOrderFacade',
            name: 'PixartOrderFacade',
            baseName: 'PixartOrderFacade',
            kind: 'class',
            startLine: 3,
            endLine: 10,
            exported: true,
            path: 'backend/app/Helpers/PixartOrderFacade.php',
            parentId: undefined,
            signature: undefined,
            doc: undefined,
          },
          {
            id: 'backend/app/Helpers/PixartOrderFacade.php#PixartOrderFacade.get',
            name: 'PixartOrderFacade.get',
            baseName: 'get',
            kind: 'method',
            parentId: 'backend/app/Helpers/PixartOrderFacade.php#PixartOrderFacade',
            startLine: 5,
            endLine: 7,
            exported: true,
            path: 'backend/app/Helpers/PixartOrderFacade.php',
            signature: undefined,
            doc: undefined,
          },
        ],
        imports: [],
        calls: [],
        exports: [],
        hasSyntaxErrors: false,
        importsSupported: true,
        gaps: { unnamedCalls: 0, computedImports: 0 },
      },
    });

    await store.replaceFile({
      path: 'backend/app/Http/Controllers/OrderController.php',
      language: 'php',
      packageRoot: 'backend',
      repo: '',
      size: 100,
      mtimeMs: 1,
      contentHash: 'h2',
      facts: {
        path: 'backend/app/Http/Controllers/OrderController.php',
        language: 'php',
        symbols: [
          {
            id: 'backend/app/Http/Controllers/OrderController.php#OrderController',
            name: 'OrderController',
            baseName: 'OrderController',
            kind: 'class',
            startLine: 3,
            endLine: 10,
            exported: true,
            path: 'backend/app/Http/Controllers/OrderController.php',
            parentId: undefined,
            signature: undefined,
            doc: undefined,
          },
        ],
        imports: [
          {
            specifier: 'App\\Helpers\\PixartOrderFacade',
            kind: 'static',
            relative: false,
            bindings: [
              { imported: 'PixartOrderFacade', local: 'PixartOrderFacade', typeOnly: false },
            ],
            typeOnly: false,
            line: 4,
          },
        ],
        calls: [
          {
            name: 'get',
            receiver: { kind: 'name', name: 'PixartOrderFacade' },
            from: 'backend/app/Http/Controllers/OrderController.php#OrderController',
            line: 6,
            kind: 'call',
          },
        ],
        exports: [],
        hasSyntaxErrors: false,
        importsSupported: true,
        gaps: { unnamedCalls: 0, computedImports: 0 },
      },
    });

    const linker = new GraphLinker(store, resolver);
    const report = await linker.linkFile('backend/app/Http/Controllers/OrderController.php');
    expect(report?.imports.resolved).toBe(1);
    expect(report?.imports.asset).toBe(0);
    expect(report?.calls.resolved).toBe(1);

    const queries = new GraphQueries(store);
    const callers = await queries.callers(
      'backend/app/Helpers/PixartOrderFacade.php#PixartOrderFacade.get',
    );
    expect(callers.items).toHaveLength(1);
    expect(callers.items[0]?.path).toBe('backend/app/Http/Controllers/OrderController.php');
  });
});
