import { ATTR, lineRange, type WNode, walk } from './node.ts';

export type ChangeKind = 'signature' | 'body' | 'kind' | 'moved';

export interface SymbolRef {
  readonly tag: string;
  readonly name: string;
  readonly line: number | undefined;
  readonly signature: string | undefined;
}

export interface SymbolChange {
  readonly tag: string;
  readonly name: string;
  readonly oldLine: number | undefined;
  readonly newLine: number | undefined;
  readonly oldSignature: string | undefined;
  readonly newSignature: string | undefined;
  /** What differs. `moved` alone means the symbol only changed position. */
  readonly changes: readonly ChangeKind[];
}

export interface StructuralDiff {
  readonly added: readonly SymbolRef[];
  readonly removed: readonly SymbolRef[];
  readonly modified: readonly SymbolChange[];
  /** Symbols present in both and identical apart from position. */
  readonly unchanged: number;
  readonly summary: string;
}

interface Entry {
  readonly node: WNode;
  readonly ref: SymbolRef;
}

/**
 * What changed between two versions of a file, by symbol rather than by line.
 *
 * Symbols are paired by tag and qualified name. Several symbols sharing a key (overloads, a
 * function declared twice) are paired in order of appearance, so none is silently merged into
 * another. A pair is `modified` when its signature, its body shape or its syntax kind differs; a
 * pair that only moved is counted as unchanged.
 */
export function diffStructure(before: WNode, after: WNode): StructuralDiff {
  const oldEntries = group(before);
  const newEntries = group(after);

  const added: SymbolRef[] = [];
  const removed: SymbolRef[] = [];
  const modified: SymbolChange[] = [];
  let unchanged = 0;

  for (const [key, news] of newEntries) {
    const olds = oldEntries.get(key) ?? [];
    news.forEach((entry, index) => {
      const old = olds[index];
      if (!old) {
        added.push(entry.ref);
        return;
      }
      const changes = compare(old, entry);
      if (changes.some((change) => change !== 'moved')) {
        modified.push({
          tag: entry.ref.tag,
          name: entry.ref.name,
          oldLine: old.ref.line,
          newLine: entry.ref.line,
          oldSignature: old.ref.signature,
          newSignature: entry.ref.signature,
          changes,
        });
      } else {
        unchanged += 1;
      }
    });
  }
  for (const [key, olds] of oldEntries) {
    const news = newEntries.get(key) ?? [];
    for (const old of olds.slice(news.length)) removed.push(old.ref);
  }

  return { added, removed, modified, unchanged, summary: summarize(added, removed, modified) };
}

function group(root: WNode): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const { node } of walk(root)) {
    const name = node.attrs.get(ATTR.name);
    if (name === undefined) continue;
    const key = `${node.tag}\u0000${name}`;
    const entries = groups.get(key) ?? [];
    entries.push({
      node,
      ref: {
        tag: node.tag,
        name,
        line: lineRange(node)?.startLine,
        signature: node.attrs.get(ATTR.signature),
      },
    });
    groups.set(key, entries);
  }
  return groups;
}

function compare(old: Entry, current: Entry): readonly ChangeKind[] {
  const changes: ChangeKind[] = [];
  const a = old.node.attrs;
  const b = current.node.attrs;
  if (a.get(ATTR.kind) !== b.get(ATTR.kind)) changes.push('kind');
  if (a.get(ATTR.params) !== b.get(ATTR.params) || a.get(ATTR.returns) !== b.get(ATTR.returns)) {
    changes.push('signature');
  }
  if (
    (a.get(ATTR.bodyShape) ?? a.get(ATTR.shape)) !== (b.get(ATTR.bodyShape) ?? b.get(ATTR.shape))
  ) {
    changes.push('body');
  }
  if (old.ref.line !== current.ref.line) changes.push('moved');
  return changes;
}

function summarize(
  added: readonly SymbolRef[],
  removed: readonly SymbolRef[],
  modified: readonly SymbolChange[],
): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`+${added.length} added`);
  if (removed.length > 0) parts.push(`-${removed.length} removed`);
  if (modified.length > 0) parts.push(`~${modified.length} modified`);
  return parts.length > 0 ? parts.join(', ') : 'no structural changes';
}
