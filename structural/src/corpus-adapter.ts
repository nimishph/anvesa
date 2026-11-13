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

/** Regex finding Laravel routes: Route::get('/path', ...) */
const LARAVEL_ROUTE_REGEX =
  /\bRoute::(get|post|put|delete|patch|options|any)\(\s*['"]([^'"]+)['"](?:\s*,\s*([^)]+))?/gi;

/** Regex finding Lumen routes on the injected router: $router->get('/path', ...) */
const LUMEN_ROUTE_REGEX =
  /\$router->(get|post|put|delete|patch|options|any|fallback)\(\s*['"]([^'"]+)['"](?:\s*,\s*([^)]+))?/gi;

/** Regex finding Express/Node routes: app.get('/path', ...) or router.post('/path', ...) */
const EXPRESS_ROUTE_REGEX =
  /\b(?:app|router)\.(get|post|put|delete|patch|all)\(\s*['"]([^'"]+)['"](?:\s*,\s*([^)]+))?/gi;

/** Regex finding FastAPI / Flask routes: @app.get('/path') or @router.post('/path') */
const PYTHON_ROUTE_REGEX = /@(?:app|router)\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/gi;

/** Regex for Next.js app directory route files: app/.../route.ts */
const NEXTJS_ROUTE_FILE_REGEX = /(?:^|\/)(?:src\/)?app\/(.+)\/route\.[jt]sx?$/i;
const HTTP_EXPORT_FUNCTION_REGEX =
  /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;

/**
 * Built-in CorpusAdapter that extracts HTTP route definitions across Laravel, Express,
 * Next.js, and FastAPI/Flask into queryable corpus records with corpus: 'endpoints'.
 */
export class RouteEndpointCorpusAdapter implements CorpusAdapter {
  readonly name = 'endpoints';

  claim(ctx: CorpusClaimContext): boolean {
    const ext = getExtension(ctx.path);
    if (!['.php', '.js', '.ts', '.jsx', '.tsx', '.py'].includes(ext)) return false;

    // Check if path or content suggests routing
    if (ctx.path.includes('route') || ctx.path.includes('controller') || ctx.path.includes('api')) {
      return true;
    }
    return (
      ctx.content.includes('Route::') ||
      ctx.content.includes('$router->') ||
      ctx.content.includes('router.') ||
      ctx.content.includes('app.') ||
      NEXTJS_ROUTE_FILE_REGEX.test(ctx.path)
    );
  }

  extract(ctx: CorpusExtractContext): readonly CorpusRecord[] {
    const records: CorpusRecord[] = [];
    const lines = ctx.content.split(/\r?\n/);

    // 1. Next.js App Router file-based handlers
    const nextMatch = ctx.path.replace(/\\/g, '/').match(NEXTJS_ROUTE_FILE_REGEX);
    if (nextMatch?.[1]) {
      const routePath = `/${nextMatch[1]}`;
      for (const fnMatch of ctx.content.matchAll(HTTP_EXPORT_FUNCTION_REGEX)) {
        const method = (fnMatch[1] as string).toUpperCase();
        records.push({
          id: `${ctx.path}:L1:${method}:${routePath}`,
          path: ctx.path,
          attrs: {
            type: 'endpoint',
            method,
            route: routePath,
            handler: `${ctx.path}#${method}`,
            line: '1',
            framework: 'nextjs',
          },
          text: `${method} ${routePath} -> ${ctx.path}#${method}`,
        });
      }
    }

    // 2. Line-by-line regex extraction for Laravel, Express, Python
    const groups = laravelGroups(ctx.content);
    const lineStarts: number[] = [];
    for (let at = 0, i = 0; i < lines.length; i++) {
      lineStarts.push(at);
      at = ctx.content.indexOf('\n', at) + 1;
    }
    let lineNum = 0;
    for (const line of lines) {
      lineNum += 1;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        continue;
      }

      // Laravel's Route:: facade, and Lumen's injected $router
      for (const pattern of [LARAVEL_ROUTE_REGEX, LUMEN_ROUTE_REGEX]) {
        for (const match of line.matchAll(pattern)) {
          const method = (match[1] as string).toUpperCase();
          // The prefixes of every group the route sits in, outermost first (#46).
          const offset = (lineStarts[lineNum - 1] ?? 0) + (match.index ?? 0);
          const routePath = joinRoute([...prefixesAt(groups, offset), match[2] as string]);
          const handlerRaw = (match[3] ?? '').trim().replace(/;$/, '');
          const handler = cleanHandler(handlerRaw) || 'closure';
          records.push({
            id: `${ctx.path}:L${lineNum}:${method}:${routePath}`,
            path: ctx.path,
            attrs: {
              type: 'endpoint',
              method,
              route: routePath,
              handler,
              line: String(lineNum),
              framework: 'laravel',
            },
            text: `${method} ${routePath} -> ${handler}`,
          });
        }
      }

      // Express / Koa
      for (const match of line.matchAll(EXPRESS_ROUTE_REGEX)) {
        const method = (match[1] as string).toUpperCase();
        const routePath = match[2] as string;
        const handlerRaw = (match[3] ?? '').trim().replace(/;$/, '');
        const handler = cleanHandler(handlerRaw) || 'handler';
        records.push({
          id: `${ctx.path}:L${lineNum}:${method}:${routePath}`,
          path: ctx.path,
          attrs: {
            type: 'endpoint',
            method: method === 'ALL' ? 'ANY' : method,
            route: routePath.startsWith('/') ? routePath : `/${routePath}`,
            handler,
            line: String(lineNum),
            framework: 'express',
          },
          text: `${method} ${routePath} -> ${handler}`,
        });
      }

      // FastAPI / Flask
      for (const match of line.matchAll(PYTHON_ROUTE_REGEX)) {
        const method = (match[1] as string).toUpperCase();
        const routePath = match[2] as string;
        records.push({
          id: `${ctx.path}:L${lineNum}:${method}:${routePath}`,
          path: ctx.path,
          attrs: {
            type: 'endpoint',
            method,
            route: routePath.startsWith('/') ? routePath : `/${routePath}`,
            handler: 'endpoint',
            line: String(lineNum),
            framework: 'fastapi',
          },
          text: `${method} ${routePath}`,
        });
      }

      // Vue Router / React Router
      if (ctx.path.includes('route') || ctx.path.includes('router')) {
        for (const match of line.matchAll(/\bpath:\s*['"]([^'"]+)['"]/g)) {
          const routePath = match[1] as string;
          if (routePath.startsWith('/') || routePath === '') {
            const formatted = routePath.startsWith('/') ? routePath : `/${routePath}`;
            records.push({
              id: `${ctx.path}:L${lineNum}:PAGE:${formatted}`,
              path: ctx.path,
              attrs: {
                type: 'endpoint',
                method: 'PAGE',
                route: formatted,
                handler: `${ctx.path}:L${lineNum}`,
                line: String(lineNum),
                framework: 'router',
              },
              text: `PAGE ${formatted} -> ${ctx.path}:L${lineNum}`,
            });
          }
        }
      }
    }

    return records;
  }
}

/** A Laravel/Lumen route group with a prefix: the prefix, and the span of its closure body. */
interface RouteGroup {
  readonly prefix: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Where a group call begins: `Route::` or `$router->`, then any chain of calls (`prefix('x')`,
 * `middleware([...])`, `name('x.')`, `controller(X::class)`) ending in `group(`.
 */
const GROUP_CALL_REGEX = /(?:\bRoute::|\$router->)((?:\w+\([^;{}]*?\)\s*->\s*)*)group\s*\(/g;

/**
 * Every route group in a routes file that sets a prefix, in both the fluent form
 * (`Route::prefix('cart')->group(function () {...})`) and the array form
 * (`Route::group(['prefix' => 'cart'], function () {...})`). A group without a closure body
 * (a file path) has nothing inside it to prefix and is skipped.
 */
function laravelGroups(content: string): RouteGroup[] {
  const groups: RouteGroup[] = [];
  for (const match of content.matchAll(GROUP_CALL_REGEX)) {
    const open = (match.index ?? 0) + match[0].length;
    const fluent = /\bprefix\(\s*['"]([^'"]*)['"]/.exec(match[1] ?? '')?.[1];
    const bodyAt = content.indexOf('{', open);
    if (bodyAt === -1) continue;
    // The array form's options sit between `group(` and the closure.
    const options = content.slice(open, bodyAt);
    const arrayPrefix = /['"]prefix['"]\s*=>\s*['"]([^'"]*)['"]/.exec(options)?.[1];
    if (!/\bfunction\b|\bfn\b/.test(options)) continue;
    const end = closingBrace(content, bodyAt);
    const prefix = fluent ?? arrayPrefix;
    if (prefix !== undefined && end !== -1) groups.push({ prefix, start: bodyAt, end });
  }
  return groups;
}

/** The index of the `}` that closes the `{` at `open`, skipping quoted strings and comments. */
function closingBrace(content: string, open: number): number {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const char = content[i];
    if (char === "'" || char === '"') {
      for (i++; i < content.length && content[i] !== char; i++) if (content[i] === '\\') i++;
    } else if (char === '/' && content[i + 1] === '/') {
      i = content.indexOf('\n', i);
      if (i === -1) return -1;
    } else if (char === '/' && content[i + 1] === '*') {
      i = content.indexOf('*/', i + 2);
      if (i === -1) return -1;
      i++;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The prefixes of the groups enclosing `offset`, outermost first. */
function prefixesAt(groups: readonly RouteGroup[], offset: number): string[] {
  return groups
    .filter((group) => group.start < offset && offset < group.end)
    .sort((a, b) => a.start - b.start)
    .map((group) => group.prefix);
}

/** Path segments joined with single slashes, always starting with one: `['cart', '/']` is `/cart`. */
function joinRoute(segments: readonly string[]): string {
  const parts = segments.map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

function cleanHandler(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned.replace(/['"]/g, '').replace(/\s*,\s*/g, '.');
}

export const routeEndpointAdapter = new RouteEndpointCorpusAdapter();
