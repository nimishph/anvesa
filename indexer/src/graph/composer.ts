import type { WorkspacePackage } from '../workspace/discover.ts';
import { parseJsonc } from './jsonc.ts';
import { dirname, join } from './paths.ts';
import type { ResolverEnvironment } from './tsconfig.ts';

export interface ComposerRule {
  readonly prefix: string;
  readonly targets: readonly string[];
  readonly isPsr0?: boolean;
}

export interface ComposerConfig {
  readonly source: string;
  readonly root: string;
  readonly rules: readonly ComposerRule[];
}

function cleanTarget(target: string): string {
  let cleaned = target.replace(/\\/g, '/');
  if (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  if (cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

function normalizeTargets(target: unknown): string[] {
  if (typeof target === 'string') return [cleanTarget(target)];
  if (Array.isArray(target)) {
    return target.filter((t): t is string => typeof t === 'string').map(cleanTarget);
  }
  return [];
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\\+/, '');
}

export function parseComposerConfig(text: string, path: string): ComposerConfig | undefined {
  try {
    const raw = parseJsonc(text, path) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object') return undefined;

    const root = dirname(path);
    const rules: ComposerRule[] = [];

    const sections = [raw.autoload, raw['autoload-dev'], raw.autoloadDev];
    for (const section of sections) {
      if (section === null || typeof section !== 'object') continue;
      const s = section as Record<string, unknown>;

      if (s['psr-4'] && typeof s['psr-4'] === 'object') {
        for (const [prefix, target] of Object.entries(s['psr-4'] as Record<string, unknown>)) {
          const targets = normalizeTargets(target);
          if (targets.length > 0) {
            rules.push({ prefix: normalizePrefix(prefix), targets });
          }
        }
      }

      if (s['psr-0'] && typeof s['psr-0'] === 'object') {
        for (const [prefix, target] of Object.entries(s['psr-0'] as Record<string, unknown>)) {
          const targets = normalizeTargets(target);
          if (targets.length > 0) {
            rules.push({ prefix: normalizePrefix(prefix), targets, isPsr0: true });
          }
        }
      }
    }

    // Sort by prefix length descending so most specific prefix matches first
    rules.sort((a, b) => b.prefix.length - a.prefix.length);

    return { source: path, root, rules };
  } catch {
    return undefined;
  }
}

export function composerCandidates(config: ComposerConfig, specifier: string): string[] {
  const cleanSpec = specifier.replace(/^\\+/, '');
  const candidates: string[] = [];

  for (const rule of config.rules) {
    let subPath: string | undefined;

    if (rule.isPsr0) {
      if (rule.prefix === '' || cleanSpec.startsWith(rule.prefix)) {
        const withSlashes = cleanSpec.replace(/\\/g, '/');
        const lastSlash = withSlashes.lastIndexOf('/');
        const dirPart = lastSlash === -1 ? '' : withSlashes.slice(0, lastSlash + 1);
        const classPart = (
          lastSlash === -1 ? withSlashes : withSlashes.slice(lastSlash + 1)
        ).replace(/_/g, '/');
        subPath = `${dirPart}${classPart}`;
      }
    } else if (rule.prefix === '') {
      subPath = cleanSpec.replace(/\\/g, '/');
    } else {
      const prefixWithSlash = rule.prefix.endsWith('\\') ? rule.prefix : `${rule.prefix}\\`;
      if (cleanSpec === rule.prefix.replace(/\\+$/, '')) {
        subPath = '';
      } else if (cleanSpec.startsWith(prefixWithSlash)) {
        subPath = cleanSpec.slice(prefixWithSlash.length).replace(/\\/g, '/');
      }
    }

    if (subPath === undefined) continue;

    const relativeFile =
      subPath === '' ? `${rule.prefix.replace(/\\+$/, '')}.php` : `${subPath}.php`;

    for (const target of rule.targets) {
      const base = join(config.root, target);
      if (base === undefined) continue;
      const candidate = join(base, relativeFile);
      if (candidate !== undefined && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

export class ComposerResolver {
  readonly #env: ResolverEnvironment;
  readonly #packages: readonly WorkspacePackage[];
  readonly #byDirectory = new Map<string, Promise<ComposerConfig | undefined>>();
  #allConfigs: Promise<readonly ComposerConfig[]> | undefined;

  constructor(env: ResolverEnvironment, packages: readonly WorkspacePackage[] = []) {
    this.#env = env;
    this.#packages = packages;
  }

  configFor(directory: string): Promise<ComposerConfig | undefined> {
    const cached = this.#byDirectory.get(directory);
    if (cached) return cached;
    const found = this.#find(directory);
    this.#byDirectory.set(directory, found);
    return found;
  }

  async #find(directory: string): Promise<ComposerConfig | undefined> {
    const path = directory === '' ? 'composer.json' : `${directory}/composer.json`;
    if (await this.#env.exists(path)) return this.#load(path);
    return directory === '' ? undefined : this.configFor(dirname(directory));
  }

  async #load(path: string): Promise<ComposerConfig | undefined> {
    const text = await this.#env.read(path);
    if (text === undefined) return undefined;
    return parseComposerConfig(text, path);
  }

  allConfigs(): Promise<readonly ComposerConfig[]> {
    if (!this.#allConfigs) {
      this.#allConfigs = this.#loadAllConfigs();
    }
    return this.#allConfigs;
  }

  async #loadAllConfigs(): Promise<readonly ComposerConfig[]> {
    const configs: ComposerConfig[] = [];
    const rootConfig = await this.configFor('');
    if (rootConfig) configs.push(rootConfig);
    for (const pkg of this.#packages) {
      if (pkg.manifest?.endsWith('composer.json')) {
        const cfg = await this.#load(pkg.manifest);
        if (cfg && !configs.some((c) => c.source === cfg.source)) {
          configs.push(cfg);
        }
      }
    }
    return configs;
  }
}
