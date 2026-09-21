import { QuerySpecError } from './errors.ts';

/**
 * Build WQL queries from parts without string concatenation.
 *
 * Values are escaped, so any string, including quotes, backslashes and brackets, is safe by
 * construction and reads back exactly. Only tag and attribute *names* are restricted, because they
 * are identifiers in the language.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function assertName(kind: 'tag' | 'attribute', name: string): void {
  if (!IDENT.test(name)) throw new QuerySpecError(kind, name);
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export class WqlConstraint {
  constructor(readonly source: string) {}

  toString(): string {
    return this.source;
  }
}

export const Wql = {
  eq(attr: string, value: string): WqlConstraint {
    assertName('attribute', attr);
    return new WqlConstraint(`[@${attr}=${quote(value)}]`);
  },
  contains(attr: string, value: string): WqlConstraint {
    assertName('attribute', attr);
    return new WqlConstraint(`[contains(@${attr},${quote(value)})]`);
  },
  starts(attr: string, value: string): WqlConstraint {
    assertName('attribute', attr);
    return new WqlConstraint(`[@${attr}^=${quote(value)}]`);
  },
  ends(attr: string, value: string): WqlConstraint {
    assertName('attribute', attr);
    return new WqlConstraint(`[@${attr}$=${quote(value)}]`);
  },
  /** The pattern is a regular expression source; it is validated when the query is parsed. */
  regex(attr: string, pattern: string): WqlConstraint {
    assertName('attribute', attr);
    return new WqlConstraint(`[@${attr}~=${quote(pattern)}]`);
  },
  exists(attr: string): WqlConstraint {
    assertName('attribute', attr);
    return new WqlConstraint(`[@${attr}]`);
  },
} as const;

/** An immutable query under construction. */
export class WqlSpec {
  private constructor(private readonly source: string) {}

  static tag(name: string): WqlSpec {
    assertName('tag', name);
    return new WqlSpec(`//${name}`);
  }

  static any(): WqlSpec {
    return new WqlSpec('//*');
  }

  /** The next tag anywhere inside the previous match. */
  descendant(name: string): WqlSpec {
    assertName('tag', name);
    return new WqlSpec(`${this.source}//${name}`);
  }

  /** The next tag directly inside the previous match. */
  child(name: string): WqlSpec {
    assertName('tag', name);
    return new WqlSpec(`${this.source}>${name}`);
  }

  where(constraint: WqlConstraint): WqlSpec {
    return new WqlSpec(`${this.source}${constraint.source}`);
  }

  toString(): string {
    return this.source;
  }
}
