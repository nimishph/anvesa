import { ATTR, lineRange, type WNode } from './node.ts';

/** A match presented for callers: where it is and what it is, plus the node for anything else. */
export interface WqlHit {
  readonly path: string | undefined;
  readonly tag: string;
  readonly name: string | undefined;
  /** 1-based, inclusive. */
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
  readonly params: string | undefined;
  readonly returns: string | undefined;
  readonly signature: string | undefined;
  readonly hash: string | undefined;
  readonly shape: string | undefined;
  readonly node: WNode;
}

export function toHit(path: string | undefined, node: WNode): WqlHit {
  const lines = lineRange(node);
  return {
    path,
    tag: node.tag,
    name: node.attrs.get(ATTR.name),
    startLine: lines?.startLine,
    endLine: lines?.endLine,
    params: node.attrs.get(ATTR.params),
    returns: node.attrs.get(ATTR.returns),
    signature: node.attrs.get(ATTR.signature),
    hash: node.attrs.get(ATTR.hash),
    shape: node.attrs.get(ATTR.shape),
    node,
  };
}
