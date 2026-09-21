import { afterAll, describe, expect, test } from 'bun:test';
import { disposeEngines, makeEngine } from './test-support.ts';

afterAll(disposeEngines);
const engine = makeEngine();

const TS = `import { Widget as Imported } from './w';
/** A widget. */
export type Widget = { size: number };
export interface Store { get(k: string): Widget }
export class Shelf {
  put(w: Widget): Widget { return w; }
}
export function build(x: Widget, y: Array<Widget>): Widget { return x; }
const make = (w: Widget) => w;
enum Colour { Red }
`;

async function lines(source: string, query: string, path = 'a.ts'): Promise<number[]> {
  const result = await engine.queryDirect(query, source, { path });
  return result.items.map((hit) => hit.startLine as number);
}

describe('the declaration attribute', () => {
  test('a type is asked for by name without its mentions when the query says declaration', async () => {
    const everything = await lines(TS, '//type[@name="Widget"]');
    expect(everything.length).toBeGreaterThan(3);
    // The one place the type is defined, and nothing that merely mentions it.
    expect(await lines(TS, '//type[@name="Widget"][@declaration]')).toEqual([3]);
  });

  test('functions, classes, methods, interfaces, enums and variables declare what they name', async () => {
    for (const [query, expected] of [
      ['//function[@name="build"][@declaration]', [8]],
      ['//class[@name="Shelf"][@declaration]', [5]],
      ['//method[@name="put"][@declaration]', [6]],
      ['//interface[@name="Store"][@declaration]', [4]],
      ['//enum[@name="Colour"][@declaration]', [10]],
      ['//variable[@name="make"][@declaration]', [9]],
    ] as const) {
      expect(await lines(TS, query)).toEqual(expected as unknown as number[]);
    }
  });

  test('an import names what it brings in without declaring it', async () => {
    expect((await lines(TS, '//import[@declaration]')).length).toBe(0);
    expect((await lines(TS, '//import')).length).toBe(1);
  });

  test('nodes that have no name never declare', async () => {
    expect((await lines(TS, '//*[@declaration][@name]')).length).toBeGreaterThan(5);
    const result = await engine.queryDirect('//*[@declaration]', TS, { path: 'a.ts' });
    for (const hit of result.items) expect(hit.name).toBeDefined();
  });

  test('Python declarations carry it too, and a call does not', async () => {
    const py =
      'import os\n\ndef load(p):\n    return os.path.join(p)\n\nclass Store:\n    def get(self):\n        return load(1)\n';
    const result = await engine.queryDirect('//*[@declaration]', py, { path: 'a.py' });
    expect(result.items.map((hit) => `${hit.tag}:${hit.name}`)).toEqual([
      'function:load',
      'class:Store',
      'function:Store.get',
    ]);
  });
});
