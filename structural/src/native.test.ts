import { afterAll, describe, expect, test } from 'bun:test';
import { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import { StructuralEngine } from './engine.ts';
import { builtinMappings, type LanguageMapping, MappingRegistry } from './mapping.ts';
import { encodeNative, encodeNativeBatch, isNativeOutlineAvailable } from './native.ts';
import type { WNode } from './node.ts';
import { outlineSymbols } from './symbols.ts';
import { inspectTopology } from './training.ts';

const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
// The reference: web-tree-sitter, never the addon.
const engine = new StructuralEngine({ runtime, mappings: new MappingRegistry(), native: false });
afterAll(async () => {
  await runtime.dispose();
});

const mappingFor = (language: string) => {
  const found = builtinMappings().find((entry) => entry.languages.includes(language));
  expect(found).toBeDefined();
  return found?.mapping as LanguageMapping;
};

/** Plain, order-independent data: what two outlines must agree on. */
function plain(node: WNode): unknown {
  return {
    tag: node.tag,
    attrs: Object.fromEntries([...node.attrs].sort(([a], [b]) => a.localeCompare(b))),
    children: node.children.map(plain),
  };
}

const FIXTURES: Record<string, string> = {
  python: `"""Module doc: café ☕."""
import os
from typing import List

# Reads a file.
def load(path: str, *args, **kwargs) -> str:
    with open(path) as handle:
        return handle.read()

class Store(object):
    """Keeps things."""

    def get(self, key):
        def inner(x):
            return x
        if key in self.items:
            return self.items[key]
        raise KeyError(key)

    @property
    def size(self) -> int:
        return 0

    def stub(self):
        pass

numbers = lambda y: y + 1
values = [x for x in range(3) if x]
`,
  typescript: `import { readFile } from 'node:fs';

/** Parses things. */
export function parse(text: string, { strict, mode }: Options, ...rest: unknown[]): Result<string> {
  return { ok: true, text };
}

export const shout = (word: string): string => word.toUpperCase();
const alias = shout;

interface Options { strict: boolean; mode: 'a' | 'b' }
export type Result<T> = { ok: boolean; text: T };

export class Parser<T> extends Base implements Thing {
  private cache = new Map<string, T>();
  handler = async (event: Event) => { throw new Error('no'); };

  constructor(private readonly name: string) { super(); }

  // Gets a value — ünïcode.
  get(key: string): T | undefined {
    return this.cache.get(key);
  }

  static empty(): Parser<never> { return new Parser('empty'); }
}

enum Color { Red, Green }
namespace Space { export function inside() { return 1; } }
`,
  javascript: `const { join } = require('node:path');

function make(a, b = 2, ...more) {
  // nothing yet
}

const api = {
  on: () => 1,
  run(task) { return task(); },
};

export default class Runner {
  #count = 0;
  start() { this.#count += 1; return this.#count; }
}

module.exports = { make };
`,
  go: `package main

import (
\t"fmt"
\t"strings"
)

// Greeter says hello.
type Greeter struct {
\tName string
}

type Speaker interface {
\tSpeak() string
}

func (g *Greeter) Speak() string {
\treturn fmt.Sprintf("hi %s", strings.ToUpper(g.Name))
}

func main() {
\tg := &Greeter{Name: "x"}
\tfmt.Println(g.Speak())
\tfunc() { fmt.Println("inline") }()
}
`,
  rust: `use std::collections::HashMap;

/// A store.
pub struct Store {
    items: HashMap<String, String>,
}

pub trait Get {
    fn get(&self, key: &str) -> Option<&String>;
}

impl Get for Store {
    fn get(&self, key: &str) -> Option<&String> {
        self.items.get(key)
    }
}

mod inner {
    pub fn helper(x: i32) -> i32 { x + 1 }
}

pub enum Shape { Circle(f64), Square(f64) }

fn main() {
    let add = |a: i32, b: i32| a + b;
    println!("{}", add(1, 2));
}
`,
};

describe.skipIf(!isNativeOutlineAvailable())(
  'native outlines match web-tree-sitter outlines',
  () => {
    for (const [language, source] of Object.entries(FIXTURES)) {
      test(`${language}: the same outline, node for node, and the same symbols`, async () => {
        const mapping = mappingFor(language);
        const options = { path: `fixture.${language}`, docs: true, positions: true };
        const wasm = await engine.encode(source, { language }, options);
        const native = encodeNative(source, language, mapping, options);
        expect(native).toBeDefined();
        if (!native) return;
        expect(plain(native.root)).toEqual(plain(wasm.root));
        expect(native.stats.nodes).toBe(wasm.stats.nodes);
        expect(native.stats.deepest).toBe(wasm.stats.deepest);
        expect(native.hasSyntaxErrors).toBe(wasm.hasSyntaxErrors);

        const expected = outlineSymbols(wasm.root).map((symbol) => ({
          kind: symbol.kind,
          name: symbol.name,
          baseName: symbol.baseName,
          parentName: symbol.parentName,
          line: Number(symbol.node.attrs.get('line')),
          endLine: Number(symbol.node.attrs.get('endLine')),
          doc: symbol.doc ?? null,
          signature: symbol.signature ?? null,
          params: symbol.params ?? null,
          exported: symbol.exported ?? null,
          aliasOf: symbol.aliasOf ?? null,
        }));
        expect(native.symbols).toEqual(expected);
      });
    }

    test('a trained mapping is honoured: what it maps changes the native outline the same way', async () => {
      const base = mappingFor('python');
      const trained = {
        ...base,
        nodeTypeMap: { ...base.nodeTypeMap, yield: 'yield', with_statement: 'with' },
      };
      const source = 'def gen():\n    yield 1\n    with x:\n        pass\n';
      const own = new StructuralEngine({
        runtime,
        native: false,
        mappings: (() => {
          const registry = new MappingRegistry();
          registry.override(trained, { languages: ['python'] });
          return registry;
        })(),
      });
      const wasm = await own.encode(source, { language: 'python' });
      const native = encodeNative(source, 'python', trained);
      expect(plain(native?.root as WNode)).toEqual(plain(wasm.root));
      const tags = (native?.root.children[0]?.children ?? []).map((child) => child.tag);
      expect(tags).toEqual(['yield', 'with']);
    });

    test('a batch encodes every file it can, and says which it cannot', () => {
      const results = encodeNativeBatch(
        [
          { path: 'a.py', language: 'python', source: 'def a():\n    return 1\n' },
          { path: 'b.ts', language: 'typescript', source: 'function b() {}\n' },
          { path: 'c.rb', language: 'ruby', source: 'def c; end\n' },
        ],
        { python: mappingFor('python'), typescript: mappingFor('typescript') },
      );
      expect(results?.map((r) => r?.symbols.map((s) => s.name))).toEqual([['a'], ['b'], undefined]);
      expect(results?.[0]?.root.attrs.get('path')).toBe('a.py');
    });

    test('node-type statistics for training match, first-seen order included', async () => {
      const content = FIXTURES.python as string;
      const samples = [
        { path: 'a.py', content },
        { path: 'b.py', content: `${content}\nbroken(:\n` },
      ];
      const wasm = await inspectTopology(runtime, 'python', samples, { native: false });
      const native = await inspectTopology(runtime, 'python', samples);
      const plain = (topology: typeof wasm) => ({
        ...topology,
        types: [...topology.types].map(([type, stats]) => [
          type,
          {
            ...stats,
            fields: [...stats.fields].map(([field, counts]) => [field, [...counts]]),
            parents: [...stats.parents],
            ancestors: [...stats.ancestors],
            children: [...stats.children],
          },
        ]),
      });
      expect(plain(native)).toEqual(plain(wasm));
      expect(native.withSyntaxErrors).toEqual(['b.py']);
    });
  },
);
