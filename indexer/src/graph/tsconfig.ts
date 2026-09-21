import { parseJsonc } from './jsonc.ts';
import { dirname, join } from './paths.ts';

/** What the resolver needs from the file system. Implemented over the index and the disk. */
export interface ResolverEnvironment {
  /** Whether a file exists at this workspace-relative path, whether or not it is indexed. */
  exists(path: string): Promise<boolean>;
  /** A file's text, or `undefined` when it does not exist. Other failures throw. */
  read(path: string): Promise<string | undefined>;
}

interface PathRule {
  readonly pattern: string;
  /** Targets, already made workspace-relative. May contain one `*`. */
  readonly targets: readonly string[];
}

/** Import aliases from a `tsconfig.json` / `jsconfig.json`, with paths made workspace-relative. */
export interface AliasConfig {
  /** The config file these came from. */
  readonly source: string;
  /** Bare specifiers resolve against this directory first, when set. */
  readonly baseUrl: string | undefined;
  readonly rules: readonly PathRule[];
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

interface RawConfig {
  readonly extends?: unknown;
  readonly compilerOptions?: {
    readonly baseUrl?: unknown;
    readonly paths?: unknown;
  };
}

/** Finds the alias configuration that applies to a file: the nearest config above it. */
export class AliasResolver {
  readonly #env: ResolverEnvironment;
  readonly #byDirectory = new Map<string, Promise<AliasConfig | undefined>>();

  constructor(env: ResolverEnvironment) {
    this.#env = env;
  }

  /** The aliases in force for files in `directory`. */
  configFor(directory: string): Promise<AliasConfig | undefined> {
    const cached = this.#byDirectory.get(directory);
    if (cached) return cached;
    const found = this.#find(directory);
    this.#byDirectory.set(directory, found);
    return found;
  }

  async #find(directory: string): Promise<AliasConfig | undefined> {
    for (const name of CONFIG_NAMES) {
      const path = directory === '' ? name : `${directory}/${name}`;
      if (await this.#env.exists(path)) return this.#load(path, new Set());
    }
    return directory === '' ? undefined : this.configFor(dirname(directory));
  }

  async #load(path: string, visiting: Set<string>): Promise<AliasConfig | undefined> {
    if (visiting.has(path)) return undefined;
    visiting.add(path);
    const text = await this.#env.read(path);
    if (text === undefined) return undefined;
    const raw = parseJsonc(text, path) as RawConfig | null;
    if (raw === null || typeof raw !== 'object') return undefined;

    const parent =
      typeof raw.extends === 'string'
        ? await this.#loadExtended(path, raw.extends, visiting)
        : undefined;
    const here = raw.compilerOptions;
    const folder = dirname(path);

    const baseUrl =
      typeof here?.baseUrl === 'string' ? join(folder, here.baseUrl) : parent?.baseUrl;
    const paths = here?.paths;
    const rules =
      paths !== undefined && paths !== null && typeof paths === 'object'
        ? rulesOf(paths as Record<string, unknown>, baseUrl ?? folder)
        : (parent?.rules ?? []);
    return { source: path, baseUrl, rules };
  }

  /** `extends` that points at a file in the workspace. A package name (`@tsconfig/node`) has no aliases. */
  async #loadExtended(
    from: string,
    target: string,
    visiting: Set<string>,
  ): Promise<AliasConfig | undefined> {
    if (!target.startsWith('.')) return undefined;
    const base = join(dirname(from), target);
    if (base === undefined) return undefined;
    const candidates = base.endsWith('.json') ? [base] : [`${base}.json`, `${base}/tsconfig.json`];
    for (const candidate of candidates) {
      if (await this.#env.exists(candidate)) return this.#load(candidate, visiting);
    }
    return undefined;
  }
}

function rulesOf(paths: Record<string, unknown>, base: string): PathRule[] {
  const rules: PathRule[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const resolved = targets
      .filter((target): target is string => typeof target === 'string')
      .map((target) => join(base, target))
      .filter((target): target is string => target !== undefined);
    rules.push({ pattern, targets: resolved });
  }
  return rules;
}

/**
 * The workspace-relative bases a specifier maps to under `config`, best match first. A pattern
 * matches its own prefix and suffix around one `*`; among several matches the one with the
 * longest prefix wins, as in TypeScript.
 */
export function aliasCandidates(config: AliasConfig, specifier: string): string[] {
  let best: { rule: PathRule; captured: string; prefixLength: number } | undefined;
  for (const rule of config.rules) {
    const star = rule.pattern.indexOf('*');
    if (star === -1) {
      if (rule.pattern === specifier) return substitute(rule, '');
      continue;
    }
    const prefix = rule.pattern.slice(0, star);
    const suffix = rule.pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (best === undefined || prefix.length > best.prefixLength)
    ) {
      best = {
        rule,
        captured: specifier.slice(prefix.length, specifier.length - suffix.length),
        prefixLength: prefix.length,
      };
    }
  }
  return best ? substitute(best.rule, best.captured) : [];
}

function substitute(rule: PathRule, captured: string): string[] {
  return rule.targets.map((target) => target.replace('*', captured));
}
