import { describe, expect, test } from 'bun:test';
import { compilePattern, PatternCompileError } from './pattern/compiler.ts';
import type { PatternSpec } from './pattern/schema.ts';

describe('PatternCompiler (Mode 2 -> Mode 1 WQL)', () => {
  test('compiles a simple target into WQL', () => {
    const spec: PatternSpec = {
      name: 'api-handlers',
      description: 'Finds handler functions',
      target: {
        kind: 'function',
        nameStartsWith: 'handle',
        isDeclaration: true,
      },
    };

    const compiled = compilePattern(spec);
    expect(compiled.templateWql).toBe('//function[@name^="handle"][@declaration]');
    expect(compiled.diagnostics.length).toBe(0);
    expect(compiled.bind().wql).toBe('//function[@name^="handle"][@declaration]');
  });

  test('compiles callable target to //callable virtual selector', () => {
    const spec: PatternSpec = {
      name: 'all-saves',
      description: 'Finds save callables',
      target: {
        kind: 'callable',
        name: 'save',
      },
    };

    const compiled = compilePattern(spec);
    expect(compiled.templateWql).toBe('//callable[@name="save"]');
  });

  test('compiles scoped target with direct child combinator', () => {
    const spec: PatternSpec = {
      name: 'service-methods',
      description: 'Methods inside service class',
      target: {
        kind: 'method',
      },
      scope: {
        within: 'class',
        withinName: 'UserService',
        directChild: true,
      },
    };

    const compiled = compilePattern(spec);
    expect(compiled.templateWql).toBe('//class[@name="UserService"]>method');
  });

  test('supports parameterized bindings with defaults', () => {
    const spec: PatternSpec = {
      name: 'prefixed-callables',
      description: 'Finds callables matching a parameter prefix',
      target: {
        kind: 'callable',
        nameStartsWith: '$prefix',
      },
      params: [{ name: 'prefix', default: 'get', required: true }],
    };

    const compiled = compilePattern(spec);
    expect(compiled.templateWql).toBe('//callable[@name^="$prefix"]');

    // Default binding
    expect(compiled.bind().wql).toBe('//callable[@name^="get"]');

    // Explicit binding
    expect(compiled.bind({ prefix: 'post' }).wql).toBe('//callable[@name^="post"]');
  });

  test('throws PatternCompileError on undeclared parameter reference', () => {
    const spec: PatternSpec = {
      name: 'broken-pattern',
      description: 'Refers to $unknown without declaring it',
      target: {
        kind: 'function',
        nameStartsWith: '$unknown',
      },
    };

    expect(() => compilePattern(spec)).toThrow(PatternCompileError);
  });

  test('warns when a declared parameter is unused in template', () => {
    const spec: PatternSpec = {
      name: 'unused-param',
      description: 'Declares $ignored',
      target: {
        kind: 'function',
        name: 'fixed',
      },
      params: [{ name: 'ignored', default: 'foo' }],
    };

    const compiled = compilePattern(spec);
    const warnings = compiled.diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.message).toContain('never used in query template');
  });

  test('generates diagnostic hint when method search returns 0 in Python context', () => {
    const spec: PatternSpec = {
      name: 'methods',
      description: 'finds methods',
      target: { kind: 'method', name: 'process' },
    };

    const compiled = compilePattern(spec);
    const hint = compiled.diagnoseResults(0, ['python']);
    expect(hint).toBeDefined();
    expect(hint?.hint).toContain('callable');
  });
});
