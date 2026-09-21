import { ManifestInvalidError } from '../errors.ts';

/**
 * Readers for the package manifests of each ecosystem. They pull out only what the workspace
 * model needs (a name, member lists, dependency names), and they fail with a typed error naming
 * the file, so one broken manifest is a diagnostic and not a crash.
 */

export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (failure) {
    throw new ManifestInvalidError(path, 'JSON', 'the file is not valid JSON', { cause: failure });
  }
}

export function parseToml(text: string, path: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (failure) {
    throw new ManifestInvalidError(path, 'TOML', 'the file is not valid TOML', { cause: failure });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The keys of an object that maps names to something, e.g. a `dependencies` table. */
export function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

// --- YAML (just enough for pnpm-workspace.yaml) --------------------------------------------------

/**
 * The string entries of a top-level list key, in block (`- item`) or flow (`[a, b]`) style. A full
 * YAML parser is more than is needed to read a workspace member list.
 */
export function yamlStringList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^${escapeRegex(key)}\\s*:\\s*(.*?)\\s*(?:#.*)?$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index] as string);
    if (!match) continue;
    const inline = (match[1] as string).trim();
    if (inline.startsWith('[')) return flowList(inline);
    const items: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] as string;
      if (/^\s*(#.*)?$/.test(line)) continue;
      const item = /^\s*-\s+(.*?)\s*(?:#.*)?$/.exec(line);
      if (!item) break;
      items.push(unquote(item[1] as string));
    }
    return items;
  }
  return [];
}

function flowList(inline: string): string[] {
  const close = inline.lastIndexOf(']');
  const body = inline.slice(1, close === -1 ? undefined : close);
  return body
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part.length > 0);
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] as string) : value;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Go -----------------------------------------------------------------------------------------

/** Directories named by `use` in a `go.work` file, single-line or in a block. */
export function parseGoWork(text: string): string[] {
  return goDirectiveArguments(text, 'use');
}

export interface GoMod {
  readonly module: string | undefined;
  readonly requires: readonly string[];
  /** Local directories a `replace` points at, which link modules to each other. */
  readonly replacedWithPaths: readonly string[];
}

export function parseGoMod(text: string): GoMod {
  const module = /^\s*module\s+("?)([^\s"]+)\1/m.exec(stripGoComments(text))?.[2];
  const requires = goDirectiveArguments(text, 'require').map(
    (entry) => entry.split(/\s+/)[0] as string,
  );
  const replaced = goDirectiveArguments(text, 'replace')
    .map((entry) => /=>\s*(\S+)/.exec(entry)?.[1])
    .filter(
      (target): target is string =>
        target?.startsWith('.') === true || target?.startsWith('/') === true,
    );
  return { module, requires, replacedWithPaths: replaced };
}

/** The lines of every `directive x` and `directive ( ... )` in a Go module file. */
function goDirectiveArguments(text: string, directive: string): string[] {
  const out: string[] = [];
  const lines = stripGoComments(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    const single = new RegExp(`^${directive}\\s+(?!\\()(.+)$`).exec(line);
    if (single) {
      out.push(unquote((single[1] as string).trim()));
      continue;
    }
    if (new RegExp(`^${directive}\\s*\\($`).test(line)) {
      for (index += 1; index < lines.length; index += 1) {
        const inner = (lines[index] as string).trim();
        if (inner === ')') break;
        if (inner !== '') out.push(unquote(inner));
      }
    }
  }
  return out;
}

function stripGoComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '');
}

// --- Maven --------------------------------------------------------------------------------------

export interface Pom {
  readonly artifactId: string | undefined;
  readonly modules: readonly string[];
  readonly dependencies: readonly string[];
}

/** The parts of a `pom.xml` the workspace model uses. Regular expressions are enough for these. */
export function parsePom(text: string): Pom {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const ownScope = withoutComments
    .replace(/<parent>[\s\S]*?<\/parent>/g, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '');
  const artifactId = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(ownScope)?.[1];
  const modules = [...withoutComments.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map(
    (m) => m[1] as string,
  );
  const dependencies = [
    ...withoutComments
      .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
      .matchAll(
        /<dependency>[\s\S]*?<artifactId>\s*([^<\s]+)\s*<\/artifactId>[\s\S]*?<\/dependency>/g,
      ),
  ].map((m) => m[1] as string);
  return { artifactId, modules, dependencies };
}

// --- Gradle -------------------------------------------------------------------------------------

/** Project paths named by `include` in a `settings.gradle(.kts)`, as `:a:b` normalised to `a/b`. */
export function parseGradleIncludes(text: string): string[] {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const paths: string[] = [];
  for (const match of withoutComments.matchAll(
    /\binclude\s*\(?((?:\s*['"][^'"]+['"]\s*,?)+)\s*\)?/g,
  )) {
    for (const quoted of (match[1] as string).matchAll(/['"]([^'"]+)['"]/g)) {
      paths.push((quoted[1] as string).replace(/^:/, '').replaceAll(':', '/'));
    }
  }
  return paths;
}

export function parseGradleRootName(text: string): string | undefined {
  return /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1];
}

/** Other projects a `build.gradle(.kts)` depends on, as their include paths. */
export function gradleProjectReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/project\(\s*(?:path\s*[:=]\s*)?['"]([^'"]+)['"]/g)) {
    refs.add((match[1] as string).replace(/^:/, '').replaceAll(':', '/'));
  }
  return [...refs];
}

// --- Bazel --------------------------------------------------------------------------------------

/** Packages named in the labels of a `BUILD` file, e.g. `//services/api:server` -> `//services/api`. */
export function bazelDependencies(text: string): string[] {
  const packages = new Set<string>();
  for (const match of text.matchAll(/["'](\/\/[^"':]*)(?::[^"']*)?["']/g)) {
    packages.add(match[1] as string);
  }
  return [...packages];
}

// --- Python -------------------------------------------------------------------------------------

/** The distribution name at the start of a PEP 508 requirement such as `requests>=2; python_version>"3"`. */
export function requirementName(requirement: string): string | undefined {
  return /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1];
}
