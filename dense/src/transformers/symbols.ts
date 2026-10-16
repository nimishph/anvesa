import { ATTR, outlineSymbols, type WNode, walk } from '@cntxt-labs/anvesa-structural';
import { LanguageRegistry } from '@cntxt-labs/anvesa-syntax';
import { packCards } from '../budget.ts';
import { type CardDraft, defineTransformer, type Transformer } from '../card.ts';
import { decomposeIdentifier, decomposePath, normalizeDoc } from '../text.ts';

export interface SymbolsOptions {
  readonly name?: string;
  readonly channel?: string;
  /** Which files count as source code. Defaults to the built-in language registry. */
  readonly languages?: LanguageRegistry;
  /**
   * Experimental: add where the symbol sits in the W-expression (its enclosing nodes) to the card,
   * as words (`in export, function cart modal`) or as a WQL path.
   */
  readonly path?: 'words' | 'wql';
}

/** The nodes from the root (excluded) down to `target` (included), or `undefined` if not found. */
function pathTo(root: WNode, target: WNode): WNode[] | undefined {
  const parents = new Map<WNode, WNode | undefined>();
  for (const { node, parent } of walk(root)) {
    parents.set(node, parent);
    if (node === target) break;
  }
  if (!parents.has(target)) return undefined;
  const path: WNode[] = [];
  for (let at: WNode | undefined = target; at && at !== root; at = parents.get(at))
    path.unshift(at);
  return path;
}

/** `in export, function cart modal, variable close cart`: the enclosing nodes, read as words. */
function pathWords(path: readonly WNode[]): string {
  const steps = path.slice(0, -1).map((node) => {
    const name = node.attrs.get(ATTR.baseName) ?? node.attrs.get(ATTR.name);
    return name ? `${node.tag} ${decomposeIdentifier(name).join(' ')}` : node.tag;
  });
  return steps.length > 0 ? `in ${steps.join(', ')}` : '';
}

/** `/export/function[@name="CartModal"]/variable[@name="CartModal.closeCart"]`, the node itself last. */
function pathWql(path: readonly WNode[]): string {
  return path
    .map((node) => {
      const name = node.attrs.get(ATTR.name);
      return name ? `/${node.tag}[@name=${JSON.stringify(name)}]` : `/${node.tag}`;
    })
    .join('');
}

/**
 * Cards for code symbols. Each card says what a symbol is (kind, name, its words, where it lives),
 * what its documentation says, and its signature, and never its body: a body is mostly control
 * flow and local names, which say little about what the symbol is for. Documentation is the one
 * place intent is written down, so a repo with none gets weaker results from any dense channel.
 *
 * A symbol whose card does not fit the encoder's window is spread over several cards, each opening
 * with the same identity line so a continuation is still found by name.
 */
export function symbolsTransformer(options: SymbolsOptions = {}): Transformer {
  const languages = options.languages ?? new LanguageRegistry();
  return defineTransformer({
    name: options.name ?? 'symbols',
    // bump when the cards this makes would change, so they are rebuilt
    version: options.path ? `2+path-${options.path}` : '2',
    channel: options.channel ?? 'symbols',
    categoryId: 'code.symbol',
    categoryLabel: 'Code symbol',
    trust: 'first-party',
    claim: (file) => languages.forPath(file.path) !== undefined,
    async transform(file, context) {
      const encoded = await context.services.encode(file, { docs: true });
      const modulePath = decomposePath(file.path);
      const used = new Map<string, number>();
      const drafts: CardDraft[] = [];

      for (const symbol of outlineSymbols(encoded.root)) {
        context.deadline.throwIfExpired(`build cards for ${file.path}`);
        const head = [
          `${symbol.kind} ${symbol.name}`,
          decomposeIdentifier(symbol.baseName).join(' '),
          symbol.parentName ? `in ${decomposeIdentifier(symbol.parentName).join(' ')}` : '',
          modulePath.length > 0 ? `module ${modulePath.join(' ')}` : '',
        ]
          .filter((part) => part.length > 0)
          .join(' — ');

        const doc = symbol.doc ? normalizeDoc(symbol.doc) : '';
        const path = options.path ? pathTo(encoded.root, symbol.node) : undefined;
        const where = path ? (options.path === 'wql' ? pathWql(path) : pathWords(path)) : '';
        const blocks = [
          ...(where ? [{ text: where }] : []),
          ...(doc ? [{ text: doc }] : []),
          ...(symbol.signature ? [{ text: symbol.signature }] : []),
        ];
        const packed = packCards(head, blocks, context.budget);

        const seen = used.get(symbol.name) ?? 0;
        used.set(symbol.name, seen + 1);
        const key = seen === 0 ? symbol.name : `${symbol.name}#${seen + 1}`;
        const start = Number.parseInt(symbol.node.attrs.get(ATTR.line) ?? '', 10);
        const end = Number.parseInt(symbol.node.attrs.get(ATTR.endLine) ?? '', 10);
        const attrs: Record<string, string> = {
          kind: symbol.kind,
          symbol: symbol.name,
          hasDoc: String(doc.length > 0),
          ...(symbol.signature ? { signature: symbol.signature } : {}),
        };

        packed.texts.forEach((text, index) => {
          drafts.push({
            key,
            text,
            attrs,
            group: key,
            ...(Number.isFinite(start)
              ? { span: { startLine: start, endLine: Number.isFinite(end) ? end : start } }
              : {}),
            ...(packed.texts.length > 1
              ? { part: { index: index + 1, of: packed.texts.length } }
              : {}),
          });
        });
      }
      return drafts;
    },
  });
}
