import type { SyntaxNode } from '@cntxt-labs/anvesa-syntax';
import type { TypeFact } from './facts.ts';

/** Types that name no class, so a call on them can never be followed. */
const NOT_CLASSES: ReadonlySet<string> = new Set([
  'null',
  'void',
  'never',
  'mixed',
  'iterable',
  'callable',
  'object',
  'array',
  'string',
  'int',
  'float',
  'bool',
  'boolean',
  'false',
  'true',
]);

/**
 * Collects the types a PHP file declares for names: parameters, properties, promoted constructor
 * parameters, return types, and `$x = new Foo()`. Together they say which class a call's receiver
 * is, where the source says so. Only what is written is recorded; nothing is inferred here.
 *
 * Positions asked of `enclosing` are always the start of the node being visited, so the walk order
 * that `NestingCursor` needs is kept.
 */
export class PhpTypeCollector {
  readonly types: TypeFact[] = [];
  readonly #enclosing: (position: number) => string | undefined;

  constructor(enclosing: (position: number) => string | undefined) {
    this.#enclosing = enclosing;
  }

  visit(node: SyntaxNode): void {
    switch (node.type) {
      case 'simple_parameter':
      case 'property_promotion_parameter':
        this.#parameter(node);
        break;
      case 'property_declaration':
        this.#property(node);
        break;
      case 'method_declaration':
      case 'function_definition':
        this.#returnType(node);
        break;
      case 'assignment_expression':
        this.#assignment(node);
        break;
      default:
    }
  }

  #parameter(node: SyntaxNode): void {
    const type = classOf(node.childForFieldName('type'));
    const name = variableOf(node.childForFieldName('name'));
    const scope = this.#enclosing(node.startIndex);
    if (type === undefined || name === undefined || scope === undefined) return;
    this.types.push({
      scope,
      name,
      type,
      origin: node.type === 'property_promotion_parameter' ? 'promoted' : 'param',
    });
  }

  #property(node: SyntaxNode): void {
    const type = classOf(node.childForFieldName('type'));
    const scope = this.#enclosing(node.startIndex);
    if (type === undefined || scope === undefined) return;
    for (const element of node.namedChildren) {
      if (element.type !== 'property_element') continue;
      const name = variableOf(element.childForFieldName('name'));
      if (name !== undefined) this.types.push({ scope, name, type, origin: 'property' });
    }
  }

  #returnType(node: SyntaxNode): void {
    const type = classOf(node.childForFieldName('return_type'));
    const scope = this.#enclosing(node.startIndex);
    if (type !== undefined && scope !== undefined) {
      this.types.push({ scope, name: '', type, origin: 'return' });
    }
  }

  /** `$x = new Foo(...)` types `$x` inside the enclosing callable. */
  #assignment(node: SyntaxNode): void {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (left?.type !== 'variable_name' || right?.type !== 'object_creation_expression') return;
    const created = right.namedChildren.find(
      (child) => child.type === 'name' || child.type === 'qualified_name',
    );
    const name = variableOf(left);
    const scope = this.#enclosing(node.startIndex);
    if (created === undefined || name === undefined || scope === undefined) return;
    if (NOT_CLASSES.has(created.text.toLowerCase())) return;
    this.types.push({ scope, name, type: created.text, origin: 'assigned' });
  }
}

/** `$name`, as a variable is written. */
function variableOf(node: SyntaxNode | null): string | undefined {
  return node?.type === 'variable_name' ? node.text : undefined;
}

/**
 * The one class a type names, as written. `?Foo` and `Foo|null` are `Foo`; `Foo|Bar` and scalars
 * are `undefined`, because a call on them has no single class to follow.
 */
function classOf(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  const found = new Set<string>();
  const pending: SyntaxNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop() as SyntaxNode;
    if (current.type === 'named_type') {
      const text = current.text.trim();
      if (!NOT_CLASSES.has(text.toLowerCase())) found.add(text);
      continue;
    }
    pending.push(...current.namedChildren);
  }
  return found.size === 1 ? [...found][0] : undefined;
}
