import { CodeLensError, type ErrorInit } from '@sutras/code-lens-core';

/** Every failure in this package. Codes are `STRUCTURAL_<REASON>`. */
export abstract class StructuralSubsystemError extends CodeLensError {
  readonly subsystem = 'structural' as const;
}

/** Point at `offset` inside `source` so a message can show where parsing stopped. */
export function excerptAt(source: string, offset: number): string {
  const lineStart = offset === 0 ? 0 : source.lastIndexOf('\n', offset - 1) + 1;
  const found = source.indexOf('\n', offset);
  const lineEnd = found === -1 ? source.length : found;
  const line = source.slice(lineStart, lineEnd);
  return `${line}\n${' '.repeat(offset - lineStart)}^`;
}

/** A WQL query that does not parse. `offset` is a character index into `query`. */
export class WqlSyntaxError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_WQL_SYNTAX';
  readonly offset: number;

  constructor(query: string, offset: number, expected: string, init: ErrorInit = {}) {
    const found = offset < query.length ? JSON.stringify(query[offset]) : 'end of query';
    super(
      `Invalid WQL at offset ${offset}: expected ${expected}, found ${found}\n${excerptAt(query, offset)}`,
      {
        hint: 'Example: //class//method[@name^="get"]',
        ...init,
        context: { query, offset, expected, ...init.context },
      },
    );
    this.offset = offset;
  }
}

/** A `~=` predicate whose pattern is not a valid regular expression. */
export class WqlRegexError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_WQL_REGEX';

  constructor(query: string, offset: number, pattern: string, init: ErrorInit = {}) {
    super(`Invalid regular expression in WQL at offset ${offset}: ${JSON.stringify(pattern)}`, {
      ...init,
      context: { query, offset, pattern, ...init.context },
    });
  }
}

/** A W-expression text that does not parse. */
export class WExprSyntaxError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_WEXPR_SYNTAX';
  readonly offset: number;

  constructor(source: string, offset: number, expected: string, init: ErrorInit = {}) {
    const found = offset < source.length ? JSON.stringify(source[offset]) : 'end of input';
    super(
      `Invalid W-expression at offset ${offset}: expected ${expected}, found ${found}\n${excerptAt(source, offset)}`,
      { ...init, context: { offset, expected, ...init.context } },
    );
    this.offset = offset;
  }
}

/** A language mapping that fails validation. `location` is a dotted path into the mapping. */
export class MappingInvalidError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_MAPPING_INVALID';

  constructor(mapping: string, location: string, problem: string, init: ErrorInit = {}) {
    super(`Language mapping "${mapping}" is invalid at ${location}: ${problem}`, {
      ...init,
      context: { mapping, location, problem, ...init.context },
    });
  }
}

/** No mapping is registered for a language, so its trees cannot be encoded. */
export class MappingNotFoundError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_MAPPING_MISSING';

  constructor(language: string, known: readonly string[], init: ErrorInit = {}) {
    super(`No W-expression mapping is registered for language "${language}"`, {
      hint: 'Register a mapping for this language, or use a language that has one.',
      ...init,
      context: { language, known, ...init.context },
    });
  }
}

/** Two mappings claim the same name or language key. */
export class MappingConflictError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_MAPPING_CONFLICT';

  constructor(claim: string, existing: string, incoming: string, init: ErrorInit = {}) {
    super(`Cannot register mapping "${incoming}": ${claim} already belongs to "${existing}"`, {
      ...init,
      context: { claim, existing, incoming, ...init.context },
    });
  }
}

/** A query builder was given a tag or attribute name that is not a valid identifier. */
export class QuerySpecError extends StructuralSubsystemError {
  readonly code = 'STRUCTURAL_QUERY_SPEC';

  constructor(kind: 'tag' | 'attribute', name: string, init: ErrorInit = {}) {
    super(`Invalid WQL ${kind} name ${JSON.stringify(name)}`, {
      hint: 'Names start with a letter or underscore and contain letters, digits, "_" or "-".',
      ...init,
      context: { kind, name, ...init.context },
    });
  }
}
