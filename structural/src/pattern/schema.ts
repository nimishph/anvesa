/**
 * Mode 2 Declarative Pattern Schema.
 *
 * This is the canonical AST format authored by humans and AI agents.
 * An LLM or developer declares semantic target, constraints, and parameters here;
 * the PatternCompiler compiles it deterministically into Mode 1 WQL.
 */

export type TargetKind =
  | 'function'
  | 'method'
  | 'callable'
  | 'class'
  | 'interface'
  | 'struct'
  | 'type'
  | 'custom';

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

export type FilterOp = 'eq' | 'contains' | 'starts' | 'ends' | 'regex' | 'exists';

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
