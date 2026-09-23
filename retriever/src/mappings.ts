import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type Deadline, InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  checkGolden,
  type Golden,
  type GoldenDifference,
  type MappingCheck,
  MappingStore,
  type StoredMapping,
  type TrainingReport,
  type TrainingSample,
  trainMapping,
} from '@cntxt-labs/anvesa-structural';
import { createRuntime, type GrammarHost } from './grammars.ts';

export interface MappingHost extends GrammarHost {}

/** The store of mappings for a project: its own, the user's, and the bundled ones beneath. */
export function mappingStoreFor(root: string, host: MappingHost = {}): MappingStore {
  return new MappingStore({ projectDir: root, ...(host.home ? { homeDir: host.home } : {}) });
}

/** What is in effect: each language's mapping, and whether it is bundled, the user's or the project's. */
export async function listMappings(
  root: string,
  host: MappingHost = {},
): Promise<readonly StoredMapping[]> {
  return mappingStoreFor(root, host).list();
}

/** Every stored mapping against its recorded checksum. */
export async function verifyMappings(
  root: string,
  host: MappingHost = {},
): Promise<readonly MappingCheck[]> {
  return mappingStoreFor(root, host).verify();
}

/**
 * Read the files under `paths` that belong to a language, all of them: there is no cap, so a
 * caller who points at a huge folder is choosing to read it. A path may be a file or a folder;
 * the names in the result are relative to `root` when they are under it.
 */
export async function gatherSamples(
  root: string,
  extensions: readonly string[],
  paths: readonly string[],
  options: { readonly deadline?: Deadline } = {},
): Promise<readonly TrainingSample[]> {
  const wanted = new Set(extensions.map((extension) => extension.toLowerCase()));
  const files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    options.deadline?.throwIfExpired(`look for samples in ${path}`);
    const info = await stat(path);
    if (info.isFile()) {
      files.push(path);
      return;
    }
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (
        entry.isFile() &&
        wanted.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())
      ) {
        files.push(child);
      }
    }
  };
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) {
      throw new InvalidArgumentError('--samples', 'a file or folder that exists', path);
    }
    await visit(absolute);
  }
  const samples: TrainingSample[] = [];
  for (const file of files) {
    const relativePath = relative(root, file);
    const name = relativePath.startsWith('..') || isAbsolute(relativePath) ? file : relativePath;
    samples.push({ path: name.replaceAll('\\', '/'), content: await readFile(file, 'utf8') });
  }
  return samples;
}

export interface TrainOptions {
  readonly language: string;
  /** Files and folders of code in that language to learn from. */
  readonly samples: readonly string[];
  /** Name of the mapping. Defaults to the language key. */
  readonly name?: string;
  /** Keep it for the user rather than the project. */
  readonly user?: boolean;
  /** Learn and report, and keep nothing. */
  readonly dryRun?: boolean;
  /** Keep it even if what was learned does not check out. */
  readonly force?: boolean;
  readonly minShare?: number;
  readonly deadline?: Deadline;
}

export interface TrainedResult {
  readonly report: TrainingReport;
  readonly samples: number;
  /** Set when the mapping was kept. */
  readonly stored: StoredMapping | undefined;
  /** Why it was not kept, when it was not. */
  readonly refused: string | undefined;
}

/**
 * Learn a mapping for a language from code, check it against that code, and keep it (with a golden
 * record of what it does to the samples) in the project or for the user. A mapping that does not
 * check out, or that finds no declarations, is reported and not kept unless `force` says to.
 */
export async function trainLanguage(
  root: string,
  options: TrainOptions,
  host: MappingHost = {},
): Promise<TrainedResult> {
  const runtime = await createRuntime(root, { npmFrom: import.meta.filename, ...host });
  try {
    const language = runtime.registry.require(options.language);
    const samples = await gatherSamples(root, language.extensions, options.samples, {
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });
    if (samples.length === 0) {
      throw new InvalidArgumentError(
        '--samples',
        `files with one of ${language.extensions.join(', ')}`,
        options.samples.join(', '),
      );
    }
    const report = await trainMapping(runtime, options.language, samples, {
      extensions: language.extensions,
      ...(options.name ? { name: options.name } : {}),
      ...(options.minShare === undefined ? {} : { minShare: options.minShare }),
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });

    const blocking = report.issues.filter(
      (issue) => issue.code === 'ROUND_TRIP' || issue.code === 'NO_DECLARATIONS',
    );
    let refused: string | undefined;
    if (options.dryRun) refused = 'this was a dry run';
    else if (blocking.length > 0 && !options.force) {
      refused = `${blocking.map((issue) => issue.message).join('; ')}. Use --force to keep it anyway`;
    }
    const stored =
      refused === undefined
        ? await mappingStoreFor(root, host).install(report.mapping, {
            tier: options.user ? 'user' : 'project',
            languages: [options.language],
            golden: report.golden,
            ...(options.force ? { force: true } : {}),
          })
        : undefined;
    return { report, samples: samples.length, stored, refused };
  } finally {
    await runtime.dispose();
  }
}

/** Re-run a stored mapping over the samples its golden record was made from, and say what differs. */
export async function checkMapping(
  root: string,
  name: string,
  tier: 'project' | 'user',
  host: MappingHost = {},
): Promise<{ readonly golden: Golden; readonly differences: readonly GoldenDifference[] }> {
  const store = mappingStoreFor(root, host);
  const stored = (await store.load()).find(
    (entry) => entry.mapping.name === name && entry.tier === tier,
  );
  if (!stored) throw new InvalidArgumentError('name', `a ${tier} mapping`, name);
  const golden = (await store.golden(name, tier)) as Golden | undefined;
  if (!golden) {
    throw new InvalidArgumentError(
      'name',
      'a mapping with a golden record (learned with `mapping train`)',
      name,
    );
  }
  const runtime = await createRuntime(root, { npmFrom: import.meta.filename, ...host });
  try {
    const present: TrainingSample[] = [];
    for (const recorded of golden.samples) {
      const path = isAbsolute(recorded.path) ? recorded.path : join(root, recorded.path);
      if (existsSync(path))
        present.push({ path: recorded.path, content: await readFile(path, 'utf8') });
    }
    const differences = await checkGolden(runtime, stored.mapping, golden, present);
    return { golden, differences };
  } finally {
    await runtime.dispose();
  }
}
