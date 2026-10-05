import type { TypeBinding, TypeRules } from '@cntxt-labs/anvesa-structural';
import type { SyntaxNode } from '@cntxt-labs/anvesa-syntax';
import type { TypeFact } from './facts.ts';

/**
 * Collects the types a file declares for names, as a language mapping's `typeRules` describe them:
 * parameters, properties, promoted constructor parameters, return types, and a name assigned a
 * newly created object. Together they say which class a call's receiver is, where the source says
 * so. Only what is written is recorded; nothing is inferred here.
 *
 * Positions asked of `enclosing` are always the start of the node being visited, so the walk order
 * that `NestingCursor` needs is kept.
 */
export class TypeCollector {
  readonly types: TypeFact[] = [];
  readonly #byNode: ReadonlyMap<string, readonly TypeBinding[]>;
  readonly #nonClasses: ReadonlySet<string>;
  readonly #classTypes: ReadonlySet<string>;
  readonly #enclosing: (position: number) => string | undefined;

  constructor(rules: TypeRules, enclosing: (position: number) => string | undefined) {
    const byNode = new Map<string, TypeBinding[]>();
    for (const binding of rules.bindings) {
      const list = byNode.get(binding.node) ?? [];
      list.push(binding);
      byNode.set(binding.node, list);
    }
    this.#byNode = byNode;
    this.#nonClasses = new Set(rules.nonClasses.map((name) => name.toLowerCase()));
    this.#classTypes = new Set(rules.classTypes);
    this.#enclosing = enclosing;
  }

  visit(node: SyntaxNode): void {
    for (const binding of this.#byNode.get(node.type) ?? []) {
      if (binding.origin === 'assigned') this.#assigned(node, binding);
      else this.#declared(node, binding);
    }
  }

  #declared(node: SyntaxNode, binding: TypeBinding): void {
    const type = this.#classOf(field(node, binding.typeField));
    const scope = this.#enclosing(node.startIndex);
    if (type === undefined || scope === undefined) return;
    if (binding.origin === 'return') {
      this.types.push({ scope, name: '', type, origin: 'return' });
      return;
    }
    const holders =
      binding.each === undefined
        ? [node]
        : node.namedChildren.filter((child) => child.type === binding.each);
    for (const holder of holders) {
      const name = nameOf(field(holder, binding.nameField), binding.nameType);
      if (name !== undefined) this.types.push({ scope, name, type, origin: binding.origin });
    }
  }

  /** `$x = new Foo(...)` types `$x` inside the enclosing callable. */
  #assigned(node: SyntaxNode, binding: TypeBinding): void {
    const value = field(node, binding.valueField);
    if (!value || value.type !== binding.valueType) return;
    const name = nameOf(field(node, binding.nameField), binding.nameType);
    if (name === undefined) return;
    const created = value.namedChildren.find((child) =>
      (binding.createdTypes ?? []).includes(child.type),
    );
    const scope = this.#enclosing(node.startIndex);
    if (created === undefined || scope === undefined) return;
    if (this.#nonClasses.has(created.text.toLowerCase())) return;
    this.types.push({ scope, name, type: created.text, origin: 'assigned' });
  }

  /**
   * The one class a type names, as written. `?Foo` and `Foo|null` are `Foo`; `Foo|Bar` and scalars
   * are `undefined`, because a call on them has no single class to follow.
   */
  #classOf(node: SyntaxNode | null): string | undefined {
    if (!node) return undefined;
    const found = new Set<string>();
    const pending: SyntaxNode[] = [node];
    while (pending.length > 0) {
      const current = pending.pop() as SyntaxNode;
      if (this.#classTypes.has(current.type)) {
        const text = current.text.trim();
        if (!this.#nonClasses.has(text.toLowerCase())) found.add(text);
        continue;
      }
      pending.push(...current.namedChildren);
    }
    return found.size === 1 ? [...found][0] : undefined;
  }
}

function field(node: SyntaxNode, name: string | undefined): SyntaxNode | null {
  return name === undefined ? null : node.childForFieldName(name);
}

/** The bound name, when its node is of the expected type (or any type, when none is expected). */
function nameOf(node: SyntaxNode | null, type: string | undefined): string | undefined {
  if (!node || (type !== undefined && node.type !== type)) return undefined;
  return node.text;
}
