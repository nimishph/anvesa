import { describe, expect, test } from 'bun:test';
import {
  extractFileOutline,
  isRustSyntaxAvailable,
  loadRustSyntax,
  parseFilesBatch,
  setRustSyntaxEnabled,
} from './rust-bridge.ts';

describe('Rust Native Tree-Sitter Syntax Bridge (anv-gjm)', () => {
  test('native syntax bridge availability is reported consistently', () => {
    const available = isRustSyntaxAvailable();
    const bridge = loadRustSyntax();
    expect(available).toBe(bridge !== null);
    if (!bridge) return;
    expect(typeof bridge.extractFileOutlineNative).toBe('function');
    expect(typeof bridge.parseFilesBatchNative).toBe('function');
  });

  test('extracts TypeScript functions, classes, interfaces, and imports', () => {
    const bridge = loadRustSyntax();
    if (!bridge) return;

    const source = `
import { Config } from './config';
import express from 'express';

/**
 * Initializes the server
 */
export function startServer(port: number): void {
  const app = express();
  app.listen(port);
}

export class AppManager {
  private active = false;

  start() {
    startServer(8080);
  }
}

export interface ServerOpts {
  host: string;
}
`;

    const outline = bridge.extractFileOutlineNative('src/server.ts', 'typescript', source);

    expect(outline.path).toBe('src/server.ts');
    expect(outline.language).toBe('typescript');
    expect(outline.hasSyntaxErrors).toBe(false);

    // Imports
    expect(outline.imports.length).toBe(2);
    expect(outline.imports[0]?.specifier).toBe('./config');
    expect(outline.imports[1]?.specifier).toBe('express');

    // Symbols: startServer, AppManager, start, ServerOpts
    const symbolNames = outline.symbols.map((s) => s.name);
    expect(symbolNames).toContain('startServer');
    expect(symbolNames).toContain('AppManager');
    expect(symbolNames).toContain('start');
    expect(symbolNames).toContain('ServerOpts');

    const fn = outline.symbols.find((s) => s.name === 'startServer');
    expect(fn?.kind).toBe('function');
    expect(fn?.exported).toBe(true);
    expect(fn?.doc).toContain('Initializes the server');

    const cls = outline.symbols.find((s) => s.name === 'AppManager');
    expect(cls?.kind).toBe('class');
    expect(cls?.exported).toBe(true);

    const m = outline.symbols.find((s) => s.name === 'start');
    expect(m?.kind).toBe('method');

    // Calls: express, listen, startServer
    const callNames = outline.calls.map((c) => c.name);
    expect(callNames).toContain('express');
  });

  test('extracts Python functions, classes, calls, and docstrings', () => {
    const bridge = loadRustSyntax();
    if (!bridge) return;

    const source = `
import sys

def compute_average(values):
    """Calculates the mean of values."""
    total = sum(values)
    return total / len(values)

class DataProcessor:
    def process(self, data):
        return compute_average(data)
`;

    const outline = bridge.extractFileOutlineNative('proc.py', 'python', source);

    expect(outline.path).toBe('proc.py');
    expect(outline.hasSyntaxErrors).toBe(false);

    const fn = outline.symbols.find((s) => s.name === 'compute_average');
    expect(fn?.kind).toBe('function');
    expect(fn?.doc).toBe('Calculates the mean of values.');
    expect(fn?.exported).toBe(true);

    const cls = outline.symbols.find((s) => s.name === 'DataProcessor');
    expect(cls?.kind).toBe('class');

    const callNames = outline.calls.map((c) => c.name);
    expect(callNames).toContain('sum');
  });

  test('parses multiple files in parallel across CPU cores using Rayon', () => {
    const bridge = loadRustSyntax();
    if (!bridge) return;

    const files = [
      {
        path: 'a.ts',
        language: 'typescript',
        source: 'export function funcA() { return 1; }',
      },
      {
        path: 'b.py',
        language: 'python',
        source: 'def func_b():\n    return 2\n',
      },
      {
        path: 'c.rs',
        language: 'rust',
        source: 'pub fn func_c() -> i32 { 3 }',
      },
      {
        path: 'd.go',
        language: 'go',
        source: 'package main\n\nfunc FuncD() int { return 4 }\n',
      },
    ];

    const results = bridge.parseFilesBatchNative(files);
    expect(results.length).toBe(4);

    expect(results[0]?.symbols[0]?.name).toBe('funcA');
    expect(results[1]?.symbols[0]?.name).toBe('func_b');
    expect(results[2]?.symbols[0]?.name).toBe('func_c');
    expect(results[3]?.symbols[0]?.name).toBe('FuncD');
  });

  test('gracefully handles syntax errors in malformed source', () => {
    const bridge = loadRustSyntax();
    if (!bridge) return;

    const malformed = 'export function broken( { return ';
    const outline = bridge.extractFileOutlineNative('bad.ts', 'typescript', malformed);

    expect(outline.path).toBe('bad.ts');
    expect(outline.hasSyntaxErrors).toBe(true);
  });

  test('TS wrapper extractFileOutline and parseFilesBatch function seamlessly in pure TS mode', () => {
    try {
      // Test native first
      setRustSyntaxEnabled(true);
      const code = `
import { Foo } from './foo';
export function calculate(val: number): number {
  return val * 2;
}
export class Calculator {
  compute() {
    return calculate(10);
  }
}
`;
      const nativeOutline = extractFileOutline('calc.ts', 'typescript', code);
      expect(nativeOutline.symbols.map((s) => s.name)).toContain('calculate');
      expect(nativeOutline.symbols.map((s) => s.name)).toContain('Calculator');

      // Test pure TS mode (core compiled to TS)
      setRustSyntaxEnabled(false);
      const tsOutline = extractFileOutline('calc.ts', 'typescript', code);
      expect(tsOutline.symbols.map((s) => s.name)).toContain('calculate');
      expect(tsOutline.symbols.map((s) => s.name)).toContain('Calculator');
      expect(tsOutline.symbols.map((s) => s.name)).toContain('compute');
      expect(tsOutline.imports[0]?.specifier).toBe('./foo');

      // Test batch parsing in pure TS mode
      const batch = parseFilesBatch([
        { path: 'a.ts', language: 'typescript', source: 'export function hello() {}' },
        { path: 'b.py', language: 'python', source: 'def greet():\n    pass' },
      ]);
      expect(batch.length).toBe(2);
      expect(batch[0]?.symbols[0]?.name).toBe('hello');
      expect(batch[1]?.symbols[0]?.name).toBe('greet');
    } finally {
      setRustSyntaxEnabled(true);
    }
  });
});
