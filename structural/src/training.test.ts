import { afterAll, describe, expect, test } from 'bun:test';
import { npmPackageSource, SyntaxRuntime } from '@sutras/code-lens-syntax';
import { MappingTrainingError } from './errors.ts';
import { builtinMappings, MappingRegistry } from './mapping.ts';
import {
  checkGolden,
  deduceMapping,
  inspectTopology,
  synthesizeGolden,
  type TrainingSample,
  trainMapping,
} from './training.ts';

const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
afterAll(async () => {
  await runtime.dispose();
});

const sample = (path: string, content: string): TrainingSample => ({ path, content });

const PYTHON = [
  sample(
    'a.py',
    `import os
from typing import List

def load(path):
    """Read a file."""
    with open(path) as handle:
        return handle.read()

class Store:
    def get(self, key):
        if key in self.items:
            return self.items[key]
        raise KeyError(key)

    def put(self, key, value):
        for k in list(self.items):
            pass
        self.items[key] = value

def main():
    store = Store()
    try:
        store.put("a", load("x"))
    except KeyError:
        pass
    while True:
        break
    return [x for x in range(3)]
`,
  ),
  sample(
    'b.py',
    `import sys
import json

def helper(x):
    return json.dumps(x)

class Other(object):
    def run(self):
        f = lambda y: y + 1
        return f(1)
`,
  ),
];

describe('learning a mapping from code', () => {
  test('Python: declarations, imports, calls and control flow, with the shipped mapping as the check', async () => {
    const report = await trainMapping(runtime, 'python', PYTHON, { extensions: ['.py'] });
    const { mapping } = report;
    expect(mapping.name).toBe('python');
    expect(mapping.nodeTypeMap).toMatchObject({
      function_definition: 'function',
      class_definition: 'class',
      import_statement: 'import',
      import_from_statement: 'import',
      call: 'call',
      if_statement: 'if',
      for_statement: 'for',
      while_statement: 'while',
      try_statement: 'try',
      with_statement: 'with',
      return_statement: 'return',
      lambda: 'lambda',
    });
    expect(mapping.nameExtractors).toMatchObject({
      function_definition: 'identifier',
      class_definition: 'identifier',
    });
    // Calls are everywhere, so they are recognised but kept out of the outline.
    expect(mapping.structuralTags).not.toContain('call');
    expect(mapping.callableTags).toEqual(expect.arrayContaining(['function', 'lambda']));

    // What the shipped, hand-written mapping calls the same nodes.
    const shipped = builtinMappings().find((entry) => entry.mapping.name === 'python')?.mapping;
    for (const type of ['function_definition', 'class_definition', 'import_statement', 'lambda']) {
      expect(mapping.nodeTypeMap[type]).toBe(shipped?.nodeTypeMap[type] as string);
    }
  });

  test('it does what it says: every mapped node comes out as its tag, and symbols are named', async () => {
    const report = await trainMapping(runtime, 'python', PYTHON, { extensions: ['.py'] });
    expect(report.verification.issues).toEqual([]);
    for (const check of report.verification.tags) expect(check.found).toBe(check.expected);
    expect(report.verification.symbols).toBeGreaterThanOrEqual(6);
    expect(report.deductions.find((d) => d.type === 'function_definition')).toMatchObject({
      role: 'declaration',
      nameChild: 'identifier',
      nameShare: 1,
    });
    // The trained mapping takes a registry's place for the language like any other.
    const registry = new MappingRegistry();
    registry.override(report.mapping, { languages: ['python'] });
    expect(registry.require('python').mapping).toBe(report.mapping);
  });

  test('a function is a method only when it never occurs outside a type that holds members', async () => {
    const java = await trainMapping(
      runtime,
      'java',
      [
        sample(
          'A.java',
          `package p;
import java.util.List;
public class A {
  private int n;
  public A(int n) { this.n = n; }
  public int get() { return n; }
  public void set(int v) { this.n = v; }
  @Override public String toString() { return "" + n; }
}
interface B { void run(); }
enum C { X, Y }
`,
        ),
      ],
      { extensions: ['.java'] },
    );
    expect(java.mapping.nodeTypeMap.method_declaration).toBe('method');
    expect(java.mapping.nodeTypeMap.class_declaration).toBe('class');
    expect(java.mapping.nodeTypeMap.interface_declaration).toBe('interface');
    expect(java.mapping.nodeTypeMap.enum_declaration).toBe('enum');
    // A Python module is not a type that holds members: its functions stay functions.
    const python = await trainMapping(runtime, 'python', PYTHON, { extensions: ['.py'] });
    expect(python.mapping.nodeTypeMap.function_definition).toBe('function');
  });

  test('a name field alone does not make a declaration, and expressions and clauses are not declarations', async () => {
    const java = await trainMapping(
      runtime,
      'java',
      [
        sample(
          'A.java',
          `class A {
  @Deprecated(since = "1") void old() {}
  void f(java.util.List<String> xs) {
    for (String x : xs) { g(x); }
    enum_like: for (int i = 0; i < 3; i++) { }
  }
  void g(String s) {}
}
`,
        ),
      ],
      { extensions: ['.java'] },
    );
    const map = java.mapping.nodeTypeMap;
    // A parameter has a name and no body; an annotation has a name and arguments and is not a call.
    expect(map.formal_parameter).toBeUndefined();
    expect(map.annotation).toBeUndefined();
    expect(map.method_invocation).toBe('call');
    // The enhanced `for` has a name and a body, and is still a loop.
    expect(map.enhanced_for_statement).toBe('for');

    const rust = await trainMapping(
      runtime,
      'rust',
      [
        sample(
          'a.rs',
          `use std::fmt;
enum Kind { A, B(u8) }
struct Point { x: i32, y: i32 }
impl Point {
    fn new(x: i32, y: i32) -> Self { Point { x, y } }
    fn norm(&self) -> i32 { self.x + self.y }
}
trait Shape { fn area(&self) -> i32; }
fn main() {
    let p = Point::new(1, 2);
    let q = Point { x: 3, y: 4 };
    match p.norm() { 0 => {}, _ => {} }
}
`,
        ),
      ],
      { extensions: ['.rs'] },
    );
    expect(rust.mapping.nodeTypeMap.struct_item).toBe('struct');
    expect(rust.mapping.nodeTypeMap.enum_item).toBe('enum');
    expect(rust.mapping.nodeTypeMap.function_item).toBe('function');
    expect(rust.mapping.nodeTypeMap.trait_item).toBe('trait');
    // `Point { x, y }` and `B(u8)` have names and bodies, and are a literal and a variant.
    expect(rust.mapping.nodeTypeMap.struct_expression).toBeUndefined();
    expect(rust.mapping.nodeTypeMap.enum_variant).toBeUndefined();
    // An impl block holds members but has no name: reported, not guessed.
    expect(rust.issues.find((i) => i.code === 'UNNAMED_DECLARATIONS')?.message).toContain(
      'impl_item',
    );
  });

  test('Go: declarations, methods, types and imports, and a call is not an outline node', async () => {
    const go = await trainMapping(
      runtime,
      'go',
      [
        sample(
          'a.go',
          `package main

import (
	"fmt"
	"os"
)

type Store struct{ items map[string]int }

type ID = string

func (s *Store) Get(k string) int { return s.items[k] }

func New() *Store { return &Store{} }

func main() {
	s := New()
	for i := 0; i < 3; i++ {
		fmt.Println(s.Get("a"))
	}
	if len(os.Args) > 1 {
		return
	}
	f := func() {}
	f()
}
`,
        ),
      ],
      { extensions: ['.go'] },
    );
    expect(go.mapping.nodeTypeMap).toMatchObject({
      function_declaration: 'function',
      method_declaration: 'method',
      type_spec: 'type',
      import_declaration: 'import',
      call_expression: 'call',
      if_statement: 'if',
      for_statement: 'for',
      func_literal: 'lambda',
    });
    expect(go.mapping.structuralTags).not.toContain('call');
    expect(go.verification.issues).toEqual([]);
  });

  test('what it cannot decide it reports: no declarations, few occurrences, samples that do not parse', async () => {
    const empty = await trainMapping(runtime, 'python', [sample('a.py', 'x = 1\ny = 2\n')], {
      extensions: ['.py'],
    });
    expect(empty.issues.map((i) => i.code)).toContain('NO_DECLARATIONS');

    const broken = await trainMapping(
      runtime,
      'python',
      [...PYTHON, sample('bad.py', 'def broken(:\n  class\n')],
      { extensions: ['.py'] },
    );
    const syntax = broken.issues.find((i) => i.code === 'SYNTAX_ERRORS');
    expect(syntax?.message).toContain('bad.py');

    const thin = await trainMapping(runtime, 'python', [PYTHON[1] as TrainingSample], {
      extensions: ['.py'],
    });
    expect(thin.issues.some((i) => i.code === 'FEW_OCCURRENCES')).toBe(true);

    await expect(
      trainMapping(runtime, 'python', [], { extensions: ['.py'] }),
    ).rejects.toBeInstanceOf(MappingTrainingError);
    // An empty file is a file with nothing to learn from, not a failure.
    const nothing = await trainMapping(runtime, 'python', [sample('a.py', '')], {
      extensions: ['.py'],
    });
    expect(nothing.issues.map((i) => i.code)).toContain('NO_DECLARATIONS');
  });

  test('the evidence threshold is the caller’s: a stricter share drops what a looser one keeps', async () => {
    const topology = await inspectTopology(runtime, 'python', PYTHON);
    const loose = deduceMapping(topology, { extensions: ['.py'], minShare: 0.1 });
    const strict = deduceMapping(topology, { extensions: ['.py'], minShare: 1.01 });
    expect(loose.mapping.nodeTypeMap.function_definition).toBeDefined();
    expect(strict.mapping.nodeTypeMap.function_definition).toBeUndefined();
    expect(strict.issues.map((i) => i.code)).toContain('NO_DECLARATIONS');
  });
});

describe('golden records', () => {
  test('a mapping run again over its samples matches; an edited mapping or sample is told apart', async () => {
    const report = await trainMapping(runtime, 'python', PYTHON, { extensions: ['.py'] });
    expect(await checkGolden(runtime, report.mapping, report.golden, PYTHON)).toEqual([]);

    // Drop what makes a function a function: the recorded outline no longer comes out.
    const edited = {
      ...report.mapping,
      nodeTypeMap: Object.fromEntries(
        Object.entries(report.mapping.nodeTypeMap).filter(
          ([type]) => type !== 'function_definition',
        ),
      ),
      structuralTags: report.mapping.structuralTags.filter((tag) => tag !== 'function'),
    };
    const regressions = await checkGolden(runtime, edited, report.golden, PYTHON);
    expect(regressions.map((r) => r.path)).toContain('a.py');
    expect(regressions[0]?.problem).toMatch(/tags differ|symbols differ/);

    const changed = [
      sample('a.py', `${PYTHON[0]?.content}\n# edited\n`),
      PYTHON[1] as TrainingSample,
    ];
    const notRegression = await checkGolden(runtime, report.mapping, report.golden, changed);
    expect(notRegression).toEqual([
      { path: 'a.py', problem: 'the sample changed since it was recorded' },
    ]);

    const missing = await checkGolden(runtime, report.mapping, report.golden, [
      PYTHON[0] as TrainingSample,
    ]);
    expect(missing).toEqual([{ path: 'b.py', problem: 'the sample is not here to check' }]);
  });

  test('records tags and symbols with their lines', async () => {
    const report = await trainMapping(runtime, 'python', PYTHON, { extensions: ['.py'] });
    const golden = await synthesizeGolden(runtime, 'python', report.mapping, PYTHON);
    const first = golden.samples[0];
    expect(first?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.symbols).toEqual(
      expect.arrayContaining([
        { kind: 'function', name: 'load', line: 4 },
        { kind: 'class', name: 'Store', line: 9 },
      ]),
    );
  });
});
