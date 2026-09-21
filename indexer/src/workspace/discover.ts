import { type CodeLensError, toCodeLensError } from '@sutras/code-lens-core';
import { globToRegExp } from './ignore.ts';
import {
  bazelDependencies,
  gradleProjectReferences,
  isRecord,
  keysOf,
  parseGoMod,
  parseGoWork,
  parseGradleIncludes,
  parseGradleRootName,
  parseJson,
  parsePom,
  parseToml,
  requirementName,
  stringList,
  yamlStringList,
} from './manifests.ts';

export type PackageKind =
  | 'configured'
  | 'npm'
  | 'cargo'
  | 'go'
  | 'python'
  | 'maven'
  | 'gradle'
  | 'bazel'
  | 'generic';

/** A unit of code that has its own name and boundary inside the workspace. */
export interface WorkspacePackage {
  readonly name: string;
  /** Directory relative to the workspace root, `/`-separated. `''` is the root itself. */
  readonly root: string;
  readonly kind: PackageKind;
  /** The manifest that defines it, when there is one. */
  readonly manifest: string | undefined;
  readonly version?: string;
  /** Names it depends on, exactly as its manifest writes them. Not all are workspace packages. */
  readonly dependsOn: readonly string[];
}

/** Something discovery could not make sense of. Discovery records it and carries on. */
export interface Diagnostic {
  readonly adapter: string;
  readonly path: string;
  readonly error: CodeLensError;
}

/** What an adapter is given: a survey of the tree, and nothing else. */
export interface DiscoveryContext {
  /** Every directory that survived ignoring, relative to the root. `''` is the root. */
  readonly directories: ReadonlySet<string>;
  /** Manifest file name -> the paths (relative to the root) where it was found, sorted. */
  readonly manifests: ReadonlyMap<string, readonly string[]>;
  /** Name to give a package at the root that does not name itself. */
  readonly rootName: string;
  /** The text of a file, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Directories matching workspace-style globs (`packages/*`, `!packages/legacy`) under `base`. */
  expand(patterns: readonly string[], base?: string): readonly string[];
  report(diagnostic: Diagnostic): void;
}

export interface PackageDiscoverer {
  readonly name: string;
  /** File names the survey should collect for this adapter. */
  readonly manifestNames: readonly string[];
  discover(context: DiscoveryContext): Promise<readonly WorkspacePackage[]>;
}

// --- path helpers -------------------------------------------------------------------------------

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `rel` resolved against `base`, or `undefined` when it would leave the workspace. */
export function resolveWithin(base: string, rel: string): string | undefined {
  const parts = base === '' ? [] : base.split('/');
  for (const part of rel.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** Expand workspace globs against known directories. A leading `!` excludes. */
export function expandGlobs(
  directories: ReadonlySet<string>,
  patterns: readonly string[],
  base: string,
  caseInsensitive = false,
): string[] {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const resolved = resolveWithin(base, negated ? pattern.slice(1) : pattern);
    if (resolved === undefined) continue;
    (negated ? exclude : include).push(globToRegExp(resolved.replace(/\/$/, ''), caseInsensitive));
  }
  return [...directories]
    .filter((dir) => dir !== '' || base === '')
    .filter((dir) => include.some((re) => re.test(dir)) && !exclude.some((re) => re.test(dir)))
    .sort();
}

/** Read and parse a manifest, turning any failure into a diagnostic and `undefined`. */
async function attempt<T>(
  context: DiscoveryContext,
  adapter: string,
  path: string,
  work: (text: string) => T | Promise<T>,
): Promise<T | undefined> {
  let text: string | undefined;
  try {
    text = await context.read(path);
    if (text === undefined) return undefined;
    return await work(text);
  } catch (failure) {
    context.report({ adapter, path, error: toCodeLensError(failure, `read ${path}`, { adapter }) });
    return undefined;
  }
}

const nameOrDirectory = (name: unknown, directory: string, context: DiscoveryContext) =>
  typeof name === 'string' && name !== ''
    ? name
    : directory === ''
      ? context.rootName
      : basenameOf(directory);

// --- npm / pnpm / yarn / lerna / nx --------------------------------------------------------------

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

export const npmAdapter: PackageDiscoverer = {
  name: 'npm',
  manifestNames: ['package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'project.json'],
  async discover(context) {
    const found = new Map<string, WorkspacePackage>();
    const memberPatterns: string[] = [];

    const rootManifest = await attempt(context, 'npm', 'package.json', (t) =>
      parseJson(t, 'package.json'),
    );
    if (isRecord(rootManifest)) {
      const workspaces = rootManifest.workspaces;
      memberPatterns.push(
        ...(Array.isArray(workspaces)
          ? stringList(workspaces)
          : isRecord(workspaces)
            ? stringList(workspaces.packages)
            : []),
      );
    }
    const pnpm = await attempt(context, 'npm', 'pnpm-workspace.yaml', (t) =>
      yamlStringList(t, 'packages'),
    );
    memberPatterns.push(...(pnpm ?? []));
    const lerna = await attempt(context, 'npm', 'lerna.json', (t) => parseJson(t, 'lerna.json'));
    if (isRecord(lerna)) {
      const listed = stringList(lerna.packages);
      memberPatterns.push(...(listed.length > 0 ? listed : ['packages/*']));
    }

    // With no workspace declared anywhere, every package.json is an independent project. Once a
    // workspace is declared, only its members are npm packages and the rest stay generic.
    const declared =
      memberPatterns.length > 0 || (context.manifests.get('nx.json') ?? []).length > 0;
    const memberRoots = new Set(
      declared
        ? context.expand(memberPatterns)
        : (context.manifests.get('package.json') ?? []).map(dirnameOf),
    );
    // Nx projects can be plain directories with a project.json and no package.json.
    if ((context.manifests.get('nx.json') ?? []).length > 0) {
      for (const path of context.manifests.get('project.json') ?? [])
        memberRoots.add(dirnameOf(path));
    }
    if (isRecord(rootManifest)) memberRoots.add('');

    for (const root of [...memberRoots].sort()) {
      const manifestPath = root === '' ? 'package.json' : `${root}/package.json`;
      const manifest =
        root === ''
          ? rootManifest
          : await attempt(context, 'npm', manifestPath, (t) => parseJson(t, manifestPath));
      if (isRecord(manifest)) {
        found.set(root, {
          name: nameOrDirectory(manifest.name, root, context),
          root,
          kind: 'npm',
          manifest: manifestPath,
          ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
          dependsOn: [...new Set(DEPENDENCY_FIELDS.flatMap((field) => keysOf(manifest[field])))],
        });
        continue;
      }
      const projectPath = root === '' ? 'project.json' : `${root}/project.json`;
      const project = await attempt(context, 'npm', projectPath, (t) => parseJson(t, projectPath));
      if (isRecord(project)) {
        found.set(root, {
          name: nameOrDirectory(project.name, root, context),
          root,
          kind: 'npm',
          manifest: projectPath,
          dependsOn: stringList(project.implicitDependencies),
        });
      }
    }
    return [...found.values()];
  },
};

// --- Cargo ---------------------------------------------------------------------------------------

export const cargoAdapter: PackageDiscoverer = {
  name: 'cargo',
  manifestNames: ['Cargo.toml'],
  async discover(context) {
    const out: WorkspacePackage[] = [];
    for (const path of context.manifests.get('Cargo.toml') ?? []) {
      const toml = await attempt(context, 'cargo', path, (t) => parseToml(t, path));
      if (!toml || !isRecord(toml.package)) continue; // a workspace-only manifest is not a crate
      const root = dirnameOf(path);
      const names = ['dependencies', 'dev-dependencies', 'build-dependencies'].flatMap((table) => {
        const entries = toml[table];
        if (!isRecord(entries)) return [];
        return Object.entries(entries).map(([key, value]) =>
          isRecord(value) && typeof value.package === 'string' ? value.package : key,
        );
      });
      out.push({
        name: nameOrDirectory(toml.package.name, root, context),
        root,
        kind: 'cargo',
        manifest: path,
        ...(typeof toml.package.version === 'string' ? { version: toml.package.version } : {}),
        dependsOn: [...new Set(names)],
      });
    }
    return out;
  },
};

// --- Go -----------------------------------------------------------------------------------------

export const goAdapter: PackageDiscoverer = {
  name: 'go',
  manifestNames: ['go.mod', 'go.work'],
  async discover(context) {
    const out: WorkspacePackage[] = [];
    const wanted = new Set(context.manifests.get('go.mod') ?? []);
    // A go.work lists module directories; include them even if their go.mod sits somewhere unusual.
    for (const path of context.manifests.get('go.work') ?? []) {
      const uses = await attempt(context, 'go', path, (t) => parseGoWork(t));
      for (const dir of uses ?? []) {
        const resolved = resolveWithin(dirnameOf(path), dir);
        if (resolved !== undefined) wanted.add(resolved === '' ? 'go.mod' : `${resolved}/go.mod`);
      }
    }
    for (const path of [...wanted].sort()) {
      const mod = await attempt(context, 'go', path, (t) => parseGoMod(t));
      if (!mod?.module) continue;
      out.push({
        name: mod.module,
        root: dirnameOf(path),
        kind: 'go',
        manifest: path,
        dependsOn: [...new Set(mod.requires)],
      });
    }
    return out;
  },
};

// --- Python -------------------------------------------------------------------------------------

export const pythonAdapter: PackageDiscoverer = {
  name: 'python',
  manifestNames: ['pyproject.toml'],
  async discover(context) {
    const out: WorkspacePackage[] = [];
    for (const path of context.manifests.get('pyproject.toml') ?? []) {
      const toml = await attempt(context, 'python', path, (t) => parseToml(t, path));
      if (!toml) continue;
      const project = isRecord(toml.project) ? toml.project : undefined;
      const tool = isRecord(toml.tool) ? toml.tool : undefined;
      const poetry = tool && isRecord(tool.poetry) ? tool.poetry : undefined;
      const uv = tool && isRecord(tool.uv) ? tool.uv : undefined;
      const name = project?.name ?? poetry?.name;
      if (typeof name !== 'string') continue;
      const optional =
        project && isRecord(project['optional-dependencies'])
          ? Object.values(project['optional-dependencies'])
          : [];
      const requirements = [
        ...stringList(project?.dependencies),
        ...optional.flatMap((list) => stringList(list)),
      ]
        .map(requirementName)
        .filter((n): n is string => n !== undefined);
      const poetryDeps = keysOf(poetry?.dependencies).filter((n) => n !== 'python');
      const uvSources = uv ? keysOf(uv.sources) : [];
      out.push({
        name,
        root: dirnameOf(path),
        kind: 'python',
        manifest: path,
        ...(typeof (project?.version ?? poetry?.version) === 'string'
          ? { version: (project?.version ?? poetry?.version) as string }
          : {}),
        dependsOn: [...new Set([...requirements, ...poetryDeps, ...uvSources])],
      });
    }
    return out;
  },
};

// --- Maven --------------------------------------------------------------------------------------

export const mavenAdapter: PackageDiscoverer = {
  name: 'maven',
  manifestNames: ['pom.xml'],
  async discover(context) {
    const out: WorkspacePackage[] = [];
    for (const path of context.manifests.get('pom.xml') ?? []) {
      const pom = await attempt(context, 'maven', path, (t) => parsePom(t));
      if (!pom?.artifactId) continue;
      out.push({
        name: pom.artifactId,
        root: dirnameOf(path),
        kind: 'maven',
        manifest: path,
        dependsOn: [...new Set(pom.dependencies)],
      });
    }
    return out;
  },
};

// --- Gradle -------------------------------------------------------------------------------------

const GRADLE_SETTINGS = ['settings.gradle', 'settings.gradle.kts'];
const GRADLE_BUILDS = ['build.gradle', 'build.gradle.kts'];

export const gradleAdapter: PackageDiscoverer = {
  name: 'gradle',
  manifestNames: [...GRADLE_SETTINGS, ...GRADLE_BUILDS],
  async discover(context) {
    const out: WorkspacePackage[] = [];
    for (const settingsName of GRADLE_SETTINGS) {
      for (const settingsPath of context.manifests.get(settingsName) ?? []) {
        const base = dirnameOf(settingsPath);
        const parsed = await attempt(context, 'gradle', settingsPath, (t) => ({
          includes: parseGradleIncludes(t),
          rootName: parseGradleRootName(t),
        }));
        if (!parsed) continue;
        const projectName = (includePath: string) => includePath.replaceAll('/', ':');
        const roots = [
          {
            include: '',
            root: base,
            name: parsed.rootName ?? nameOrDirectory(undefined, base, context),
          },
        ];
        for (const include of parsed.includes) {
          const root = resolveWithin(base, include);
          if (root !== undefined && context.directories.has(root)) {
            roots.push({ include, root, name: projectName(include) });
          }
        }
        for (const project of roots) {
          const found = GRADLE_BUILDS.map((build) =>
            project.root === '' ? build : `${project.root}/${build}`,
          ).find((candidate) => context.manifests.get(basenameOf(candidate))?.includes(candidate));
          const refs = found
            ? ((await attempt(context, 'gradle', found, (t) => gradleProjectReferences(t))) ?? [])
            : [];
          out.push({
            name: project.name,
            root: project.root,
            kind: 'gradle',
            manifest: found ?? settingsPath,
            dependsOn: refs.map(projectName),
          });
        }
      }
    }
    return out;
  },
};

// --- Bazel --------------------------------------------------------------------------------------

const BAZEL_MARKERS = ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'];
const BAZEL_BUILDS = ['BUILD', 'BUILD.bazel'];

export const bazelAdapter: PackageDiscoverer = {
  name: 'bazel',
  manifestNames: [...BAZEL_MARKERS, ...BAZEL_BUILDS],
  async discover(context) {
    const isBazel = BAZEL_MARKERS.some(
      (marker) => (context.manifests.get(marker) ?? []).length > 0,
    );
    if (!isBazel) return [];
    const out: WorkspacePackage[] = [];
    const seen = new Set<string>();
    for (const build of BAZEL_BUILDS) {
      for (const path of context.manifests.get(build) ?? []) {
        const root = dirnameOf(path);
        if (seen.has(root)) continue;
        seen.add(root);
        const deps = (await attempt(context, 'bazel', path, (t) => bazelDependencies(t))) ?? [];
        const label = `//${root}`;
        out.push({
          name: label,
          root,
          kind: 'bazel',
          manifest: path,
          dependsOn: deps.filter((dep) => dep !== label),
        });
      }
    }
    return out;
  },
};

// --- anything else with a manifest ---------------------------------------------------------------

const GENERIC_MANIFESTS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
];

/**
 * A directory with a manifest no other adapter claimed is still a package: this is what makes an
 * unusual layout, or a language nobody wrote an adapter for, work at all.
 */
export const genericAdapter: PackageDiscoverer = {
  name: 'generic',
  manifestNames: GENERIC_MANIFESTS,
  async discover(context) {
    const first = new Map<string, string>();
    for (const name of GENERIC_MANIFESTS) {
      for (const path of context.manifests.get(name) ?? []) {
        const root = dirnameOf(path);
        if (!first.has(root)) first.set(root, path);
      }
    }
    const out: WorkspacePackage[] = [];
    for (const [root, manifest] of [...first].sort()) {
      let name: unknown;
      if (manifest.endsWith('.json')) {
        const json = await attempt(context, 'generic', manifest, (t) => parseJson(t, manifest));
        name = isRecord(json) ? json.name : undefined;
      }
      out.push({
        name: nameOrDirectory(name, root, context),
        root,
        kind: 'generic',
        manifest,
        dependsOn: [],
      });
    }
    return out;
  },
};

/** The adapters in the order they are tried. A package found by an earlier one wins. */
export function defaultAdapters(): readonly PackageDiscoverer[] {
  return [
    npmAdapter,
    cargoAdapter,
    goAdapter,
    pythonAdapter,
    mavenAdapter,
    gradleAdapter,
    bazelAdapter,
    genericAdapter,
  ];
}

/**
 * Run adapters and merge what they find. Explicitly configured packages come first, then each
 * adapter in order; when two claim the same directory the first one keeps it.
 */
export async function discoverPackages(
  context: DiscoveryContext,
  adapters: readonly PackageDiscoverer[],
  configured: readonly WorkspacePackage[] = [],
): Promise<readonly WorkspacePackage[]> {
  const byRoot = new Map<string, WorkspacePackage>();
  for (const pkg of configured) if (!byRoot.has(pkg.root)) byRoot.set(pkg.root, pkg);
  for (const adapter of adapters) {
    let found: readonly WorkspacePackage[];
    try {
      found = await adapter.discover(context);
    } catch (failure) {
      context.report({
        adapter: adapter.name,
        path: '',
        error: toCodeLensError(failure, `discover ${adapter.name} packages`),
      });
      continue;
    }
    for (const pkg of found) if (!byRoot.has(pkg.root)) byRoot.set(pkg.root, pkg);
  }
  return [...byRoot.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}
