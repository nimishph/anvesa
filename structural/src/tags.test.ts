import { describe, expect, test } from 'bun:test';
import { parseTagsQuery } from './tags.ts';

describe('reading a tags query', () => {
  test('definitions and calls, with the direct child that holds the name', () => {
    const rules = parseTagsQuery(`
; definitions
(class_definition
  name: (identifier) @name) @definition.class

((comment)* @doc
 .
 (function_definition name: (identifier) @name) @definition.function
 (#strip! @doc "^#\\\\s*"))

[
  (method_declaration name: (field_identifier) @name)
  (function_declaration name: (identifier) @name)
] @definition.method

(call function: [(identifier) @name (attribute attribute: (identifier) @name)]) @reference.call
`);
    expect(rules).toEqual([
      {
        type: 'class_definition',
        tag: 'class',
        role: 'declaration',
        kind: 'class',
        nameChild: 'identifier',
      },
      {
        type: 'function_definition',
        tag: 'function',
        role: 'declaration',
        kind: 'function',
        nameChild: 'identifier',
      },
      {
        type: 'method_declaration',
        tag: 'method',
        role: 'declaration',
        kind: 'method',
        nameChild: 'field_identifier',
      },
      {
        type: 'function_declaration',
        tag: 'method',
        role: 'declaration',
        kind: 'method',
        nameChild: 'identifier',
      },
      { type: 'call', tag: 'call', role: 'call', kind: 'call' },
    ]);
  });

  test('what a mapping cannot follow is marked: nested names, context, unknown kinds', () => {
    const rules = parseTagsQuery(`
(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class
(module (expression_statement (assignment left: (identifier) @name) @definition.constant))
(macro_invocation macro: (identifier) @name) @definition.oddity
(class_definition name: (identifier) @name) @definition.class
(class_definition name: (constant) @name) @definition.module
(identifier) @reference.class
`);
    expect(rules).toEqual([
      { type: 'declaration', tag: 'class', role: 'declaration', kind: 'class', nestedName: true },
      {
        type: 'assignment',
        tag: 'constant',
        role: 'declaration',
        kind: 'constant',
        nameChild: 'identifier',
        within: 'expression_statement',
      },
      {
        type: 'macro_invocation',
        tag: '',
        role: 'declaration',
        kind: 'oddity',
        nameChild: 'identifier',
      },
      // The first rule for a type stands; references other than calls are not outline material.
      {
        type: 'class_definition',
        tag: 'class',
        role: 'declaration',
        kind: 'class',
        nameChild: 'identifier',
      },
    ]);
  });
});
