/**
 * Ignore rules with gitignore semantics, so the indexer skips exactly what git does.
 *
 * The rules implemented, from `gitignore(5)`:
 * - blank lines and `#` comments are skipped; `\#` and `\!` are literal
 * - trailing spaces are dropped unless escaped; `!` re-includes
 * - a trailing `/` matches directories only
 * - a pattern with a `/` at the start or in the middle is anchored to the ignore file's
 *   directory; one without matches a name at any depth below it
 * - a single star and `?` never cross `/`; `[...]` is a character class; a double star between
 *   slashes, or at the start or end of a pattern, does cross directories
 * - within one file the last matching rule wins; a file nearer the path beats one further up
 * - a directory that is excluded cannot have anything inside it re-included
 */

export interface IgnoreRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  /** Anchored rules match the path below the ignore file's directory; others match the name. */
  readonly anchored: boolean;
  readonly regex: RegExp;
  /** The line as written, for reporting. */
  readonly source: string;
}

/** One ignore file's rules, applying to everything under `base`. */
export interface IgnoreLayer {
  /** Directory the file lives in, relative to the workspace root, `/`-separated. `''` is the root. */
  readonly base: string;
  readonly rules: readonly IgnoreRule[];
  /** Where the rules came from, e.g. `.gitignore` or `config`. */
  readonly origin: string;
}

export interface ParseOptions {
  readonly caseInsensitive?: boolean;
}

/** Parse the text of an ignore file. Malformed lines are handled the way git handles them. */
export function parseIgnore(text: string, options: ParseOptions = {}): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    const rule = parseLine(raw.replace(/\r$/, ''), options.caseInsensitive === true);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseLine(source: string, caseInsensitive: boolean): IgnoreRule | undefined {
  let line = source;
  if (line === '' || line.startsWith('#')) return undefined;

  // Trailing spaces are dropped unless the last one is escaped.
  while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1);
  if (line === '') return undefined;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }

  let dirOnly = false;
  if (line.endsWith('/') && !line.endsWith('\\/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === '') return undefined;

  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  if (line === '') return undefined;

  const body = translate(line);
  const regex = new RegExp(`^${body}$`, caseInsensitive ? 'i' : '');
  return { negated, dirOnly, anchored, regex, source };
}

/** Turn a gitignore glob into the body of a regular expression. */
function translate(glob: string): string {
  let out = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index] as string;

    if (char === '\\') {
      const next = glob[index + 1];
      if (next === undefined) {
        out += '\\\\';
        index += 1;
      } else {
        out += escapeRegex(next);
        index += 2;
      }
      continue;
    }

    if (char === '*') {
      if (glob[index + 1] === '*') {
        const atStart = index === 0 || glob[index - 1] === '/';
        const before = glob[index - 1];
        let stars = 2;
        while (glob[index + stars] === '*') stars += 1;
        const after = glob[index + stars];
        if (atStart && after === '/') {
          // `**/` : zero or more directories
          out += '(?:.*/)?';
          index += stars + 1;
          continue;
        }
        if (atStart && after === undefined) {
          // A lone `**` (or a trailing `/**`, seen as `/` + `**`): everything.
          out += before === '/' ? '.+' : '.*';
          index += stars;
          continue;
        }
      }
      // Any other run of asterisks is an ordinary `*`.
      let end = index;
      while (glob[end] === '*') end += 1;
      out += '[^/]*';
      index = end;
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      const parsed = parseBracket(glob, index);
      if (parsed) {
        out += parsed.regex;
        index = parsed.next;
        continue;
      }
      out += '\\[';
      index += 1;
      continue;
    }

    out += escapeRegex(char);
    index += 1;
  }
  return out;
}

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '\\x21-\\x7e',
  lower: 'a-z',
  print: '\\x20-\\x7e',
  punct: '!-\\/:-@\\[-`{-~',
  space: ' \\t\\r\\n\\v\\f',
  upper: 'A-Z',
  xdigit: '0-9A-Fa-f',
};

/** A `[...]` expression at `start`, or undefined when it is never closed (then `[` is literal). */
function parseBracket(glob: string, start: number): { regex: string; next: number } | undefined {
  let index = start + 1;
  let negated = false;
  if (glob[index] === '!' || glob[index] === '^') {
    negated = true;
    index += 1;
  }
  let body = '';
  let first = true;
  while (index < glob.length) {
    const char = glob[index] as string;
    if (char === ']' && !first) {
      // Like the shell, a bracket never matches `/`.
      return { regex: `(?!/)[${negated ? '^' : ''}${body}]`, next: index + 1 };
    }
    first = false;
    if (char === '[' && glob[index + 1] === ':') {
      const close = glob.indexOf(':]', index + 2);
      if (close !== -1) {
        const cls = POSIX_CLASSES[glob.slice(index + 2, close)];
        if (cls) {
          body += cls;
          index = close + 2;
          continue;
        }
      }
    }
    if (char === '\\' && index + 1 < glob.length) {
      body += escapeClass(glob[index + 1] as string);
      index += 2;
      continue;
    }
    body += char === '-' ? '-' : escapeClass(char);
    index += 1;
  }
  return undefined;
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

function escapeClass(char: string): string {
  return /[\]\\^]/.test(char) ? `\\${char}` : char;
}

/**
 * A whole-path glob, for patterns that are not ignore rules (workspace member lists such as
 * `packages/*`). Unlike an ignore rule it is always anchored: `apps` means the top-level `apps`.
 */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  const body = glob.startsWith('/') ? glob.slice(1) : glob;
  return new RegExp(`^${translate(body)}$`, caseInsensitive ? 'i' : '');
}

// --- evaluation ---------------------------------------------------------------------------------

export type Decision = 'ignore' | 'include';

/** What one layer says about a path, or undefined when none of its rules match. */
export function decideLayer(
  layer: IgnoreLayer,
  path: string,
  isDirectory: boolean,
): Decision | undefined {
  let relative: string;
  if (layer.base === '') {
    relative = path;
  } else if (path.startsWith(`${layer.base}/`)) {
    relative = path.slice(layer.base.length + 1);
  } else {
    return undefined;
  }
  if (relative === '') return undefined;

  const name = relative.slice(relative.lastIndexOf('/') + 1);
  let decision: Decision | undefined;
  for (const rule of layer.rules) {
    if (rule.dirOnly && !isDirectory) continue;
    if (rule.regex.test(rule.anchored ? relative : name)) {
      decision = rule.negated ? 'include' : 'ignore';
    }
  }
  return decision;
}

/**
 * An ordered set of ignore layers, lowest precedence first. Immutable: `with` returns a new stack,
 * so a directory walk can add a directory's own ignore file for that subtree only.
 */
export class IgnoreStack {
  readonly layers: readonly IgnoreLayer[];

  constructor(layers: readonly IgnoreLayer[] = []) {
    this.layers = layers;
  }

  with(layer: IgnoreLayer): IgnoreStack {
    return layer.rules.length === 0 ? this : new IgnoreStack([...this.layers, layer]);
  }

  /**
   * What the nearest layer with an opinion says about this exact path, ignoring its parents.
   * A walker that does not descend into ignored directories can use this alone.
   */
  decide(path: string, isDirectory: boolean): Decision | undefined {
    for (let index = this.layers.length - 1; index >= 0; index -= 1) {
      const decision = decideLayer(this.layers[index] as IgnoreLayer, path, isDirectory);
      if (decision !== undefined) return decision;
    }
    return undefined;
  }

  isIgnored(path: string, isDirectory: boolean): boolean {
    return this.decide(path, isDirectory) === 'ignore';
  }

  /**
   * Whether a path is ignored once its parent directories are considered: an ignored directory
   * takes everything inside it with it. Use this for a path found outside a walk.
   */
  isIgnoredWithParents(path: string, isDirectory: boolean): boolean {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (this.isIgnored(parts.slice(0, depth).join('/'), true)) return true;
    }
    return this.isIgnored(path, isDirectory);
  }
}
