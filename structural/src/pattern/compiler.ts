import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { StructuralSubsystemError } from '../errors.ts';
import { KNOWN_ATTRIBUTES } from '../node.ts';
import { parseWql, type WqlQuery } from '../wql.ts';
import type { PatternSpec } from './schema.ts';

export interface Diagnostic {
  readonly severity: 'error' | 'warning' | 'hint';
  readonly message: string;
  readonly field?: string;
  readonly hint?: string;
}

export interface CompiledPattern {
  readonly spec: PatternSpec;
  readonly templateWql: string;
  readonly parsedTemplate: WqlQuery;
  readonly diagnostics: readonly Diagnostic[];
  bind(args?: Record<string, string>): {
    readonly wql: string;
    readonly corpus?: string;
    readonly limit?: number;
  };
  diagnoseResults(resultCount: number, repoLanguages?: readonly string[]): Diagnostic | undefined;
}

/** A pattern spec that does not compile. Bad input, so it carries the invalid-argument code. */
export class PatternCompileError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_INVALID_ARGUMENT';

  constructor(
    message: string,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(message, {
      hint: 'Fix the pattern file under .anvesa/patterns/ (see the pattern file format in the README).',
      context: { diagnostics: diagnostics.map((d) => d.message) },
    });
    this.name = 'PatternCompileError';
  }
}

/**
 * Compiles a Mode 2 PatternSpec AST into a Mode 1 WQL query template with parameter slots ($param).
 * Statically checks attributes, parameter bindings, and language compatibility.
 */
export function compilePattern(spec: PatternSpec): CompiledPattern {
  const diagnostics: Diagnostic[] = [];
  const declaredParams = new Set((spec.params ?? []).map((p) => p.name));
  const usedParams = new Set<string>();

  // 1. Resolve Target Tag
  let targetTag: string;
  switch (spec.target.kind) {
    case 'callable':
      targetTag = 'callable';
      break;
    case 'function':
      targetTag = 'function';
      break;
    case 'method':
      targetTag = 'method';
      break;
    case 'class':
      targetTag = 'class';
      break;
    case 'interface':
      targetTag = 'interface';
      break;
    case 'struct':
      targetTag = 'struct';
      break;
    case 'type':
      targetTag = 'type';
      break;
    case 'custom':
      if (!spec.target.customTag) {
        diagnostics.push({
          severity: 'error',
          field: 'target.customTag',
          message: 'kind "custom" requires customTag to be specified',
        });
        targetTag = '*';
      } else {
        targetTag = spec.target.customTag;
      }
      break;
    default:
      diagnostics.push({
        severity: 'error',
        field: 'target.kind',
        message: `Unknown target kind "${String((spec.target as unknown as Record<string, unknown>).kind)}"`,
      });
      targetTag = '*';
  }

  // 2. Build WQL Predicates for Target
  const predicates: string[] = [];

  const checkParamRef = (val: string | undefined, field: string) => {
    if (!val) return;
    const match = val.match(/^\$([a-zA-Z0-9_-]+)$/);
    if (match) {
      const paramName = match[1];
      if (paramName) {
        usedParams.add(paramName);
        if (!declaredParams.has(paramName)) {
          diagnostics.push({
            severity: 'error',
            field,
            message: `Parameter "${paramName}" is referenced but not declared in params list`,
          });
        }
      }
    }
  };

  if (spec.target.name) {
    checkParamRef(spec.target.name, 'target.name');
    predicates.push(`[@name="${spec.target.name}"]`);
  }
  if (spec.target.nameStartsWith) {
    checkParamRef(spec.target.nameStartsWith, 'target.nameStartsWith');
    predicates.push(`[@name^="${spec.target.nameStartsWith}"]`);
  }
  if (spec.target.nameEndsWith) {
    checkParamRef(spec.target.nameEndsWith, 'target.nameEndsWith');
    predicates.push(`[@name$="${spec.target.nameEndsWith}"]`);
  }
  if (spec.target.nameContains) {
    checkParamRef(spec.target.nameContains, 'target.nameContains');
    predicates.push(`[contains(@name, "${spec.target.nameContains}")]`);
  }
  if (spec.target.nameRegex) {
    predicates.push(`[@name~="${spec.target.nameRegex}"]`);
  }
  if (spec.target.isDeclaration) {
    predicates.push('[@declaration]');
  }

  // 3. User-defined Filters
  for (const filter of spec.filters ?? []) {
    checkParamRef(filter.value, `filter.${filter.attr}`);
    if (!KNOWN_ATTRIBUTES.has(filter.attr) && !spec.corpus) {
      diagnostics.push({
        severity: 'warning',
        field: `filters[${filter.attr}]`,
        message: `Attribute "${filter.attr}" is not a standard WExpr attribute. Ensure your corpus or annotations extract it.`,
      });
    }

    switch (filter.op) {
      case 'eq':
        predicates.push(`[@${filter.attr}="${filter.value}"]`);
        break;
      case 'starts':
        predicates.push(`[@${filter.attr}^="${filter.value}"]`);
        break;
      case 'ends':
        predicates.push(`[@${filter.attr}$="${filter.value}"]`);
        break;
      case 'contains':
        predicates.push(`[contains(@${filter.attr}, "${filter.value}")]`);
        break;
      case 'regex':
        predicates.push(`[@${filter.attr}~="${filter.value}"]`);
        break;
      case 'exists':
        predicates.push(`[@${filter.attr}]`);
        break;
    }
  }

  // Check unused params
  for (const param of declaredParams) {
    if (!usedParams.has(param)) {
      diagnostics.push({
        severity: 'warning',
        field: `params[${param}]`,
        message: `Declared parameter "$${param}" is never used in query template`,
      });
    }
  }

  // 4. Build Full WQL Step Chain
  let wql: string;
  const targetStep = `${targetTag}${predicates.join('')}`;

  if (spec.scope?.within) {
    const scopePred = spec.scope.withinName ? `[@name="${spec.scope.withinName}"]` : '';
    const sep = spec.scope.directChild ? '>' : '//';
    wql = `//${spec.scope.within}${scopePred}${sep}${targetStep}`;
  } else {
    wql = `//${targetStep}`;
  }

  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new PatternCompileError(
      `Pattern "${spec.name}" failed compilation with ${errors.length} error(s): ${errors.map((e) => e.message).join('; ')}`,
      diagnostics,
    );
  }

  // Verify that the template parses as valid WQL
  // Replace $param with dummy "dummy" for syntax check
  const dummyWql = wql.replace(/\$([a-zA-Z0-9_-]+)/g, 'param_$1');
  const parsedTemplate = parseWql(dummyWql);

  return {
    spec,
    templateWql: wql,
    parsedTemplate,
    diagnostics,
    bind(args: Record<string, string> = {}) {
      let resolved = wql;
      for (const param of spec.params ?? []) {
        const val = args[param.name] ?? param.default;
        if (val === undefined && param.required) {
          throw new InvalidArgumentError(
            `${param.name}`,
            `a value for required parameter "${param.name}" in pattern "${spec.name}"`,
            undefined,
          );
        }
        resolved = resolved.replaceAll(`$${param.name}`, val ?? '');
      }
      return {
        wql: resolved,
        ...(spec.corpus !== undefined ? { corpus: spec.corpus } : {}),
        ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
      };
    },
    diagnoseResults(resultCount: number, repoLanguages?: readonly string[]) {
      if (resultCount > 0) return undefined;
      if (
        spec.target.kind === 'method' &&
        repoLanguages?.includes('python') &&
        !spec.scope?.within
      ) {
        return {
          severity: 'hint',
          message: 'Zero results found.',
          hint: 'Target is kind "method". In Python files without class scope, functions are mapped to "function". Consider kind "callable" or scoping within "class".',
        };
      }
      return undefined;
    },
  };
}
