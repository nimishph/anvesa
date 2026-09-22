import { ATTR, outlineSymbols } from '@cntxt-labs/code-lens-structural';
import { LanguageRegistry } from '@cntxt-labs/code-lens-syntax';
import { packCards } from '../budget.ts';
import { type CardDraft, defineTransformer, type Transformer } from '../card.ts';
import { decomposeIdentifier, decomposePath, normalizeDoc } from '../text.ts';

export interface SymbolsOptions {
  readonly name?: string;
  readonly channel?: string;
  /** Which files count as source code. Defaults to the built-in language registry. */
  readonly languages?: LanguageRegistry;
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
    version: '1',
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
        const blocks = [
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
