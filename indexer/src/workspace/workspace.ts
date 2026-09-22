import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Deadline } from '@cntxt-labs/code-lens-core';
import { toCodeLensError } from '@cntxt-labs/code-lens-core';
import {
  IndexerSubsystemError,
  UnknownPackageError,
  WorkspaceConfigError,
  WorkspaceRootError,
} from '../errors.ts';
import {
  defaultConfig,
  loadWorkspaceConfig,
  toWorkspacePackage,
  type WorkspaceConfig,
} from './config.ts';
import {
  type Diagnostic,
  type DiscoveryContext,
  defaultAdapters,
  dirnameOf,
  discoverPackages,
  expandGlobs,
  type PackageDiscoverer,
  type WorkspacePackage,
} from './discover.ts';
import { Traversal, type TraversalReport, type TraverseOptions } from './traverse.ts';

export interface WorkspaceOptions {
  readonly root: string;
  /** Settings to use instead of reading `.code-lens/workspace.json`. */
  readonly config?: WorkspaceConfig;
  /** Adapters to use instead of the built-in set (still filtered by `config.adapters`). */
  readonly adapters?: readonly PackageDiscoverer[];
  readonly deadline?: Deadline;
}

/** Which files a query or an index run is about. Everything named is combined; none means all. */
export interface ScopeSpec {
  /** Package names or package root directories. */
  readonly packages?: readonly string[];
  /** Also include everything these packages depend on. */
  readonly withDependencies?: boolean;
  /** Also include everything that depends on these packages. */
  readonly withDependents?: boolean;
  /** Directory prefixes, relative to the workspace root. */
  readonly paths?: readonly string[];
}

/**
 * A directory tree understood as packages: where the code is, what it is called, and what it
 * depends on. It works the same for one package, a monorepo of many, or a tree of nested repos.
 */
export class Workspace {
  readonly root: string;
  readonly config: WorkspaceConfig;
  readonly caseInsensitive: boolean;
  /** Everything discovery could not understand. Empty when all manifests read cleanly. */
  readonly diagnostics: readonly Diagnostic[];
  /** What the survey that found the packages saw: ignored entries, nested repos, unreadable dirs. */
  readonly survey: TraversalReport;
  readonly #packages: readonly WorkspacePackage[];
  readonly #byRoot: ReadonlyMap<string, WorkspacePackage>;
  readonly #byName: ReadonlyMap<string, readonly WorkspacePackage[]>;

  private constructor(parts: {
    root: string;
    config: WorkspaceConfig;
    caseInsensitive: boolean;
    packages: readonly WorkspacePackage[];
    diagnostics: readonly Diagnostic[];
    survey: TraversalReport;
  }) {
    this.root = parts.root;
    this.config = parts.config;
    this.caseInsensitive = parts.caseInsensitive;
    this.diagnostics = parts.diagnostics;
    this.survey = parts.survey;
    this.#packages = parts.packages;
    this.#byRoot = new Map(parts.packages.map((pkg) => [pkg.root, pkg]));
    const byName = new Map<string, WorkspacePackage[]>();
    for (const pkg of parts.packages) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);
    this.#byName = byName;
  }

  static async open(options: WorkspaceOptions): Promise<Workspace> {
    const root = resolve(options.root);
    try {
      if (!(await stat(root)).isDirectory())
        throw new WorkspaceRootError(root, 'it is not a directory');
    } catch (failure) {
      if (failure instanceof IndexerSubsystemError) throw failure;
      throw new WorkspaceRootError(root, 'it cannot be read', { cause: failure });
    }

    const config = options.config ?? (await loadWorkspaceConfig(root)) ?? defaultConfig();
    const caseInsensitive =
      config.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin');
    const adapters = selectAdapters(options.adapters ?? defaultAdapters(), config);

    const manifestNames = new Set(adapters.flatMap((adapter) => adapter.manifestNames));
    const directories = new Set<string>();
    const manifests = new Map<string, string[]>();
    const traversal = new Traversal({
      root,
      caseInsensitive,
      configExclude: config.exclude,
      nestedRepos: config.nestedRepos,
      followSymlinks: config.followSymlinks,
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });
    for await (const visit of traversal) {
      directories.add(visit.path);
      for (const entry of visit.entries) {
        if (entry.kind === 'file' && manifestNames.has(entry.name)) {
          manifests.set(entry.name, [...(manifests.get(entry.name) ?? []), entry.path]);
        }
      }
    }

    const diagnostics: Diagnostic[] = [];
    const context: DiscoveryContext = {
      directories,
      manifests,
      rootName: basename(root),
      read: async (path) => {
        try {
          return await readFile(join(root, path), 'utf8');
        } catch (failure) {
          if (
            typeof failure === 'object' &&
            failure !== null &&
            'code' in failure &&
            failure.code === 'ENOENT'
          ) {
            return undefined;
          }
          throw failure;
        }
      },
      expand: (patterns, base = '') => expandGlobs(directories, patterns, base, caseInsensitive),
      report: (diagnostic) => diagnostics.push(diagnostic),
    };

    const configured = config.packages.map(toWorkspacePackage);
    for (const pkg of configured) {
      if (pkg.root !== '' && !directories.has(pkg.root)) {
        diagnostics.push({
          adapter: 'configured',
          path: pkg.root,
          error: toCodeLensError(
            new WorkspaceConfigError(
              '.code-lens/workspace.json',
              `packages[${pkg.name}].root`,
              `"${pkg.root}" is not a directory in the workspace`,
            ),
            'validate configured package',
          ),
        });
      }
    }
    const packages = await discoverPackages(context, config.discover ? adapters : [], configured);
    return new Workspace({
      root,
      config,
      caseInsensitive,
      packages,
      diagnostics,
      survey: traversal.report,
    });
  }

  packages(): readonly WorkspacePackage[] {
    return this.#packages;
  }

  /** Packages with this name. Usually one; more when two manifests reuse a name. */
  packageByName(name: string): readonly WorkspacePackage[] {
    return this.#byName.get(name) ?? [];
  }

  /** The package a file belongs to: the one with the deepest root above it. */
  packageOf(path: string): WorkspacePackage | undefined {
    for (let dir = dirnameOf(path); ; dir = dirnameOf(dir)) {
      const found = this.#byRoot.get(dir);
      if (found) return found;
      if (dir === '') return undefined;
    }
  }

  /** The workspace packages `name` declares a dependency on. */
  dependenciesOf(
    name: string,
    options: { readonly transitive?: boolean } = {},
  ): readonly WorkspacePackage[] {
    return this.#closure(
      this.packageByName(name),
      (pkg) => this.#named(pkg.dependsOn),
      options.transitive === true,
    );
  }

  /** The workspace packages that declare a dependency on `name`. */
  dependentsOf(
    name: string,
    options: { readonly transitive?: boolean } = {},
  ): readonly WorkspacePackage[] {
    const dependents = new Map<string, WorkspacePackage[]>();
    for (const pkg of this.#packages) {
      for (const dep of pkg.dependsOn) dependents.set(dep, [...(dependents.get(dep) ?? []), pkg]);
    }
    return this.#closure(
      this.packageByName(name),
      (pkg) => dependents.get(pkg.name) ?? [],
      options.transitive === true,
    );
  }

  /** A predicate over workspace-relative paths for a scope. Unknown packages are an error. */
  scope(spec: ScopeSpec = {}): (path: string) => boolean {
    const wantsPackages = (spec.packages?.length ?? 0) > 0;
    const wantsPaths = (spec.paths?.length ?? 0) > 0;
    if (!wantsPackages && !wantsPaths) return () => true;

    const roots = new Set<string>();
    if (wantsPackages) {
      const named = (spec.packages ?? []).flatMap((ref) => {
        const found = this.#byRoot.get(ref) ?? undefined;
        const byName = this.packageByName(ref);
        const matched = found ? [found, ...byName] : [...byName];
        if (matched.length === 0) {
          throw new UnknownPackageError(
            ref,
            this.#packages.map((pkg) => pkg.name),
          );
        }
        return matched;
      });
      const all = new Map(named.map((pkg) => [pkg.root, pkg]));
      if (spec.withDependencies) {
        for (const pkg of named)
          for (const dep of this.dependenciesOf(pkg.name, { transitive: true }))
            all.set(dep.root, dep);
      }
      if (spec.withDependents) {
        for (const pkg of named)
          for (const dep of this.dependentsOf(pkg.name, { transitive: true }))
            all.set(dep.root, dep);
      }
      for (const pkg of all.values()) roots.add(pkg.root);
    }
    const prefixes = (spec.paths ?? []).map((p) =>
      p
        .replaceAll('\\', '/')
        .replace(/^\.?\//, '')
        .replace(/\/$/, ''),
    );

    return (path) => {
      if (
        wantsPaths &&
        prefixes.some((prefix) => prefix === '' || path === prefix || path.startsWith(`${prefix}/`))
      ) {
        return true;
      }
      if (!wantsPackages) return false;
      const owner = this.packageOf(path);
      return owner !== undefined && roots.has(owner.root);
    };
  }

  /** The options a walk of this workspace should use, so it agrees with the survey. */
  traverseOptions(deadline?: Deadline): TraverseOptions {
    return {
      root: this.root,
      caseInsensitive: this.caseInsensitive,
      configExclude: this.config.exclude,
      nestedRepos: this.config.nestedRepos,
      followSymlinks: this.config.followSymlinks,
      ...(deadline ? { deadline } : {}),
    };
  }

  #named(names: readonly string[]): WorkspacePackage[] {
    return names.flatMap((name) => this.#byName.get(name) ?? []);
  }

  #closure(
    start: readonly WorkspacePackage[],
    next: (pkg: WorkspacePackage) => readonly WorkspacePackage[],
    transitive: boolean,
  ): readonly WorkspacePackage[] {
    const seen = new Map<string, WorkspacePackage>();
    const startRoots = new Set(start.map((pkg) => pkg.root));
    const queue = [...start];
    while (queue.length > 0) {
      const current = queue.shift() as WorkspacePackage;
      for (const found of next(current)) {
        if (seen.has(found.root) || startRoots.has(found.root)) continue;
        seen.set(found.root, found);
        if (transitive) queue.push(found);
      }
    }
    return [...seen.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  }
}

function selectAdapters(
  all: readonly PackageDiscoverer[],
  config: WorkspaceConfig,
): readonly PackageDiscoverer[] {
  if (config.adapters === undefined) return all;
  return config.adapters.map((name, index) => {
    const found = all.find((adapter) => adapter.name === name);
    if (!found) {
      throw new WorkspaceConfigError(
        '.code-lens/workspace.json',
        `adapters[${index}]`,
        `unknown adapter "${name}" (available: ${all.map((adapter) => adapter.name).join(', ')})`,
      );
    }
    return found;
  });
}
