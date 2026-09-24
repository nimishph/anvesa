import { builtinModules } from 'node:module';
import { ManifestInvalidError } from '../errors.ts';
import type { ImportFact } from '../extract/index.ts';
import type { WorkspacePackage } from '../workspace/discover.ts';
import { dirname, extension, join, withoutExtension } from './paths.ts';
import { AliasResolver, aliasCandidates, type ResolverEnvironment } from './tsconfig.ts';

export type { ResolverEnvironment } from './tsconfig.ts';

/** Where an import points. Nothing is dropped: an import that goes nowhere says why. */
export type Resolution =
  /** A file in the workspace. `via` says which rule found it. */
  | { readonly kind: 'file'; readonly path: string; readonly via: ResolvedVia }
  /** A package outside the workspace (or a runtime built-in). */
  | { readonly kind: 'external'; readonly name: string }
  /** It should resolve inside the workspace but does not. `tried` lists every path looked at. */
  | { readonly kind: 'dangling'; readonly reason: string; readonly tried: readonly string[] };

export type ResolvedVia = 'relative' | 'alias' | 'package' | 'module';

export interface ResolvedImport {
  readonly resolution: Resolution;
  /**
   * Python `from pkg import name`: `name` may be a submodule rather than something defined in
   * `pkg`. Maps each imported name that is a submodule file to that file.
   */
  readonly members: ReadonlyMap<string, string>;
}

const ECMASCRIPT: ReadonlySet<string> = new Set(['javascript', 'typescript', 'tsx', 'vue']);

/** Extensions of files that hold ECMAScript source, in the order they are tried. */
const SCRIPT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.vue',
];

/** A compiled extension and the source extensions it may have been written as. */
const SOURCE_OF: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** Folders that hold build output, whose sources sit under `src`. */
const OUTPUT_FOLDERS: ReadonlySet<string> = new Set(['dist', 'build', 'lib', 'out', 'esm', 'cjs']);

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Conditions in the `exports` map, most useful for finding source first. */
const CONDITION_ORDER = ['source', 'types', 'import', 'module', 'default', 'require', 'node'];

interface Manifest {
  readonly exports?: unknown;
  readonly module?: unknown;
  readonly main?: unknown;
  readonly types?: unknown;
  readonly typings?: unknown;
  readonly source?: unknown;
}

type ManifestState =
  | { readonly kind: 'ok'; readonly manifest: Manifest }
  | { readonly kind: 'invalid'; readonly problem: string }
  | { readonly kind: 'missing' };

/**
 * Turns an import as written into what it points at. Understands relative paths (including the
 * `.js`-written, `.ts`-stored convention), `tsconfig` aliases and base URLs, workspace packages by
 * name (through `exports`, `module`, `main` or `types`, with build output mapped back to `src`),
 * and Python modules (relative, and absolute against the source roots).
 */
export class ImportResolver {
  readonly #env: ResolverEnvironment;
  readonly #aliases: AliasResolver;
  readonly #packagesByName = new Map<string, WorkspacePackage>();
  readonly #pythonRoots: readonly string[];
  readonly #manifests = new Map<string, Promise<ManifestState>>();
  readonly #exists = new Map<string, Promise<boolean>>();

  constructor(env: ResolverEnvironment, packages: readonly WorkspacePackage[]) {
    this.#env = env;
    this.#aliases = new AliasResolver(env);
    for (const pkg of packages) {
      if (pkg.kind === 'npm' && !this.#packagesByName.has(pkg.name)) {
        this.#packagesByName.set(pkg.name, pkg);
      }
    }
    const roots = new Set<string>(['', 'src']);
    for (const pkg of packages) {
      roots.add(pkg.root);
      roots.add(pkg.root === '' ? 'src' : `${pkg.root}/src`);
    }
    this.#pythonRoots = [...roots];
  }

  async resolve(from: string, fact: ImportFact, language: string): Promise<ResolvedImport> {
    if (ECMASCRIPT.has(language)) {
      return { resolution: await this.#ecmaScript(from, fact.specifier), members: new Map() };
    }
    if (language === 'python') return this.#python(from, fact);
    if (language === 'php') return this.#php(from, fact);
    return {
      resolution: {
        kind: 'dangling',
        reason: `imports in ${language} are not understood yet`,
        tried: [],
      },
      members: new Map(),
    };
  }

  // --- shared -----------------------------------------------------------------------------------

  #has(path: string): Promise<boolean> {
    let known = this.#exists.get(path);
    if (!known) {
      known = this.#env.exists(path);
      this.#exists.set(path, known);
    }
    return known;
  }

  /** The first candidate that exists; otherwise everything that was looked at. */
  async #firstExisting(
    candidates: readonly string[],
  ): Promise<{ found: string } | { found: undefined; tried: readonly string[] }> {
    for (const candidate of candidates) {
      if (await this.#has(candidate)) return { found: candidate };
    }
    return { found: undefined, tried: candidates };
  }

  // --- ECMAScript -------------------------------------------------------------------------------

  async #ecmaScript(from: string, specifier: string): Promise<Resolution> {
    if (specifier.startsWith('.')) return this.#relativeScript(from, specifier);
    if (specifier.startsWith('/') || specifier.startsWith('node:') || BUILTINS.has(specifier)) {
      return { kind: 'external', name: specifier };
    }

    const tried: string[] = [];
    let aliasMatched = false;
    const config = await this.#aliases.configFor(dirname(from));
    if (config) {
      const targets = aliasCandidates(config, specifier);
      aliasMatched = targets.length > 0;
      for (const target of targets) {
        const hit = await this.#firstExisting(scriptCandidates(target));
        if (hit.found !== undefined) return { kind: 'file', path: hit.found, via: 'alias' };
        tried.push(...hit.tried);
      }
      if (config.baseUrl !== undefined) {
        const base = join(config.baseUrl, specifier);
        if (base !== undefined) {
          const hit = await this.#firstExisting(scriptCandidates(base));
          if (hit.found !== undefined) return { kind: 'file', path: hit.found, via: 'alias' };
        }
      }
    }

    const { name, subpath } = splitPackage(specifier);
    const pkg = this.#packagesByName.get(name);
    if (pkg) return this.#workspacePackage(pkg, subpath, specifier);

    if (aliasMatched) {
      return { kind: 'dangling', reason: 'a tsconfig path alias matches but no file does', tried };
    }
    return { kind: 'external', name };
  }

  async #relativeScript(from: string, specifier: string): Promise<Resolution> {
    const base = join(dirname(from), specifier);
    if (base === undefined) {
      return { kind: 'dangling', reason: 'the path leaves the workspace', tried: [] };
    }
    const hit = await this.#firstExisting(scriptCandidates(base));
    if (hit.found !== undefined) return { kind: 'file', path: hit.found, via: 'relative' };
    return { kind: 'dangling', reason: 'no such file', tried: hit.tried };
  }

  async #workspacePackage(
    pkg: WorkspacePackage,
    subpath: string,
    specifier: string,
  ): Promise<Resolution> {
    const state = await this.#manifest(pkg);
    if (state.kind === 'invalid') {
      return {
        kind: 'dangling',
        reason: `package.json of ${pkg.name} is not valid: ${state.problem}`,
        tried: [],
      };
    }
    const manifest = state.kind === 'ok' ? state.manifest : {};
    const targets = subpath === '' ? entryTargets(manifest) : subpathTargets(manifest, subpath);
    const bases: string[] = [];
    for (const target of targets) {
      const base = join(pkg.root, target);
      if (base !== undefined) bases.push(...sourceVariants(pkg.root, base));
    }
    if (subpath === '') {
      const index = join(pkg.root, 'index');
      const src = join(pkg.root, 'src/index');
      if (index !== undefined) bases.push(index);
      if (src !== undefined) bases.push(src);
    } else if (targets.length === 0) {
      for (const folder of ['', 'src']) {
        const base = join(pkg.root, folder, subpath);
        if (base !== undefined) bases.push(base);
      }
    }

    const candidates = unique(bases.flatMap(scriptCandidates));
    const hit = await this.#firstExisting(candidates);
    if (hit.found !== undefined) return { kind: 'file', path: hit.found, via: 'package' };
    return {
      kind: 'dangling',
      reason: `${specifier} names workspace package ${pkg.name}, but its entry point was not found`,
      tried: hit.tried,
    };
  }

  #manifest(pkg: WorkspacePackage): Promise<ManifestState> {
    let state = this.#manifests.get(pkg.root);
    if (!state) {
      state = this.#readManifest(pkg);
      this.#manifests.set(pkg.root, state);
    }
    return state;
  }

  async #readManifest(pkg: WorkspacePackage): Promise<ManifestState> {
    const path = pkg.manifest ?? (pkg.root === '' ? 'package.json' : `${pkg.root}/package.json`);
    const text = await this.#env.read(path);
    if (text === undefined) return { kind: 'missing' };
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'invalid', problem: 'it is not an object' };
      }
      return { kind: 'ok', manifest: parsed as Manifest };
    } catch (failure) {
      const invalid = new ManifestInvalidError(path, 'package.json', 'it is not valid JSON', {
        cause: failure,
      });
      return { kind: 'invalid', problem: invalid.message };
    }
  }

  // --- Python -----------------------------------------------------------------------------------

  async #python(from: string, fact: ImportFact): Promise<ResolvedImport> {
    const dots = leadingDots(fact.specifier);
    const segments = fact.specifier
      .slice(dots)
      .split('.')
      .filter((segment) => segment !== '');

    if (dots > 0) {
      let base: string | undefined = dirname(from);
      for (let up = 1; up < dots && base !== undefined; up += 1) base = join(base, '..');
      if (base === undefined) {
        return {
          resolution: { kind: 'dangling', reason: 'the path leaves the workspace', tried: [] },
          members: new Map(),
        };
      }
      const module = await this.#pythonModule([base], segments);
      const members = await this.#pythonMembers(module.directory ?? joinAll(base, segments), fact);
      if (module.found !== undefined) {
        return {
          resolution: { kind: 'file', path: module.found, via: 'relative' },
          members,
        };
      }
      // `from . import x` names no module of its own; it is fine if `x` is a submodule.
      if (segments.length === 0 && members.size > 0) {
        const first = [...members.values()][0] as string;
        return { resolution: { kind: 'file', path: first, via: 'relative' }, members };
      }
      return {
        resolution: { kind: 'dangling', reason: 'no such module', tried: module.tried },
        members,
      };
    }

    const module = await this.#pythonModule(this.#pythonRoots, segments);
    if (module.found !== undefined) {
      const members = await this.#pythonMembers(module.directory ?? dirname(module.found), fact);
      return { resolution: { kind: 'file', path: module.found, via: 'module' }, members };
    }
    // A namespace package has no `__init__.py`, but `from ns import mod` can still find `ns/mod.py`.
    for (const root of this.#pythonRoots) {
      const members = await this.#pythonMembers(joinAll(root, segments), fact);
      if (members.size > 0) {
        const first = [...members.values()][0] as string;
        return { resolution: { kind: 'file', path: first, via: 'module' }, members };
      }
    }
    return {
      resolution: { kind: 'external', name: segments[0] ?? fact.specifier },
      members: new Map(),
    };
  }

  /** The file for a dotted module path under the first root that has it. */
  async #pythonModule(
    roots: readonly string[],
    segments: readonly string[],
  ): Promise<{ found: string | undefined; directory?: string; tried: readonly string[] }> {
    const tried: string[] = [];
    for (const root of roots) {
      const base = joinAll(root, segments);
      if (base === undefined) continue;
      const asFile = segments.length === 0 ? undefined : `${base}.py`;
      const asPackage = base === '' ? '__init__.py' : `${base}/__init__.py`;
      for (const candidate of asFile === undefined ? [asPackage] : [asFile, asPackage]) {
        if (await this.#has(candidate)) {
          return { found: candidate, directory: base, tried };
        }
        tried.push(candidate);
      }
    }
    return { found: undefined, tried };
  }

  /** Which names imported with `from <module> import ...` are submodules of `directory`. */
  async #pythonMembers(
    directory: string | undefined,
    fact: ImportFact,
  ): Promise<ReadonlyMap<string, string>> {
    const members = new Map<string, string>();
    if (directory === undefined) return members;
    for (const binding of fact.bindings) {
      if (binding.imported === '*') continue;
      const base = directory === '' ? binding.imported : `${directory}/${binding.imported}`;
      for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
        if (await this.#has(candidate)) {
          members.set(binding.imported, candidate);
          break;
        }
      }
    }
    return members;
  }

  // --- PHP ---------------------------------------------------------------------------------------

  async #php(_from: string, fact: ImportFact): Promise<ResolvedImport> {
    const specifier = fact.specifier.replace(/^\\+/, '');
    const pathWithExt = `${specifier.replace(/\\/g, '/')}.php`;

    const slashIdx = pathWithExt.indexOf('/');
    const lowerFirst =
      slashIdx !== -1
        ? pathWithExt.slice(0, slashIdx).toLowerCase() + pathWithExt.slice(slashIdx)
        : pathWithExt;
    const withoutFirst = slashIdx !== -1 ? pathWithExt.slice(slashIdx + 1) : pathWithExt;

    const candidatePaths = new Set<string>();
    for (const root of this.#pythonRoots) {
      const prefix = root === '' ? '' : `${root}/`;
      candidatePaths.add(`${prefix}${pathWithExt}`);
      candidatePaths.add(`${prefix}${lowerFirst}`);
      candidatePaths.add(`${prefix}src/${withoutFirst}`);
      candidatePaths.add(`${prefix}app/${withoutFirst}`);
      candidatePaths.add(`${prefix}app/${pathWithExt}`);
    }

    const existing = await this.#firstExisting([...candidatePaths]);
    if (existing.found !== undefined) {
      return {
        resolution: { kind: 'file', path: existing.found, via: 'module' },
        members: new Map(),
      };
    }

    return {
      resolution: { kind: 'external', name: fact.specifier },
      members: new Map(),
    };
  }
}

// --- helpers --------------------------------------------------------------------------------------

function joinAll(root: string, segments: readonly string[]): string | undefined {
  return join(root, ...segments);
}

function leadingDots(specifier: string): number {
  let count = 0;
  while (specifier.charAt(count) === '.') count += 1;
  return count;
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** `@scope/pkg/deep/path` is package `@scope/pkg`, subpath `deep/path`. */
export function splitPackage(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/');
  const count = specifier.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, count).join('/'), subpath: parts.slice(count).join('/') };
}

/**
 * Every file a path written in an import might be, most likely first. A specifier is often
 * written without an extension, or with the compiled one (`./x.js` for `x.ts`), or names a folder.
 */
export function scriptCandidates(base: string): string[] {
  const ext = extension(base);
  const candidates: string[] = [];

  if (base.endsWith('.d.ts')) {
    const stem = base.slice(0, base.length - '.d.ts'.length);
    candidates.push(base, `${stem}.ts`, `${stem}.tsx`);
  } else if (ext in SOURCE_OF) {
    // `./x.js` is written for the compiled name; the source beside it (`x.ts`) is what this
    // workspace holds, and what the TypeScript compiler picks when both exist.
    const stem = withoutExtension(base);
    for (const written of SOURCE_OF[ext] ?? []) candidates.push(`${stem}${written}`);
    candidates.push(base);
  } else if (SCRIPT_EXTENSIONS.includes(ext)) {
    candidates.push(base);
  } else {
    candidates.push(base);
    for (const added of SCRIPT_EXTENSIONS) candidates.push(`${base}${added}`);
  }

  if (!SCRIPT_EXTENSIONS.includes(ext)) {
    for (const added of SCRIPT_EXTENSIONS) candidates.push(`${base}/index${added}`);
  }
  return candidates;
}

/** A build-output path and the path its source would have: `dist/x.js` -> `src/x.js`, `x.js`. */
function sourceVariants(root: string, path: string): string[] {
  const inside = root === '' ? path : path.slice(root.length + 1);
  const [first, ...rest] = inside.split('/');
  if (first === undefined || !OUTPUT_FOLDERS.has(first) || rest.length === 0) return [path];
  const relative = rest.join('/');
  const variants = [join(root, 'src', relative), join(root, relative), path].filter(
    (variant): variant is string => variant !== undefined,
  );
  return variants;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every string a value in an `exports` map can stand for, conditions ordered by usefulness. */
function targetsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(targetsOf);
  if (!isRecord(value)) return [];
  const keys = Object.keys(value);
  const ordered = [
    ...CONDITION_ORDER.filter((key) => key in value),
    ...keys.filter((key) => !CONDITION_ORDER.includes(key)),
  ];
  return ordered.flatMap((key) => targetsOf(value[key]));
}

/** Where a package's root entry can be: `exports["."]`, then `module`, `main`, `types`, `source`. */
function entryTargets(manifest: Manifest): string[] {
  const exported = manifest.exports;
  const fromExports = isRecord(exported)
    ? Object.keys(exported).some((key) => key.startsWith('.'))
      ? targetsOf(exported['.'])
      : targetsOf(exported)
    : targetsOf(exported);
  const fields = [
    manifest.source,
    manifest.module,
    manifest.main,
    manifest.types,
    manifest.typings,
  ];
  return unique([...fromExports, ...fields.filter((f): f is string => typeof f === 'string')]);
}

/** Where `pkg/subpath` can be, from an exact or wildcard `exports` entry. */
function subpathTargets(manifest: Manifest, subpath: string): string[] {
  const exported = manifest.exports;
  if (!isRecord(exported)) return [];
  const key = `./${subpath}`;
  if (key in exported) return targetsOf(exported[key]);
  let best: { prefix: number; targets: string[] } | undefined;
  for (const [pattern, value] of Object.entries(exported)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.length < prefix.length + suffix.length) continue;
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (best !== undefined && prefix.length <= best.prefix) continue;
    const captured = key.slice(prefix.length, key.length - suffix.length);
    best = {
      prefix: prefix.length,
      targets: targetsOf(value).map((t) => t.replace('*', captured)),
    };
  }
  return best?.targets ?? [];
}
