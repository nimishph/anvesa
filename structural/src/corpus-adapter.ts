/**
 * The Corpus Adapter contract and built-in adapters.
 *
 * A corpus adapter maps an arbitrary codebase convention (a doc format, a config schema,
 * a docblock annotation) onto queryable records stored in the index.
 */

export interface CorpusRecord {
  readonly id: string;
  readonly path: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text?: string | undefined;
}

export interface CorpusClaimContext {
  readonly path: string;
  readonly lang?: string;
  readonly content: string;
}

export interface CorpusExtractContext extends CorpusClaimContext {
  readonly wexpr?: unknown;
}

export interface CorpusAdapter {
  readonly name: string;
  claim(ctx: CorpusClaimContext): boolean;
  extract(ctx: CorpusExtractContext): readonly CorpusRecord[];
}

/** Regex finding docblock tag annotations: @tag optional_value */
const DOCBLOCK_TAG_REGEX = /@([a-zA-Z0-9_-]+)(?:\s+([^\r\n*]+))?/g;

/** Supported source file extensions for docblock annotation extraction. */
const DOCBLOCK_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.php',
  '.rb',
]);

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

/**
 * Built-in CorpusAdapter that extracts @tag docblock annotations into queryable corpus records.
 * For example:
 *   //** @owner alice
 *   // * @auth jwt
 * Emits records with attrs: { owner: "alice", auth: "jwt" }
 */
export class DocblockAnnotationCorpusAdapter implements CorpusAdapter {
  readonly name = 'docblock-annotations';

  claim(ctx: CorpusClaimContext): boolean {
    const ext = getExtension(ctx.path);
    return DOCBLOCK_EXTENSIONS.has(ext);
  }

  extract(ctx: CorpusExtractContext): readonly CorpusRecord[] {
    const records: CorpusRecord[] = [];
    const lines = ctx.content.split(/\r?\n/);
    let lineNum = 0;

    for (const line of lines) {
      lineNum += 1;
      for (const match of line.matchAll(DOCBLOCK_TAG_REGEX)) {
        const tag = match[1] as string;
        const val = (match[2] ?? '').trim() || 'true';
        const id = `${ctx.path}:L${lineNum}:@${tag}`;
        records.push({
          id,
          path: ctx.path,
          attrs: {
            tag,
            value: val,
            [tag]: val,
            line: String(lineNum),
          },
          text: line.trim(),
        });
      }
    }
    return records;
  }
}

export const docblockAnnotationAdapter = new DocblockAnnotationCorpusAdapter();
