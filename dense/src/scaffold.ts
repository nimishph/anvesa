import { DefinitionInvalidError } from './errors.ts';

export type ScaffoldTemplate = 'file' | 'ast' | 'external';

export interface ScaffoldFile {
  /** Relative to the channel's own directory. */
  readonly path: string;
  readonly content: string;
}

export interface Scaffold {
  readonly channel: string;
  readonly template: ScaffoldTemplate;
  readonly files: readonly ScaffoldFile[];
  /** What the author does next, in order. */
  readonly nextSteps: readonly string[];
}

const CHANNEL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The files for a new channel. Pure: it returns text and the caller writes it, so the same
 * function serves the CLI, tests and tools that want to show a preview.
 *
 * Three starting points, from simplest to most involved:
 * - `file`: turn each paragraph of matching files into a card.
 * - `ast`: turn each symbol of a code file into a card, using the structural outline.
 * - `external`: turn records from somewhere that is not a file (a database, an API, Sage's digests)
 *   into cards, by having an adapter hand the transformer a virtual file.
 */
export function scaffoldChannel(channel: string, template: ScaffoldTemplate = 'file'): Scaffold {
  if (!CHANNEL_NAME.test(channel)) {
    throw new DefinitionInvalidError('channel', 'name', 'must be lowercase words joined by "-"', {
      context: { channel },
    });
  }
  const body = BODIES[template](channel);
  return {
    channel,
    template,
    files: [
      { path: 'transformer.ts', content: body },
      { path: 'transformer.test.ts', content: testFile(channel) },
    ],
    nextSteps: [
      `Edit transformer.ts: decide which files it claims and what one card holds.`,
      `Try it on a file:  code-lens channel test ${channel} <file>`,
      `Index it:          code-lens channel index ${channel}`,
      `Search it:         code-lens retrieve ${channel} "<question>"`,
    ],
  };
}

const HEADER = (
  channel: string,
  summary: string,
) => `import { defineTransformer, packCards, type CardDraft } from '@sutras/code-lens-dense';

/**
 * Channel "${channel}": ${summary}
 *
 * A transformer turns one input file into cards. Everything else (red-team screening, embedding,
 * storage, search, the \`retrieve ${channel}\` command and MCP tool) is provided.
 *
 * Rules of thumb for good cards:
 * - Put what a person would search for in the text: names, topics, what the thing is for.
 * - Keep one idea per card. Use \`packCards\` so long items spill into more cards instead of being cut.
 * - Give every card a \`key\` that stays the same while its content does.
 */
`;

const FILE_TEMPLATE = (
  channel: string,
) => `${HEADER(channel, 'one card per paragraph of each matching file.')}
export default defineTransformer({
  name: '${channel}',
  version: '1', // bump when the cards this makes would change, so they are rebuilt
  channel: '${channel}',
  categoryId: 'custom.${channel}',
  categoryLabel: '${channel}',
  // first-party: you wrote it. third-party: someone else did. untrusted: anyone can edit it.
  // Stricter trust means a stricter red-team screen.
  trust: 'third-party',

  claim: (file) => file.path.endsWith('.txt'),

  transform(file, context): readonly CardDraft[] {
    const drafts: CardDraft[] = [];
    const paragraphs = file.content.split(/\\n\\s*\\n/).map((p) => p.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
      const packed = packCards(\`${channel} \${file.path}\`, [{ text: paragraph }], context.budget);
      packed.texts.forEach((text, part) => {
        drafts.push({
          key: \`paragraph-\${index + 1}\`,
          text,
          ...(packed.texts.length > 1 ? { part: { index: part + 1, of: packed.texts.length } } : {}),
        });
      });
    });
    return drafts;
  },
});
`;

const AST_TEMPLATE = (
  channel: string,
) => `${HEADER(channel, 'one card per function or class in each source file.')}
import { ATTR, walk } from '@sutras/code-lens-structural';

export default defineTransformer({
  name: '${channel}',
  version: '1',
  channel: '${channel}',
  categoryId: 'custom.${channel}',
  categoryLabel: '${channel}',
  trust: 'first-party',

  claim: (file) => /\\.(ts|tsx|js|jsx|py)$/.test(file.path),

  async transform(file, context): Promise<readonly CardDraft[]> {
    // The outline lists structural nodes with their names, signatures and (with docs: true) comments.
    const { root } = await context.services.encode(file, { docs: true });
    const drafts: CardDraft[] = [];
    for (const { node } of walk(root)) {
      const name = node.attrs.get(ATTR.name);
      if (!name || !['function', 'method', 'class'].includes(node.tag)) continue;
      const packed = packCards(
        \`\${node.tag} \${name} in \${file.path}\`,
        [
          ...(node.attrs.get(ATTR.doc) ? [{ text: node.attrs.get(ATTR.doc) as string }] : []),
          ...(node.attrs.get(ATTR.signature) ? [{ text: node.attrs.get(ATTR.signature) as string }] : []),
        ],
        context.budget,
      );
      packed.texts.forEach((text, part) => {
        drafts.push({
          key: name,
          text,
          ...(packed.texts.length > 1 ? { part: { index: part + 1, of: packed.texts.length } } : {}),
        });
      });
    }
    return drafts;
  },
});
`;

const EXTERNAL_TEMPLATE = (
  channel: string,
) => `${HEADER(channel, 'cards from records that are not files, supplied as virtual files.')}
/**
 * An adapter feeds this transformer virtual files: \`{ path, content, hash }\`. Here a virtual file
 * is one JSON record at a path like \`${channel}/<id>.json\`. The content of \`hash\` should change
 * whenever the record does, so unchanged records are not re-embedded.
 */
interface Record${capitalise(channel)} {
  readonly title: string;
  readonly body: string;
}

export default defineTransformer({
  name: '${channel}',
  version: '1',
  channel: '${channel}',
  categoryId: 'custom.${channel}',
  categoryLabel: '${channel}',
  // Records that anyone can write into should be untrusted: the red-team gate is strictest there.
  trust: 'untrusted',

  claim: (file) => file.path.startsWith('${channel}/') && file.path.endsWith('.json'),

  transform(file, context): readonly CardDraft[] {
    const record = JSON.parse(file.content) as Record${capitalise(channel)};
    const packed = packCards(\`${channel}: \${record.title}\`, [{ text: record.body }], context.budget);
    return packed.texts.map((text, part) => ({
      key: file.path,
      text,
      ...(packed.texts.length > 1 ? { part: { index: part + 1, of: packed.texts.length } } : {}),
    }));
  },
});
`;

function capitalise(channel: string): string {
  return channel
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

const BODIES: Readonly<Record<ScaffoldTemplate, (channel: string) => string>> = {
  file: FILE_TEMPLATE,
  ast: AST_TEMPLATE,
  external: EXTERNAL_TEMPLATE,
};

const testFile = (channel: string) => `import { expect, test } from 'bun:test';
import { inputFile } from '@sutras/code-lens-dense';
import transformer from './transformer.ts';

test('${channel} claims what it should and not what it should not', () => {
  expect(transformer.claim(inputFile('example.txt', 'hello'))).toBe(true);
  expect(transformer.claim(inputFile('example.bin', 'hello'))).toBe(false);
});
`;
