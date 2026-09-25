import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StructuralEngine } from '@cntxt-labs/anvesa-structural';
import { directorySource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import { FactExtractor } from './extract.ts';

/** Needs the PHP grammar, which is installed per machine: `anvesa grammar install php`. */
const grammars = join(import.meta.dir, '../../../.anvesa/grammars');
const available = existsSync(join(grammars, 'tree-sitter-php.wasm'));
const runtime = new SyntaxRuntime({ sources: [directorySource('local', grammars)] });
const extractor = new FactExtractor(new StructuralEngine({ runtime }));
afterAll(() => runtime.dispose());

const source = String.raw`<?php
namespace App\Http;
use App\Models\Model;
class Controller {
  private Service $svc;
  public function __construct(private Model $m, ?Service $s, int|Bar $u, $plain) {}
  public function show(\App\Req $r): ?Order {
    $x = new Model($r->all());
    Facade::get($id)->run();
    return $x;
  }
}
`;

describe.skipIf(!available)('PHP declared types', () => {
  test('parameters, properties, promoted parameters, locals and return types are recorded', async () => {
    const facts = await extractor.extract('a.php', source);
    expect(facts.types?.map((t) => [t.scope.split('#')[1], t.name, t.type, t.origin])).toEqual([
      ['Controller', '$svc', 'Service', 'property'],
      ['Controller.__construct', '$m', 'Model', 'promoted'],
      ['Controller.__construct', '$s', 'Service', 'param'],
      // A union of a scalar and one class is that class; two classes would be no type at all.
      ['Controller.__construct', '$u', 'Bar', 'param'],
      ['Controller.show', '', 'Order', 'return'],
      ['Controller.show', '$r', String.raw`\App\Req`, 'param'],
      ['Controller.show', '$x', 'Model', 'assigned'],
    ]);
  });

  test('a call on a call result carries the inner call as its receiver', async () => {
    const facts = await extractor.extract('a.php', source);
    const run = facts.calls.find((c) => c.name === 'run');
    expect(run?.receiver).toEqual({
      kind: 'result',
      name: 'get',
      receiver: { kind: 'name', name: 'Facade' },
    });
  });
});
