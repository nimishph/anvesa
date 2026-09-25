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
    let lineNum = 0;
    for (const line of lines) {
      lineNum += 1;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        continue;
      }

      // Laravel
      for (const match of line.matchAll(LARAVEL_ROUTE_REGEX)) {
        const method = (match[1] as string).toUpperCase();
        const routePath = match[2] as string;
        const handlerRaw = (match[3] ?? '').trim().replace(/;$/, '');
        const handler = cleanHandler(handlerRaw) || 'closure';
        records.push({
          id: `${ctx.path}:L${lineNum}:${method}:${routePath}`,
          path: ctx.path,
          attrs: {
            type: 'endpoint',
            method,
            route: routePath.startsWith('/') ? routePath : `/${routePath}`,
            handler,
            line: String(lineNum),
            framework: 'laravel',
          },
          text: `${method} ${routePath} -> ${handler}`,
        });
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

function cleanHandler(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned.replace(/['"]/g, '').replace(/\s*,\s*/g, '.');
}

export const routeEndpointAdapter = new RouteEndpointCorpusAdapter();
