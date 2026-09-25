import type { Card } from '@cntxt-labs/anvesa-dense';
import { looksLikeWql, type WqlHit } from '@cntxt-labs/anvesa-structural';

export interface ConjunctionQuery {
  readonly semantic?: string | undefined;
  readonly wql?: string | undefined;
}

/**
 * Splits a query into its semantic and structural (WQL) parts.
 *
 * Supported forms:
 *   - Explicit options: `splitConjunction('save user', '//function', undefined)`
 *   - Inline '&&': `'save user && //function'` or `'//function && save user'`
 *   - Inline 'where': `'save user where //class//method'`
 *   - Inline 'AND': `'save user AND //function'`
 *   - Pure WQL or pure semantic: `'//function'` or `'save user'`
 */
export function splitConjunction(
  text: string,
  explicitWql?: string,
  explicitSemantic?: string,
): ConjunctionQuery {
  if (explicitWql || explicitSemantic) {
    return {
      semantic: explicitSemantic ?? (looksLikeWql(text) ? undefined : text.trim() || undefined),
      wql: explicitWql ?? (looksLikeWql(text) ? text.trim() || undefined : undefined),
    };
  }

  const trimmed = text.trim();

  // 1. "semantic && //wql" or "//wql && semantic"
  if (trimmed.includes('&&')) {
    const parts = trimmed.split('&&');
    if (parts.length === 2) {
      const p0 = parts[0]?.trim() ?? '';
      const p1 = parts[1]?.trim() ?? '';
      if (looksLikeWql(p0) && !looksLikeWql(p1)) {
        return { wql: p0, semantic: p1 };
      }
      if (looksLikeWql(p1) && !looksLikeWql(p0)) {
        return { semantic: p0, wql: p1 };
      }
    }
  }

  // 2. "semantic where //wql"
  const whereMatch = trimmed.match(/^(.*?)\s+where\s+(\/\/.*)$/i);
  if (whereMatch?.[1] && whereMatch[2]) {
    const left = whereMatch[1].trim();
    const right = whereMatch[2].trim();
    if (!looksLikeWql(left) && looksLikeWql(right)) {
      return { semantic: left, wql: right };
    }
  }

  // 3. "semantic AND //wql" or "//wql AND semantic"
  const andMatch = trimmed.match(/^(.*?)\s+AND\s+(.*)$/);
  if (andMatch?.[1] && andMatch[2]) {
    const left = andMatch[1].trim();
    const right = andMatch[2].trim();
    if (looksLikeWql(left) && !looksLikeWql(right)) {
      return { wql: left, semantic: right };
    }
    if (looksLikeWql(right) && !looksLikeWql(left)) {
      return { semantic: left, wql: right };
    }
  }

  if (looksLikeWql(trimmed)) {
    return { wql: trimmed };
  }
  return { semantic: trimmed };
}

/**
 * Builds a fast matcher function over a set of WQL hits.
 * A card matches if it shares the file path AND either its symbol name matches a WQL hit,
 * or its source line span overlaps or is contained within the WQL hit's line range.
 */
export function buildWqlMatcher(wqlHits: readonly WqlHit[]): (card: Card) => WqlHit | undefined {
  const byPath = new Map<string, WqlHit[]>();
  for (const hit of wqlHits) {
    if (!hit.path) continue;
    const list = byPath.get(hit.path);
    if (list) list.push(hit);
    else byPath.set(hit.path, [hit]);
  }

  return (card: Card): WqlHit | undefined => {
    const pathHits = byPath.get(card.source.path);
    if (!pathHits || pathHits.length === 0) return undefined;

    const sym = card.attrs.symbol;
    if (sym) {
      const match = pathHits.find(
        (h) =>
          h.name && (h.name === sym || sym.endsWith(`.${h.name}`) || h.name.endsWith(`.${sym}`)),
      );
      if (match) return match;
    }

    const span = card.source.span;
    if (span) {
      const match = pathHits.find(
        (h) =>
          h.startLine !== undefined &&
          h.endLine !== undefined &&
          span.startLine >= h.startLine &&
          span.endLine <= h.endLine,
      );
      if (match) return match;
    }

    return undefined;
  };
}

/**
 * Finds a matching dense card for a given WqlHit.
 */
export function findMatchingCard<T extends { readonly card: Card; readonly score?: number }>(
  hit: WqlHit,
  items: readonly T[],
): T | undefined {
  if (!hit.path) return undefined;
  let best: T | undefined;
  for (const item of items) {
    const card = item.card;
    if (card.source.path !== hit.path) continue;

    let matched = false;
    if (
      hit.name &&
      card.attrs.symbol &&
      (card.attrs.symbol === hit.name ||
        card.attrs.symbol.endsWith(`.${hit.name}`) ||
        hit.name.endsWith(`.${card.attrs.symbol}`))
    ) {
      matched = true;
    } else if (hit.startLine !== undefined && hit.endLine !== undefined && card.source.span) {
      if (card.source.span.startLine >= hit.startLine && card.source.span.endLine <= hit.endLine) {
        matched = true;
      }
    }

    if (matched) {
      if (!best || (item.score ?? 0) > (best.score ?? 0)) {
        best = item;
      }
    }
  }
  return best;
}
