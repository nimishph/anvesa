import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isNativeLanguage, StructuralEngine } from '@cntxt-labs/anvesa-structural';
import { directorySource, npmPackageSource, SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import { FactExtractor } from './extract.ts';

/** PHP's grammar is installed per machine; the rest come with the packages. */
const localGrammars = join(import.meta.dir, '../../../.anvesa/grammars');
const runtime = new SyntaxRuntime({
  sources: [
    npmPackageSource(import.meta.filename),
    ...(existsSync(localGrammars) ? [directorySource('local', localGrammars)] : []),
  ],
});
afterAll(() => runtime.dispose());
/** The reference parses on web-tree-sitter, so a language needs its wasm grammar to be compared. */
const referenceReady = new Set(
  (await runtime.status())
    .filter((entry) => entry.grammar.state === 'ready')
    .map((entry) => entry.language.key),
);

const onWasm = new FactExtractor(new StructuralEngine({ runtime, native: false }));
const native = new FactExtractor(new StructuralEngine({ runtime }));

/** JSON drops what is undefined, as the index store does. */
const stored = (value: unknown) => JSON.parse(JSON.stringify(value));

const FIXTURES: Record<string, string> = {
  'src/app.ts': `import fs, { readFile as read, type Stats } from 'node:fs';
import * as path from 'node:path';
import type { Options } from './options';
import './polyfill';
import util = require('./util');
export { a, b as c } from './letters';
export * from './everything';
export * as ns from './namespace';
export type { Shape } from './shape';

const { join: glue, sep } = require('node:path');
const lazy = await import('./lazy');
const where = require(dynamicName);

export class Service extends Base {
  client = new HttpClient(config);
  async run(id: string): Promise<void> {
    await this.client.fetch<Data>(id)!;
    this.helpers.format(id);
    super.run(id);
    read(id).then((x) => x.trim());
    (await load())();
    items[0]();
    new Date();
    return Service.create().start();
  }
}

export function render() {
  return <Card title="x"><Layout.Header /><div /></Card>;
}

function local() {}
export { local, render as view };
export default Service;
`,
  'pkg/tool.py': `"""Tools."""
import os, sys as system
import a.b.c
from . import sibling
from ..parent import thing as other, more
from typing import *

class Runner(Base):
    def run(self, task):
        self.prepare(task)
        cls.build()
        os.path.join("a", "b")
        task.items[0].go()
        helper(task)()
        return super().run(task)

def helper(x):
    return Runner().run(x)
`,
  'web/main.js': `const express = require('express');
import { a } from './a.js';

module.exports.start = function start(app) {
  app.get('/', (req, res) => res.send(a()));
  express.Router();
};

function boot(port) {
  return express().listen(port);
}
`,
  'cmd/main.go': `package main

import "fmt"

type Server struct{}

func (s *Server) Start() { s.listen(); fmt.Println("up") }

func main() { NewServer().Start() }
`,
  'src/Shop.php': String.raw`<?php
namespace App;

use App\Models\{Order, Customer as Buyer};
use Vendor\Lib\Thing;

class Shop {
    private ?Order $current;
    public function __construct(private Repo $repo, int $count) {}
    public function find(int $id): ?Order {
        $order = new Order($id);
        $x = new \stdClass();
        $this->repo->save($order);
        return Order::query()->where($id)->first();
    }
}

function make(Buyer $buyer): Shop|Thing { return new Shop(); }
`,
};

describe('native facts match web-tree-sitter facts', () => {
  for (const [path, source] of Object.entries(FIXTURES)) {
    const language = runtime.registry.forPath(path)?.key ?? '';
    test.skipIf(!isNativeLanguage(language) || !referenceReady.has(language))(
      `${path}: symbols, calls, imports, exports and types`,
      async () => {
        const expected = await onWasm.extractWithStructure(path, source);
        const actual = await native.extractWithStructure(path, source);
        expect(stored(actual.facts)).toEqual(stored(expected.facts));
        expect(actual.wexpr).toBe(expected.wexpr);
        // The fixtures are meant to exercise every collector, not just agree on nothing.
        expect(actual.facts.symbols.length).toBeGreaterThan(0);
        expect(actual.facts.calls.length).toBeGreaterThan(0);
      },
    );
  }
});

describe('extracting many files at once', () => {
  const files = [
    ...Object.entries(FIXTURES).map(([path, source]) => ({ path, source })),
    // Not parsed natively (no mapping, or no language at all): read the way it would be alone.
    { path: 'notes/readme.unknown', source: 'just text' },
    { path: 'src/empty.ts', source: '' },
  ];

  test('gives each file what it would give alone, in order, failures included', async () => {
    const together = await native.extractManyWithStructure(files);
    expect(together).toHaveLength(files.length);
    for (const [index, file] of files.entries()) {
      const outcome = together[index];
      let alone: Awaited<ReturnType<typeof native.extractWithStructure>> | undefined;
      let failure: unknown;
      try {
        alone = await native.extractWithStructure(file.path, file.source);
      } catch (thrown) {
        failure = thrown;
      }
      if (failure !== undefined) {
        expect(outcome && 'failure' in outcome ? (outcome.failure as Error).message : '').toBe(
          (failure as Error).message,
        );
        continue;
      }
      expect(outcome !== undefined && 'extracted' in outcome).toBe(true);
      if (!outcome || !('extracted' in outcome)) continue;
      expect(stored(outcome.extracted.facts)).toEqual(stored(alone?.facts));
      expect(outcome.extracted.wexpr).toBe(alone?.wexpr ?? '');
    }
  });

  test('on web-tree-sitter alone, file by file, the answers are the same', async () => {
    const [file] = Object.entries(FIXTURES).map(([path, source]) => ({ path, source }));
    if (!file) return;
    const [first] = await onWasm.extractManyWithStructure([file]);
    const alone = await onWasm.extractWithStructure(file.path, file.source);
    expect(first && 'extracted' in first ? stored(first.extracted.facts) : undefined).toEqual(
      stored(alone.facts),
    );
  });
});
