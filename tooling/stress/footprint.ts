/**
 * What a checked-out repository is, measured: how much source in which languages, how it is laid
 * out, and whether assistants have left marks in it. These are the numbers the manifest's
 * declared factors are checked against, so a stale claim shows up instead of silently steering runs.
 */
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { AGENT_MARKERS, trackedFiles } from './git.ts';
import type { Complexity, Structure } from './manifest.ts';

const LANGUAGES: Readonly<Record<string, string>> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.rb': 'ruby',
  '.cs': 'csharp',
  '.php': 'php',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.kt': 'other',
  '.swift': 'other',
  '.scala': 'other',
  '.ex': 'other',
  '.exs': 'other',
  '.hs': 'other',
  '.lua': 'other',
  '.dart': 'other',
  '.zig': 'other',
  '.clj': 'other',
  '.erl': 'other',
  '.ml': 'other',
  '.m': 'other',
  '.mm': 'other',
};

const PACKAGE_MANIFESTS = new Set([
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'pyproject.toml',
  'composer.json',
  'Gemfile',
]);
const WORKSPACE_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'go.work'];

export interface Footprint {
  readonly files: number;
  readonly sourceFiles: number;
  readonly sourceBytes: number;
  readonly sourceLines: number;
  readonly byLanguage: Readonly<Record<string, { readonly files: number; readonly bytes: number }>>;
  /** Package manifests below the root: how many separate packages there are. */
  readonly packages: number;
  readonly workspaceMarkers: readonly string[];
  readonly agentMarkers: readonly string[];
  readonly structure: Structure;
  readonly complexity: Complexity;
}

/** A polyglot repository has at least this many languages that each hold at least this share. */
const POLYGLOT_LANGUAGES = 3;
const POLYGLOT_SHARE = 0.1;
/** Below a repository with this many separate packages, it is a single project with a few helpers. */
const MONOREPO_PACKAGES = 3;

export function complexityOf(sourceFiles: number): Complexity {
  if (sourceFiles < 300) return 'small';
  if (sourceFiles < 3_000) return 'medium';
  if (sourceFiles < 20_000) return 'large';
  return 'huge';
}

export function structureOf(input: {
  readonly packages: number;
  readonly workspaceMarkers: readonly string[];
  readonly byLanguage: Footprint['byLanguage'];
}): Structure {
  if (input.workspaceMarkers.length > 0 || input.packages >= MONOREPO_PACKAGES) return 'monorepo';
  const total = Object.entries(input.byLanguage)
    .filter(([language]) => language !== 'other')
    .reduce((sum, [, { bytes }]) => sum + bytes, 0);
  const major = Object.entries(input.byLanguage).filter(
    ([language, { bytes }]) => language !== 'other' && total > 0 && bytes / total >= POLYGLOT_SHARE,
  );
  if (major.length >= POLYGLOT_LANGUAGES) return 'polyglot';
  return input.packages > 0 ? 'nested' : 'single';
}

/** Count what is in the checked-out tree. `scope` limits it to one folder, as an index would be. */
export async function measureFootprint(directory: string, scope?: string): Promise<Footprint> {
  const prefix = scope === undefined ? '' : `${scope.replace(/\/+$/, '')}/`;
  const all = (await trackedFiles(directory)).filter((path) => path.startsWith(prefix));
  const byLanguage: Record<string, { files: number; bytes: number }> = {};
  let sourceBytes = 0;
  let sourceLines = 0;
  let sourceFiles = 0;
  let packages = 0;
  const workspaceMarkers: string[] = [];
  const agentMarkers: string[] = [];

  const source: { path: string; language: string }[] = [];
  for (const path of all) {
    const relative = path.slice(prefix.length);
    const name = basename(path);
    if (AGENT_MARKERS.test(path)) agentMarkers.push(path);
    if (PACKAGE_MANIFESTS.has(name) && relative.includes('/')) packages += 1;
    if (!relative.includes('/') && WORKSPACE_FILES.includes(name)) workspaceMarkers.push(name);
    if (!relative.includes('/') && name === 'package.json') {
      const workspaces = workspacesOf(join(directory, path));
      if (workspaces) workspaceMarkers.push('package.json#workspaces');
    }
    const language = LANGUAGES[extname(name).toLowerCase()];
    if (language !== undefined) source.push({ path, language });
  }

  // Read in groups so a large repository does not open every file at once.
  const GROUP = 64;
  for (let start = 0; start < source.length; start += GROUP) {
    const group = source.slice(start, start + GROUP);
    const texts = await Promise.all(
      group.map(({ path }) => Bun.file(join(directory, path)).text()),
    );
    group.forEach(({ language }, index) => {
      const text = texts[index] as string;
      const bytes = Buffer.byteLength(text);
      const entry = byLanguage[language] ?? { files: 0, bytes: 0 };
      byLanguage[language] = { files: entry.files + 1, bytes: entry.bytes + bytes };
      sourceBytes += bytes;
      sourceFiles += 1;
      sourceLines += text === '' ? 0 : text.split('\n').length;
    });
  }

  return {
    files: all.length,
    sourceFiles,
    sourceBytes,
    sourceLines,
    byLanguage,
    packages,
    workspaceMarkers,
    agentMarkers,
    structure: structureOf({ packages, workspaceMarkers, byLanguage }),
    complexity: complexityOf(sourceFiles),
  };
}

/** Does this `package.json` declare workspaces? A file that is not JSON says nothing either way. */
function workspacesOf(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { workspaces?: unknown };
    return parsed.workspaces !== undefined;
  } catch {
    // A package.json that does not parse is measured as having no workspaces; the run's own
    // indexing reports the file if it matters.
    return false;
  }
}
