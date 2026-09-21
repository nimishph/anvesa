import { npmPackageSource, SyntaxRuntime } from '@sutras/code-lens-syntax';
import { type EncodedFile, StructuralEngine } from './engine.ts';
import type { WNode } from './node.ts';

/** Test-only helpers. Not exported from the package. */

const runtimes: SyntaxRuntime[] = [];

/** An engine backed by the grammars installed as dev dependencies of this package. */
export function makeEngine(): StructuralEngine {
  const runtime = new SyntaxRuntime({ sources: [npmPackageSource(import.meta.filename)] });
  runtimes.push(runtime);
  return new StructuralEngine({ runtime });
}

export async function disposeEngines(): Promise<void> {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
}

export function encodeTs(
  engine: StructuralEngine,
  source: string,
  path = 'a.ts',
): Promise<EncodedFile> {
  return engine.encode(source, { path });
}

/** Structural equality of two trees, iterative so depth is not a limit. */
export function treesEqual(a: WNode, b: WNode): boolean {
  const pending: [WNode, WNode][] = [[a, b]];
  while (pending.length > 0) {
    const [left, right] = pending.pop() as [WNode, WNode];
    if (left.tag !== right.tag) return false;
    if (left.attrs.size !== right.attrs.size) return false;
    for (const [key, value] of left.attrs) if (right.attrs.get(key) !== value) return false;
    if (left.children.length !== right.children.length) return false;
    left.children.forEach((child, index) => {
      pending.push([child, right.children[index] as WNode]);
    });
  }
  return true;
}

/** Every node with a tag, in document order. */
export function nodesTagged(root: WNode, tag: string): WNode[] {
  const found: WNode[] = [];
  const pending: WNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as WNode;
    if (node.tag === tag) found.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index] as WNode);
    }
  }
  return found;
}
