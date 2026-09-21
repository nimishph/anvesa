import { packCards } from '../budget.ts';
import { type CardDraft, defineTransformer, type InputFile, type Transformer } from '../card.ts';
import { decomposePath } from '../text.ts';

const DOC_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);

function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export interface DocsOptions {
  readonly name?: string;
  readonly channel?: string;
}

interface Section {
  /** Headings from the document title down to this section. */
  readonly trail: readonly string[];
  readonly lines: string[];
}

/**
 * Cards for prose documentation, one per section. A section's card carries its heading trail
 * ("Guide > Install > Windows") so it is found by the topic it sits under, and its text is
 * packed to the encoder's window with the trail repeated on each continuation.
 *
 * It needs no language model: sections come from the document's own headings. Documentation is
 * written by people other than the code's authors as often as not, so it is `third-party`, which
 * the red-team gate reads more strictly than code.
 */
export function docsTransformer(options: DocsOptions = {}): Transformer {
  return defineTransformer({
    name: options.name ?? 'docs',
    version: '1',
    channel: options.channel ?? 'docs',
    categoryId: 'doc.section',
    categoryLabel: 'Documentation section',
    trust: 'third-party',
    claim: (file) => DOC_EXTENSIONS.has(extensionOf(file.path)),
    transform(file, context) {
      const modulePath = decomposePath(file.path).join(' ');
      const used = new Map<string, number>();
      const drafts: CardDraft[] = [];

      for (const section of sectionsOf(file)) {
        context.deadline.throwIfExpired(`build cards for ${file.path}`);
        const blocks = paragraphs(section.lines).map((text) => ({ text }));
        if (blocks.length === 0) continue;

        const trail = section.trail.length > 0 ? ` › ${section.trail.join(' › ')}` : '';
        const packed = packCards(`doc ${modulePath}${trail}`, blocks, context.budget);

        const base = section.trail.length > 0 ? section.trail.join('/') : 'document';
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        const key = seen === 0 ? base : `${base}#${seen + 1}`;

        packed.texts.forEach((text, index) => {
          drafts.push({
            key,
            text,
            group: key,
            attrs: { section: section.trail.join(' › ') },
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

// --- sectioning ---------------------------------------------------------------------------------

interface Heading {
  readonly level: number;
  readonly title: string;
  /** How many lines the heading itself takes (rst titles have an underline). */
  readonly span: number;
}

function sectionsOf(file: InputFile): Section[] {
  const lines = file.content.split(/\r?\n/);
  const extension = extensionOf(file.path);
  const headingAt =
    extension === '.md' || extension === '.mdx'
      ? markdownHeading
      : extension === '.adoc'
        ? asciidocHeading
        : extension === '.rst'
          ? restructuredHeading
          : () => undefined;

  const sections: Section[] = [];
  let trail: { level: number; title: string }[] = [];
  let current: Section = { trail: [], lines: [] };
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) fence = fence === null ? marker : fence === marker ? null : fence;
    // A fence line and anything inside a fence is code, never a heading.
    const heading = fence === null && marker === undefined ? headingAt(lines, index) : undefined;

    if (heading) {
      sections.push(current);
      trail = [
        ...trail.filter((entry) => entry.level < heading.level),
        { level: heading.level, title: heading.title },
      ];
      current = { trail: trail.map((entry) => entry.title), lines: [] };
      index += heading.span - 1;
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function markdownHeading(lines: readonly string[], index: number): Heading | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index] as string);
  return match
    ? { level: (match[1] as string).length, title: match[2] as string, span: 1 }
    : undefined;
}

function asciidocHeading(lines: readonly string[], index: number): Heading | undefined {
  const match = /^(={1,6})\s+(.+?)\s*$/.exec(lines[index] as string);
  return match
    ? { level: (match[1] as string).length, title: match[2] as string, span: 1 }
    : undefined;
}

/** reStructuredText: a title line followed by an underline of one repeated punctuation mark. */
const RST_LEVELS = '=-~^"\'`#*+';

function restructuredHeading(lines: readonly string[], index: number): Heading | undefined {
  const title = (lines[index] as string).trim();
  const underline = (lines[index + 1] ?? '').trim();
  if (title === '' || underline.length < title.length) return undefined;
  const mark = underline[0] as string;
  if (!RST_LEVELS.includes(mark) || underline !== mark.repeat(underline.length)) return undefined;
  return { level: RST_LEVELS.indexOf(mark) + 1, title, span: 2 };
}

/** Blank-line separated paragraphs, keeping a fenced code block whole. */
function paragraphs(lines: readonly string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const text = current.join('\n').trim();
    if (text.length > 0) out.push(text);
    current = [];
  };
  for (const line of lines) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) fence = fence === null ? marker : fence === marker ? null : fence;
    if (line.trim() === '' && fence === null) flush();
    else current.push(line);
  }
  flush();
  return out;
}
