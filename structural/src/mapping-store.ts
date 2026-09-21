import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { InvalidArgumentError } from '@sutras/code-lens-core';
import { MappingIntegrityError, MappingInvalidError, MappingLockError } from './errors.ts';
import { type LanguageMapping, MappingRegistry, validateMapping } from './mapping.ts';

/** Where a mapping comes from. A project's mapping wins over the user's, and theirs over the bundled. */
export type MappingTier = 'project' | 'user' | 'bundled';

export interface StoredMapping {
  readonly mapping: LanguageMapping;
  /** The language keys it serves. */
  readonly languages: readonly string[];
  readonly tier: MappingTier;
  /** The file, for a project or user mapping. */
  readonly path: string | undefined;
  /** Of the file's bytes; of the canonical JSON for a bundled mapping, which has no file. */
  readonly sha256: string;
}

export interface MappingStoreOptions {
  /** The project root. Its mappings live in `.code-lens/mappings`. */
  readonly projectDir?: string;
  /** `CODE_LENS_HOME` or `~/.code-lens`. */
  readonly homeDir?: string;
}

const LOCKFILE_VERSION = 1;
const GOLDEN_SUFFIX = '.golden.json';

interface LockEntry {
  readonly sha256: string;
  readonly languages: readonly string[];
}

const sha256Of = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file a mapping is kept in: readable, stable, one trailing newline. */
export const mappingFileText = (mapping: LanguageMapping): string =>
  `${JSON.stringify(mapping, null, 2)}\n`;

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(staging, text);
  await rename(staging, path);
}

/**
 * Mappings kept outside the package: in a project (committed with it, so a team shares them) or
 * for the user. Each tier has a lockfile of checksums. A mapping whose file is not what was
 * recorded, or is not recorded at all, is refused with a typed error rather than used: a mapping
 * decides what the index holds, so a changed one must be a decision, made with `lock`.
 */
export class MappingStore {
  readonly #tiers: readonly {
    readonly tier: 'project' | 'user';
    readonly dir: string;
    readonly lock: string;
  }[];

  constructor(options: MappingStoreOptions = {}) {
    const home = options.homeDir ?? process.env.CODE_LENS_HOME ?? join(homedir(), '.code-lens');
    const tiers: { tier: 'project' | 'user'; dir: string; lock: string }[] = [];
    if (options.projectDir) {
      const base = join(options.projectDir, '.code-lens');
      tiers.push({
        tier: 'project',
        dir: join(base, 'mappings'),
        lock: join(base, 'mappings.lock.json'),
      });
    }
    tiers.push({
      tier: 'user',
      dir: join(home, 'mappings'),
      lock: join(home, 'mappings.lock.json'),
    });
    this.#tiers = tiers;
  }

  /** The folder a tier keeps its mappings in. */
  directoryOf(tier: 'project' | 'user'): string {
    const found = this.#tiers.find((candidate) => candidate.tier === tier);
    if (!found) {
      throw new InvalidArgumentError('tier', 'user (or project, inside a project)', tier);
    }
    return found.dir;
  }

  // --- reading ------------------------------------------------------------------------------------

  async #readLock(path: string): Promise<Map<string, LockEntry>> {
    if (!existsSync(path)) return new Map();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (failure) {
      throw new MappingLockError(path, 'it is not valid JSON', { cause: failure });
    }
    if (
      !isRecord(parsed) ||
      parsed.lockfileVersion !== LOCKFILE_VERSION ||
      !isRecord(parsed.mappings)
    ) {
      throw new MappingLockError(
        path,
        `expected lockfileVersion ${LOCKFILE_VERSION} and a "mappings" object`,
      );
    }
    const entries = new Map<string, LockEntry>();
    for (const [name, raw] of Object.entries(parsed.mappings)) {
      const sha = isRecord(raw) ? raw.sha256 : undefined;
      const languages = isRecord(raw) ? raw.languages : undefined;
      if (
        typeof sha !== 'string' ||
        !/^[0-9a-f]{64}$/.test(sha) ||
        !Array.isArray(languages) ||
        languages.some((language) => typeof language !== 'string')
      ) {
        throw new MappingLockError(
          path,
          `the entry for "${name}" has no usable sha256 and languages`,
        );
      }
      entries.set(name, { sha256: sha, languages: languages as string[] });
    }
    return entries;
  }

  async #writeLock(path: string, entries: ReadonlyMap<string, LockEntry>): Promise<void> {
    const mappings: Record<string, LockEntry> = {};
    for (const name of [...entries.keys()].sort()) mappings[name] = entries.get(name) as LockEntry;
    await writeAtomically(
      path,
      `${JSON.stringify({ lockfileVersion: LOCKFILE_VERSION, mappings }, null, 2)}\n`,
    );
  }

  async #files(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    return (await readdir(dir))
      .filter((file) => file.endsWith('.json') && !file.endsWith(GOLDEN_SUFFIX))
      .sort();
  }

  /**
   * Every stored mapping, checked. Stops at the first that is not what was recorded
   * (`MappingIntegrityError`) or that does not validate (`MappingInvalidError`).
   */
  async load(): Promise<readonly StoredMapping[]> {
    const found: StoredMapping[] = [];
    for (const { tier, dir, lock } of this.#tiers) {
      const entries = await this.#readLock(lock);
      const seen = new Set<string>();
      for (const file of await this.#files(dir)) {
        const path = join(dir, file);
        const name = file.slice(0, -'.json'.length);
        const bytes = await readFile(path);
        const actual = sha256Of(bytes);
        const recorded = entries.get(name);
        if (!recorded) throw new MappingIntegrityError(name, path, undefined, actual);
        if (recorded.sha256 !== actual)
          throw new MappingIntegrityError(name, path, recorded.sha256, actual);
        seen.add(name);
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.toString('utf8'));
        } catch (failure) {
          throw new MappingInvalidError(name, '(root)', 'it is not valid JSON', { cause: failure });
        }
        const mapping = validateMapping(raw, path);
        if (mapping.name !== name) {
          throw new MappingInvalidError(
            name,
            'name',
            `the file is named "${name}" but the mapping says "${mapping.name}"`,
          );
        }
        found.push({ mapping, languages: recorded.languages, tier, path, sha256: actual });
      }
      for (const [name, entry] of entries) {
        if (!seen.has(name)) {
          throw new MappingIntegrityError(name, join(dir, `${name}.json`), entry.sha256, undefined);
        }
      }
    }
    return found;
  }

  /** The bundled mappings, then the user's, then the project's over them. */
  async registry(): Promise<MappingRegistry> {
    const registry = new MappingRegistry();
    const stored = await this.load();
    for (const tier of ['user', 'project'] as const) {
      for (const entry of stored.filter((candidate) => candidate.tier === tier)) {
        registry.override(entry.mapping, { languages: entry.languages });
      }
    }
    return registry;
  }

  /** What is in effect: the bundled mappings, each replaced where a tier overrides its language. */
  async list(): Promise<readonly StoredMapping[]> {
    const stored = await this.load();
    const effective: StoredMapping[] = [];
    const bundled = new MappingRegistry();
    for (const language of bundled.languages()) {
      const mapping = bundled.mappingFor(language) as LanguageMapping;
      if (
        effective.some((entry) => entry.tier === 'bundled' && entry.mapping.name === mapping.name)
      )
        continue;
      effective.push({
        mapping,
        languages: bundled.languagesOf(mapping.name),
        tier: 'bundled',
        path: undefined,
        sha256: sha256Of(mappingFileText(mapping)),
      });
    }
    return [...effective, ...stored];
  }

  // --- changing -----------------------------------------------------------------------------------

  /**
   * Put a mapping in a tier and record its checksum. The mapping is validated first; nothing is
   * written for one that is not valid. Replacing a mapping whose file differs from the record needs
   * `force`, so an edit made by hand is not overwritten by accident.
   */
  async install(
    raw: unknown,
    options: {
      readonly tier: 'project' | 'user';
      readonly languages?: readonly string[];
      readonly force?: boolean;
      /** A golden record (see `synthesizeGolden`) kept beside the mapping. */
      readonly golden?: unknown;
    },
  ): Promise<StoredMapping> {
    const mapping = validateMapping(raw, 'the mapping to install');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mapping.name)) {
      throw new MappingInvalidError(
        mapping.name,
        'name',
        'a stored mapping is named with letters, digits, ".", "_" and "-"',
      );
    }
    const tier = this.#tier(options.tier);
    const entries = await this.#readLock(tier.lock);
    const path = join(tier.dir, `${mapping.name}.json`);
    const previous = entries.get(mapping.name);
    if (previous && existsSync(path) && !options.force) {
      const actual = sha256Of(await readFile(path));
      if (actual !== previous.sha256)
        throw new MappingIntegrityError(mapping.name, path, previous.sha256, actual);
    }
    const languages = options.languages ?? previous?.languages ?? [mapping.name];
    const text = mappingFileText(mapping);
    await writeAtomically(path, text);
    if (options.golden !== undefined) {
      await writeAtomically(
        join(tier.dir, `${mapping.name}${GOLDEN_SUFFIX}`),
        `${JSON.stringify(options.golden, null, 2)}\n`,
      );
    }
    const sha256 = sha256Of(text);
    entries.set(mapping.name, { sha256, languages });
    await this.#writeLock(tier.lock, entries);
    return { mapping, languages, tier: options.tier, path, sha256 };
  }

  /**
   * Copy the mapping in effect for a language into a tier, to edit. The copy serves the same
   * languages, and is recorded, so it can be changed and then re-recorded with `lock`.
   */
  async fork(
    language: string,
    options: { readonly tier: 'project' | 'user'; readonly name?: string },
  ): Promise<StoredMapping> {
    const registry = await this.registry();
    const source = registry.mappingFor(language);
    if (!source) {
      throw new InvalidArgumentError(
        'language',
        `one of ${registry.languages().join(', ')}`,
        language,
      );
    }
    const languages = registry.languagesOf(source.name);
    const name = options.name ?? source.name;
    return this.install({ ...source, name }, { tier: options.tier, languages, force: false });
  }

  /** Record the file as it is now, after a change that was meant. */
  async lock(name: string, tier: 'project' | 'user'): Promise<StoredMapping> {
    const found = this.#tier(tier);
    const path = join(found.dir, `${name}.json`);
    if (!existsSync(path))
      throw new InvalidArgumentError('name', `a mapping in ${found.dir}`, name);
    const bytes = await readFile(path);
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (failure) {
      throw new MappingInvalidError(name, '(root)', 'it is not valid JSON', { cause: failure });
    }
    const mapping = validateMapping(raw, path);
    const entries = await this.#readLock(found.lock);
    const languages = entries.get(name)?.languages ?? [mapping.name];
    const sha256 = sha256Of(bytes);
    entries.set(name, { sha256, languages });
    await this.#writeLock(found.lock, entries);
    return { mapping, languages, tier, path, sha256 };
  }

  /** Delete a stored mapping (and its golden record) and its lock entry. */
  async remove(name: string, tier: 'project' | 'user'): Promise<boolean> {
    const found = this.#tier(tier);
    const entries = await this.#readLock(found.lock);
    const path = join(found.dir, `${name}.json`);
    const had = existsSync(path) || entries.has(name);
    await rm(path, { force: true });
    await rm(join(found.dir, `${name}${GOLDEN_SUFFIX}`), { force: true });
    if (entries.delete(name)) await this.#writeLock(found.lock, entries);
    return had;
  }

  /** The golden record kept beside a mapping, if there is one. */
  async golden(name: string, tier: 'project' | 'user'): Promise<unknown | undefined> {
    const path = join(this.#tier(tier).dir, `${name}${GOLDEN_SUFFIX}`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (failure) {
      throw new MappingInvalidError(name, 'golden', 'the golden record is not valid JSON', {
        cause: failure,
      });
    }
  }

  // --- checking -----------------------------------------------------------------------------------

  /**
   * Check every stored mapping against its record, and report all that are wrong, rather than
   * stopping at the first.
   */
  async verify(): Promise<readonly MappingCheck[]> {
    const checks: MappingCheck[] = [];
    for (const { tier, dir, lock } of this.#tiers) {
      const entries = await this.#readLock(lock);
      const files = new Set((await this.#files(dir)).map((file) => file.slice(0, -'.json'.length)));
      for (const name of [...new Set([...files, ...entries.keys()])].sort()) {
        const path = join(dir, `${name}.json`);
        const recorded = entries.get(name);
        if (!files.has(name)) checks.push({ tier, name, path, status: 'missing' });
        else if (!recorded) checks.push({ tier, name, path, status: 'unrecorded' });
        else {
          const actual = sha256Of(await readFile(path));
          checks.push({ tier, name, path, status: actual === recorded.sha256 ? 'ok' : 'modified' });
        }
      }
    }
    return checks;
  }

  #tier(tier: 'project' | 'user') {
    const found = this.#tiers.find((candidate) => candidate.tier === tier);
    if (!found) {
      throw new InvalidArgumentError('tier', 'user (or project, inside a project)', tier);
    }
    return found;
  }
}

export interface MappingCheck {
  readonly tier: 'project' | 'user';
  readonly name: string;
  readonly path: string;
  /** `modified`: the file is not what was recorded. `unrecorded`: no lock entry. `missing`: the file is gone. */
  readonly status: 'ok' | 'modified' | 'unrecorded' | 'missing';
}
