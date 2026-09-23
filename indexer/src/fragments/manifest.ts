import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FragmentManifestError } from '../errors.ts';

/** Where a project keeps the manifest that says which fragment each file belongs to. */
export const FRAGMENTS_PATH = join('.anvesa', 'fragments.json');

const MANIFEST_VERSION = 1;
const FRAGMENT_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** What belongs to one fragment: a folder tree, named files, or both. */
export interface FragmentSpec {
  /** For a person to read; never used to decide anything. */
  readonly label?: string;
  /** Folders (`/`-separated, relative to the workspace root) whose whole subtree belongs here. */
  readonly roots?: readonly string[];
  /** Files that belong here whatever folder they are in. */
  readonly files?: readonly string[];
}

/**
 * The committed answer to "which fragment is this file in". It is data, not a computation: the
 * same manifest gives every machine the same fragments, and a change to it is a change a
 * reviewer can read. Nothing about a machine (its clock, its file order, an inference run) decides
 * where a file goes.
 */
export interface FragmentManifest {
  readonly manifestVersion: 1;
  /** What produced the assignments, so a regenerated manifest can be told from an edited one. */
  readonly algorithm: { readonly id: string; readonly version: number };
  /** Where a file goes when nothing else says. */
  readonly fallback: string;
  readonly fragments: Readonly<Record<string, FragmentSpec>>;
  /** A file to a fragment, above everything else. For a person's exceptions. */
  readonly overrides?: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A folder or file path as the manifest keeps it: `/`-separated, no leading `./`, no trailing `/`. */
export function normalizeEntry(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Check untrusted JSON and return a manifest, naming the field of the first problem. */
export function validateManifest(raw: unknown, source = 'fragments manifest'): FragmentManifest {
  const bad = (location: string, problem: string): never => {
    throw new FragmentManifestError(source, location, problem);
  };
  if (!isRecord(raw)) return bad('(root)', 'expected an object');
  if (raw.manifestVersion !== MANIFEST_VERSION) {
    bad(
      'manifestVersion',
      `expected ${MANIFEST_VERSION}, found ${JSON.stringify(raw.manifestVersion)}`,
    );
  }
  const algorithm = raw.algorithm;
  if (
    !isRecord(algorithm) ||
    typeof algorithm.id !== 'string' ||
    !Number.isInteger(algorithm.version)
  ) {
    bad('algorithm', 'expected { id: string, version: integer }');
  }
  if (typeof raw.fallback !== 'string') bad('fallback', 'expected the id of a fragment');
  if (!isRecord(raw.fragments)) return bad('fragments', 'expected an object of fragments');

  const fragments: Record<string, FragmentSpec> = {};
  const owner = new Map<string, string>();
  const claim = (kind: 'root' | 'file', path: string, id: string, location: string) => {
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
      bad(location, `"${path}" must be a relative path inside the workspace`);
    }
    if (path !== normalizeEntry(path))
      bad(location, `"${path}" is not normalised (use "${normalizeEntry(path)}")`);
    const key = `${kind}:${path}`;
    const previous = owner.get(key);
    if (previous !== undefined)
      bad(location, `${kind} "${path}" is already in fragment "${previous}"`);
    owner.set(key, id);
  };
  for (const [id, spec] of Object.entries(raw.fragments)) {
    if (!FRAGMENT_ID.test(id)) {
      bad(
        `fragments.${id}`,
        'an id is lowercase letters, digits, ".", "_" and "-", starting with a letter or digit',
      );
    }
    if (!isRecord(spec)) return bad(`fragments.${id}`, 'expected an object');
    const known = new Set(['label', 'roots', 'files']);
    for (const key of Object.keys(spec)) {
      if (!known.has(key)) bad(`fragments.${id}.${key}`, 'is not a known field');
    }
    for (const field of ['roots', 'files'] as const) {
      const list = spec[field];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
        bad(`fragments.${id}.${field}`, 'expected an array of strings');
      }
      for (const [index, entry] of (list as string[]).entries()) {
        claim(field === 'roots' ? 'root' : 'file', entry, id, `fragments.${id}.${field}[${index}]`);
      }
    }
    if (spec.label !== undefined && typeof spec.label !== 'string') {
      bad(`fragments.${id}.label`, 'expected a string');
    }
    fragments[id] = spec as FragmentSpec;
  }
  if (!((raw.fallback as string) in fragments)) {
    bad('fallback', `"${raw.fallback}" is not one of the fragments`);
  }

  let overrides: Record<string, string> | undefined;
  if (raw.overrides !== undefined) {
    if (!isRecord(raw.overrides))
      return bad('overrides', 'expected an object of file to fragment id');
    overrides = {};
    for (const [path, id] of Object.entries(raw.overrides)) {
      if (typeof id !== 'string' || !(id in fragments)) {
        bad(`overrides.${path}`, `"${String(id)}" is not one of the fragments`);
      }
      if (path !== normalizeEntry(path)) bad(`overrides.${path}`, 'the path is not normalised');
      overrides[path] = id as string;
    }
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    algorithm: {
      id: (algorithm as { id: string }).id,
      version: (algorithm as { version: number }).version,
    },
    fallback: raw.fallback as string,
    fragments,
    ...(overrides ? { overrides } : {}),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The manifest as it is written to disk: keys and lists in a fixed order, so regenerating an
 * unchanged manifest gives a byte-identical file and a real change shows up alone in a diff.
 */
export function manifestText(manifest: FragmentManifest): string {
  const ordered: Record<string, FragmentSpec> = {};
  for (const id of Object.keys(manifest.fragments).sort(compare)) {
    const spec = manifest.fragments[id] as FragmentSpec;
    ordered[id] = {
      ...(spec.label === undefined ? {} : { label: spec.label }),
      ...(spec.roots ? { roots: [...spec.roots].sort(compare) } : {}),
      ...(spec.files ? { files: [...spec.files].sort(compare) } : {}),
    };
  }
  const overrides = manifest.overrides
    ? Object.fromEntries(Object.entries(manifest.overrides).sort(([a], [b]) => compare(a, b)))
    : undefined;
  return `${JSON.stringify(
    {
      manifestVersion: manifest.manifestVersion,
      algorithm: manifest.algorithm,
      fallback: manifest.fallback,
      fragments: ordered,
      ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    },
    null,
    2,
  )}\n`;
}

/** The manifest of a project, or `undefined` when it has none. A file that is unusable is an error. */
export async function loadManifest(root: string): Promise<FragmentManifest | undefined> {
  const path = join(root, FRAGMENTS_PATH);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (failure) {
    throw new FragmentManifestError(path, '(root)', 'it is not valid JSON', { cause: failure });
  }
  return validateManifest(parsed, path);
}

export async function saveManifest(root: string, manifest: FragmentManifest): Promise<string> {
  const path = join(root, FRAGMENTS_PATH);
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(staging, manifestText(validateManifest(manifest)));
  await rename(staging, path);
  return path;
}

// --- assignment -------------------------------------------------------------------------------

interface RootNode {
  fragment: string | undefined;
  readonly children: Map<string, RootNode>;
}

/**
 * Which fragment a file is in. A pure function of the manifest and the path: an override wins,
 * then a file named by a fragment, then the fragment with the deepest folder that contains it,
 * then the fallback.
 */
export class FragmentAssigner {
  readonly manifest: FragmentManifest;
  readonly #overrides: ReadonlyMap<string, string>;
  readonly #files = new Map<string, string>();
  readonly #roots: RootNode = { fragment: undefined, children: new Map() };

  constructor(manifest: FragmentManifest) {
    this.manifest = manifest;
    this.#overrides = new Map(Object.entries(manifest.overrides ?? {}));
    for (const [id, spec] of Object.entries(manifest.fragments)) {
      for (const file of spec.files ?? []) this.#files.set(file, id);
      for (const root of spec.roots ?? []) {
        let node = this.#roots;
        for (const segment of root.split('/')) {
          let child = node.children.get(segment);
          if (!child) {
            child = { fragment: undefined, children: new Map() };
            node.children.set(segment, child);
          }
          node = child;
        }
        node.fragment = id;
      }
    }
  }

  ids(): readonly string[] {
    return Object.keys(this.manifest.fragments).sort(compare);
  }

  assign(path: string): string {
    const override = this.#overrides.get(path);
    if (override !== undefined) return override;
    const named = this.#files.get(path);
    if (named !== undefined) return named;
    let best = this.manifest.fallback;
    let node = this.#roots;
    const segments = path.split('/');
    // The last segment is the file name: a root names a folder, never a file.
    for (let index = 0; index < segments.length - 1; index += 1) {
      const child = node.children.get(segments[index] as string);
      if (!child) break;
      node = child;
      if (node.fragment !== undefined) best = node.fragment;
    }
    return best;
  }
}
