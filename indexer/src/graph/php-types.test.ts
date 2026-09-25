import { describe, expect, test } from 'bun:test';
import type { CallFact, FileFacts, ImportFact, SymbolFact, TypeFact } from '../extract/index.ts';
import { MemoryIndexStore } from '../store/memory-index-store.ts';
import type { EdgeRecord } from '../store/types.ts';
import { GraphLinker } from './link.ts';
import { ImportResolver } from './resolver.ts';

/**
 * PHP call resolution over facts written by hand, so it runs without the PHP grammar. The facts
 * are what the extractor produces for the sources shown in each test's comments.
 */

const symbol = (path: string, name: string, kind: string, parentId?: string): SymbolFact => ({
  id: `${path}#${name}`,
  path,
  name,
  baseName: name.split('.').at(-1) as string,
  kind,
  parentId,
  exported: undefined,
  startLine: 1,
  endLine: 2,
  signature: undefined,
  doc: undefined,
});

const use = (specifier: string): ImportFact => ({
  specifier,
  kind: 'static',
  relative: false,
  typeOnly: false,
  bindings: [
    {
      imported: specifier.split('\\').at(-1) as string,
      local: specifier.split('\\').at(-1) as string,
      typeOnly: false,
    },
  ],
  line: 1,
});

const call = (
  from: string,
  name: string,
  receiver: CallFact['receiver'],
  kind: CallFact['kind'] = 'call',
): CallFact => ({ from, name, receiver, kind, line: 1 });

interface PhpFile {
  readonly path: string;
  readonly namespace: string;
  readonly symbols?: readonly SymbolFact[];
  readonly imports?: readonly ImportFact[];
  readonly calls?: readonly CallFact[];
  readonly types?: readonly TypeFact[];
}

async function link(files: readonly PhpFile[]) {
  const store = new MemoryIndexStore();
  for (const file of files) {
    const facts: FileFacts = {
      path: file.path,
      language: 'php',
      symbols: [symbol(file.path, file.namespace, 'namespace'), ...(file.symbols ?? [])],
      calls: file.calls ?? [],
      imports: file.imports ?? [],
      exports: [],
      hasSyntaxErrors: false,
      importsSupported: true,
      gaps: { unnamedCalls: 0, computedImports: 0 },
      ...(file.types ? { types: file.types } : {}),
    };
    await store.replaceFile({
      path: file.path,
      language: 'php',
      packageRoot: undefined,
      repo: '',
      size: 1,
      mtimeMs: 1,
      contentHash: file.path,
      facts,
    });
  }
  const known = new Set(files.map((file) => file.path));
  const resolver = new ImportResolver(
    { exists: async (path) => known.has(path), read: async () => undefined },
    [],
  );
  const linker = new GraphLinker(store, resolver);
  await linker.linkAll();
  const edges: EdgeRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.findEdges(cursor === undefined ? {} : { cursor });
    edges.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return edges;
}

const show = 'app/Http/OrderController.php#OrderController.show';

/**
 * namespace App\Models;      class Model { function __construct($d) {} function save() {} }
 * namespace App\Facades;     class Order { function getOrderObject() {} }
 *                            class OrderFacade { static function get($id): Order {} }
 * namespace App\Other;       class Other { function get() {} }
 * namespace App\Http;        use App\Models\Model; use App\Facades\OrderFacade; use Illuminate\Http\Request;
 */
const workspace: readonly PhpFile[] = [
  {
    path: 'app/Models/Model.php',
    namespace: 'App\\Models',
    symbols: [
      symbol('app/Models/Model.php', 'Model', 'class'),
      symbol('app/Models/Model.php', 'Model.__construct', 'method', 'app/Models/Model.php#Model'),
      symbol('app/Models/Model.php', 'Model.save', 'method', 'app/Models/Model.php#Model'),
    ],
  },
  {
    path: 'app/Facades/Order.php',
    namespace: 'App\\Facades',
    symbols: [
      symbol('app/Facades/Order.php', 'Order', 'class'),
      symbol(
        'app/Facades/Order.php',
        'Order.getOrderObject',
        'method',
        'app/Facades/Order.php#Order',
      ),
    ],
  },
  {
    path: 'app/Facades/OrderFacade.php',
    namespace: 'App\\Facades',
    symbols: [
      symbol('app/Facades/OrderFacade.php', 'OrderFacade', 'class'),
      symbol(
        'app/Facades/OrderFacade.php',
        'OrderFacade.get',
        'method',
        'app/Facades/OrderFacade.php#OrderFacade',
      ),
    ],
    types: [
      {
        scope: 'app/Facades/OrderFacade.php#OrderFacade.get',
        name: '',
        type: 'Order',
        origin: 'return',
      },
    ],
  },
  {
    path: 'app/Other/Other.php',
    namespace: 'App\\Other',
    symbols: [
      symbol('app/Other/Other.php', 'Other', 'class'),
      symbol('app/Other/Other.php', 'Other.get', 'method', 'app/Other/Other.php#Other'),
    ],
  },
  {
    path: 'app/Http/OrderController.php',
    namespace: 'App\\Http',
    imports: [
      use('App\\Models\\Model'),
      use('App\\Facades\\OrderFacade'),
      use('Illuminate\\Http\\Request'),
    ],
    symbols: [
      symbol('app/Http/OrderController.php', 'OrderController', 'class'),
      symbol(
        'app/Http/OrderController.php',
        'OrderController.show',
        'method',
        'app/Http/OrderController.php#OrderController',
      ),
    ],
    types: [
      { scope: show, name: '$request', type: 'Request', origin: 'param' },
      { scope: show, name: '$m', type: 'Model', origin: 'param' },
    ],
    calls: [
      // $request->get()
      call(show, 'get', { kind: 'name', name: '$request' }),
      // $m->save()
      call(show, 'save', { kind: 'name', name: '$m' }),
      // new Model($data)
      call(show, 'Model', undefined, 'new'),
      // OrderFacade::get($id)->getOrderObject()
      call(show, 'getOrderObject', {
        kind: 'result',
        name: 'get',
        receiver: { kind: 'name', name: 'OrderFacade' },
      }),
      call(show, 'get', { kind: 'name', name: 'OrderFacade' }),
      // $untyped->get()
      call(show, 'get', { kind: 'name', name: '$untyped' }),
    ],
  },
];

describe('PHP calls through declared types', () => {
  test('a call on a typed parameter is resolved to that class, not to any method of that name', async () => {
    const edges = await link(workspace);
    const fromShow = edges.filter((edge) => edge.from === show);
    // `$request` is an `Illuminate\Http\Request`: outside the workspace, so never `Other.get`.
    expect(fromShow).toContainEqual({
      from: show,
      to: 'Illuminate\\Http\\Request#get',
      kind: 'calls:external',
      confidence: 'exact',
    });
  });

  test('only a call with no declared type is a guess, and it says so', async () => {
    const edges = await link(workspace);
    const guesses = edges.filter((edge) => edge.kind === 'calls:name');
    expect(guesses).toEqual([
      {
        from: show,
        to: 'app/Facades/OrderFacade.php#OrderFacade.get',
        kind: 'calls:name',
        confidence: 'guess',
      },
    ]);
  });

  test('a method of a typed parameter is an inferred call', async () => {
    const edges = await link(workspace);
    expect(edges).toContainEqual({
      from: show,
      to: 'app/Models/Model.php#Model.save',
      kind: 'calls',
      confidence: 'inferred',
    });
  });

  test('new X() calls the class and its constructor', async () => {
    const edges = await link(workspace);
    expect(edges).toContainEqual({
      from: show,
      to: 'app/Models/Model.php#Model',
      kind: 'calls',
      confidence: 'exact',
    });
    expect(edges).toContainEqual({
      from: show,
      to: 'app/Models/Model.php#Model.__construct',
      kind: 'calls',
      confidence: 'exact',
    });
  });

  test('a call on a call result follows the declared return type', async () => {
    const edges = await link(workspace);
    expect(edges).toContainEqual({
      from: show,
      to: 'app/Facades/OrderFacade.php#OrderFacade.get',
      kind: 'calls',
      confidence: 'exact',
    });
    expect(edges).toContainEqual({
      from: show,
      to: 'app/Facades/Order.php#Order.getOrderObject',
      kind: 'calls',
      confidence: 'inferred',
    });
  });

  test('a typed property is followed from $this', async () => {
    const controller = 'app/Http/Svc.php#Svc';
    const run = 'app/Http/Svc.php#Svc.run';
    const edges = await link([
      ...workspace,
      {
        path: 'app/Http/Svc.php',
        namespace: 'App\\Http',
        imports: [use('App\\Models\\Model')],
        symbols: [
          symbol('app/Http/Svc.php', 'Svc', 'class'),
          symbol('app/Http/Svc.php', 'Svc.__construct', 'method', controller),
          symbol('app/Http/Svc.php', 'Svc.run', 'method', controller),
        ],
        types: [
          {
            scope: 'app/Http/Svc.php#Svc.__construct',
            name: '$m',
            type: 'Model',
            origin: 'promoted',
          },
        ],
        // $this->m->save()
        calls: [call(run, 'save', { kind: 'name', name: '$this.m' })],
      },
    ]);
    expect(edges).toContainEqual({
      from: run,
      to: 'app/Models/Model.php#Model.save',
      kind: 'calls',
      confidence: 'inferred',
    });
  });

  test('a method the declared class does not declare is unresolved, not guessed', async () => {
    const edges = await link([
      ...workspace.filter((file) => file.path !== 'app/Http/OrderController.php'),
      {
        path: 'app/Http/OrderController.php',
        namespace: 'App\\Http',
        imports: [use('App\\Models\\Model')],
        symbols: [
          symbol('app/Http/OrderController.php', 'OrderController', 'class'),
          symbol(
            'app/Http/OrderController.php',
            'OrderController.show',
            'method',
            'app/Http/OrderController.php#OrderController',
          ),
        ],
        types: [{ scope: show, name: '$m', type: 'Model', origin: 'param' }],
        calls: [call(show, 'get', { kind: 'name', name: '$m' })],
      },
    ]);
    expect(edges.filter((edge) => edge.from === show)).toEqual([
      { from: show, to: 'get', kind: 'calls:unresolved', confidence: 'exact' },
    ]);
  });
});
