/**
 * Mode 2 Declarative Pattern Schema.
 *
 * This is the canonical AST format authored by humans and AI agents.
 * An LLM or developer declares semantic target, constraints, and parameters here;
 * the PatternCompiler compiles it deterministically into Mode 1 WQL.
 */

/** What a pattern finds. `schemas/pattern.v1.json` lists the same, and a test keeps them equal. */
export const TARGET_KINDS = [
  'function',
  'method',
  'callable',
  'class',
  'interface',
  'struct',
  'type',
  'custom',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface PatternTarget {
  readonly kind: TargetKind;
  readonly name?: string;
  readonly nameStartsWith?: string;
  readonly nameEndsWith?: string;
  readonly nameContains?: string;
  readonly nameRegex?: string;
  readonly customTag?: string;
  readonly isDeclaration?: boolean;
}

export const FILTER_OPS = ['eq', 'contains', 'starts', 'ends', 'regex', 'exists'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface PatternFilter {
  readonly attr: string;
  readonly op: FilterOp;
  readonly value: string;
}

export interface PatternScope {
  readonly within?: string;
  readonly withinName?: string;
  readonly directChild?: boolean;
}

export interface PatternParameter {
  readonly name: string;
  readonly description?: string;
  readonly default?: string;
  readonly required?: boolean;
}

export interface PatternSpec {
  readonly name: string;
  readonly description: string;
  readonly target: PatternTarget;
  readonly scope?: PatternScope;
  readonly filters?: readonly PatternFilter[];
  readonly params?: readonly PatternParameter[];
  readonly corpus?: string;
  readonly limit?: number;
}

/**
 * The fields each part of a spec may have. The compiler warns about any other, because a misspelt
 * field (`nameStartWith`) is otherwise ignored and the pattern quietly matches more than meant.
 * `schemas/pattern.v1.json` lists the same fields, and a test keeps them equal.
 */
export const PATTERN_FIELDS = {
  spec: [
    '$schema',
    'name',
    'description',
    'target',
    'scope',
    'filters',
    'params',
    'corpus',
    'limit',
  ],
  target: [
    'kind',
    'name',
    'nameStartsWith',
    'nameEndsWith',
    'nameContains',
    'nameRegex',
    'customTag',
    'isDeclaration',
  ],
  scope: ['within', 'withinName', 'directChild'],
  filter: ['attr', 'op', 'value'],
  param: ['name', 'description', 'default', 'required'],
} as const;
