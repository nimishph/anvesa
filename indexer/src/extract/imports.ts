import type { SyntaxNode } from '@cntxt-labs/anvesa-syntax';
import type { ExportFact, ExtractionGaps, ImportBinding, ImportFact, ImportKind } from './facts.ts';

/** Reads the imports of one file as its syntax tree is walked. One collector per language family. */
export interface ImportCollector {
  readonly imports: ImportFact[];
  readonly exports: ExportFact[];
  readonly gaps: Pick<ExtractionGaps, 'computedImports'>;
  visit(node: SyntaxNode): void;
}

const ECMASCRIPT: ReadonlySet<string> = new Set(['javascript', 'typescript', 'tsx']);

/**
 * The collector for a language, or `undefined` when its imports are not understood. Callers must
 * report that (`FileFacts.importsSupported`): an empty import list from such a file is a gap, not
 * evidence that the file stands alone.
 */
export function importCollectorFor(language: string): ImportCollector | undefined {
  if (ECMASCRIPT.has(language)) return new EcmaScriptImports();
  if (language === 'python') return new PythonImports();
  return undefined;
}

// --- shared -------------------------------------------------------------------------------------

/** The value of a string literal with nothing computed in it, else `undefined`. */
function literalString(node: SyntaxNode | null | undefined): string | undefined {
  if (!node || (node.type !== 'string' && node.type !== 'template_string')) return undefined;
  if (node.namedChildren.some((child) => child.type === 'template_substitution')) return undefined;
  return node.namedChildren
    .filter((child) => child.type === 'string_fragment' || child.type === 'escape_sequence')
    .map((child) => child.text)
    .join('');
}

function hasToken(node: SyntaxNode, token: string): boolean {
  return node.children.some((child) => !child.isNamed && child.type === token);
}

function lineOf(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.');
}

abstract class BaseCollector implements ImportCollector {
  readonly imports: ImportFact[] = [];
  readonly exports: ExportFact[] = [];
  protected computed = 0;

  get gaps(): Pick<ExtractionGaps, 'computedImports'> {
    return { computedImports: this.computed };
  }

  abstract visit(node: SyntaxNode): void;

  protected add(
    node: SyntaxNode,
    specifier: string,
    kind: ImportKind,
    bindings: readonly ImportBinding[],
    typeOnly: boolean,
  ): void {
    this.imports.push({
      specifier,
      kind,
      relative: isRelative(specifier),
      typeOnly,
      bindings,
      line: lineOf(node),
    });
  }
}

// --- JavaScript / TypeScript --------------------------------------------------------------------

class EcmaScriptImports extends BaseCollector {
  visit(node: SyntaxNode): void {
    switch (node.type) {
      case 'import_statement':
        this.importStatement(node);
        return;
      case 'export_statement':
        this.exportFrom(node);
        return;
      case 'call_expression':
        this.loadCall(node);
        return;
      default:
    }
  }

  private importStatement(node: SyntaxNode): void {
    const typeOnly = hasToken(node, 'type');
    const requireClause = node.namedChildren.find(
      (child) => child.type === 'import_require_clause',
    );
    if (requireClause) {
      const specifier = literalString(requireClause.childForFieldName('source'));
      const local = requireClause.namedChildren.find((child) => child.type === 'identifier');
      if (specifier === undefined || !local) {
        this.computed += 1;
        return;
      }
      this.add(
        node,
        specifier,
        'require',
        [{ imported: '*', local: local.text, typeOnly }],
        typeOnly,
      );
      return;
    }

    const specifier = literalString(node.childForFieldName('source'));
    if (specifier === undefined) return;
    const clause = node.namedChildren.find((child) => child.type === 'import_clause');
    if (!clause) {
      this.add(node, specifier, 'side-effect', [], false);
      return;
    }
    this.add(node, specifier, 'static', importClauseBindings(clause, typeOnly), typeOnly);
  }

  private exportFrom(node: SyntaxNode): void {
    if (node.childForFieldName('source') === null) {
      this.exportLocal(node);
      return;
    }
    const specifier = literalString(node.childForFieldName('source'));
    if (specifier === undefined) return;
    const typeOnly = hasToken(node, 'type');
    const bindings: ImportBinding[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'namespace_export') {
        const alias = child.namedChildren.find((part) => part.type === 'identifier');
        bindings.push({ imported: '*', local: alias?.text ?? '*', typeOnly });
      } else if (child.type === 'export_clause') {
        for (const part of child.namedChildren) {
          if (part.type !== 'export_specifier') continue;
          const name = part.childForFieldName('name')?.text;
          if (name === undefined) continue;
          const alias = part.childForFieldName('alias')?.text;
          bindings.push({
            imported: name,
            local: alias ?? name,
            typeOnly: typeOnly || hasToken(part, 'type'),
          });
        }
      }
    }
    // `export * from 'x'` has no clause at all, only the star token.
    if (bindings.length === 0 && hasToken(node, '*')) {
      bindings.push({ imported: '*', local: '*', typeOnly });
    }
    this.add(node, specifier, 'reexport', bindings, typeOnly);
  }

  /** `export { a, b as c }` and `export default a`, with no module named. */
  private exportLocal(node: SyntaxNode): void {
    const line = lineOf(node);
    for (const child of node.namedChildren) {
      if (child.type !== 'export_clause') continue;
      for (const part of child.namedChildren) {
        if (part.type !== 'export_specifier') continue;
        const local = part.childForFieldName('name')?.text;
        if (local === undefined) continue;
        const alias = part.childForFieldName('alias')?.text;
        this.exports.push({ name: alias ?? local, local, line });
      }
    }
    const value = node.childForFieldName('value');
    if (value?.type === 'identifier' && hasToken(node, 'default')) {
      this.exports.push({ name: 'default', local: value.text, line });
    }
  }

  /** `require('x')` and `import('x')`. */
  private loadCall(node: SyntaxNode): void {
    const callee = node.childForFieldName('function');
    if (!callee) return;
    const kind: ImportKind | undefined =
      callee.type === 'import' ? 'dynamic' : callee.text === 'require' ? 'require' : undefined;
    if (kind === undefined) return;

    const argument = node.childForFieldName('arguments')?.namedChildren[0];
    const specifier = literalString(argument);
    if (specifier === undefined) {
      this.computed += 1;
      return;
    }
    this.add(node, specifier, kind, loadedBindings(node), false);
  }
}

function importClauseBindings(clause: SyntaxNode, statementTypeOnly: boolean): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      bindings.push({ imported: 'default', local: child.text, typeOnly: statementTypeOnly });
    } else if (child.type === 'namespace_import') {
      const local = child.namedChildren.find((part) => part.type === 'identifier');
      if (local) bindings.push({ imported: '*', local: local.text, typeOnly: statementTypeOnly });
    } else if (child.type === 'named_imports') {
      for (const specifier of child.namedChildren) {
        if (specifier.type !== 'import_specifier') continue;
        const name = specifier.childForFieldName('name')?.text;
        if (name === undefined) continue;
        const alias = specifier.childForFieldName('alias')?.text;
        bindings.push({
          imported: name,
          local: alias ?? name,
          typeOnly: statementTypeOnly || hasToken(specifier, 'type'),
        });
      }
    }
  }
  return bindings;
}

/**
 * What `const ... = require('x')` or `= await import('x')` binds: the whole module to one name,
 * or destructured names. A bare `require('x')` call binds nothing.
 */
function loadedBindings(call: SyntaxNode): ImportBinding[] {
  let holder: SyntaxNode | null = call.parent;
  while (
    holder &&
    (holder.type === 'await_expression' || holder.type === 'parenthesized_expression')
  ) {
    holder = holder.parent;
  }
  if (holder?.type !== 'variable_declarator') return [];
  const target = holder.childForFieldName('name');
  if (!target) return [];
  if (target.type === 'identifier') return [{ imported: '*', local: target.text, typeOnly: false }];
  if (target.type !== 'object_pattern') return [];

  const bindings: ImportBinding[] = [];
  for (const part of target.namedChildren) {
    if (part.type === 'shorthand_property_identifier_pattern') {
      bindings.push({ imported: part.text, local: part.text, typeOnly: false });
    } else if (part.type === 'pair_pattern') {
      const key = part.childForFieldName('key')?.text;
      const value = part.childForFieldName('value');
      if (key !== undefined && value?.type === 'identifier') {
        bindings.push({ imported: key, local: value.text, typeOnly: false });
      }
    }
  }
  return bindings;
}

// --- Python -------------------------------------------------------------------------------------

class PythonImports extends BaseCollector {
  visit(node: SyntaxNode): void {
    if (node.type === 'import_statement') this.importStatement(node);
    else if (node.type === 'import_from_statement') this.fromStatement(node);
  }

  /** `import a.b` and `import a.b as c`: one module per name. */
  private importStatement(node: SyntaxNode): void {
    for (const child of node.childrenForFieldName('name')) {
      if (child.type === 'aliased_import') {
        const module = child.childForFieldName('name')?.text;
        const alias = child.childForFieldName('alias')?.text;
        if (module === undefined) continue;
        this.add(
          node,
          module,
          'static',
          [{ imported: '*', local: alias ?? module, typeOnly: false }],
          false,
        );
      } else if (child.type === 'dotted_name') {
        // `import a.b` binds `a`, and makes `a.b` reachable through it.
        const local = child.text.split('.')[0] ?? child.text;
        this.add(node, child.text, 'static', [{ imported: '*', local, typeOnly: false }], false);
      }
    }
  }

  /** `from m import x as y, z` and `from . import x`. */
  private fromStatement(node: SyntaxNode): void {
    const module = node.childForFieldName('module_name')?.text;
    if (module === undefined) return;
    const bindings: ImportBinding[] = [];
    for (const child of node.childrenForFieldName('name')) {
      if (child.type === 'aliased_import') {
        const name = child.childForFieldName('name')?.text;
        const alias = child.childForFieldName('alias')?.text;
        if (name !== undefined)
          bindings.push({ imported: name, local: alias ?? name, typeOnly: false });
      } else if (child.type === 'dotted_name') {
        bindings.push({ imported: child.text, local: child.text, typeOnly: false });
      }
    }
    if (node.namedChildren.some((child) => child.type === 'wildcard_import')) {
      bindings.push({ imported: '*', local: '*', typeOnly: false });
    }
    this.add(node, module, 'static', bindings, false);
  }
}
