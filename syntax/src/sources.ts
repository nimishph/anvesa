import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GrammarMissingError, type SourceMiss } from './errors.ts';
import { isNotFound, systemCode } from './files.ts';
import type { GrammarRef } from './languages.ts';

/** A grammar file that exists, and which source it came from. */
export interface LocatedGrammar {
  readonly path: string;
  readonly origin: string;
}

export type LocateOutcome = { readonly located: LocatedGrammar } | { readonly miss: string };

/** Somewhere grammar wasm files can live. Sources are tried in order. */
export interface GrammarSource {
  readonly name: string;
  locate(grammar: GrammarRef): Promise<LocateOutcome>;
}

/** Grammars inside a directory: `<dir>/<grammar.file>`. */
export function directorySource(name: string, directory: string): GrammarSource {
  return {
    name,
    async locate(grammar) {
      const path = join(directory, grammar.file);
      try {
        const info = await stat(path);
        if (!info.isFile()) return { miss: `${path} is not a file` };
        return { located: { path, origin: name } };
      } catch (failure) {
        if (isNotFound(failure)) return { miss: `${path} does not exist` };
        return { miss: `${path} is unreadable (${systemCode(failure) ?? 'unknown error'})` };
      }
    },
  };
}

/**
 * Grammars the host application supplies itself, e.g. wasm files embedded in a compiled binary.
 * The map is keyed by grammar id. The library cannot embed files on the host's behalf.
 */
export function embeddedSource(
  files: Readonly<Record<string, string>>,
  name = 'embedded',
): GrammarSource {
  return {
    name,
    async locate(grammar) {
      const path = files[grammar.id];
      if (path === undefined) return { miss: `the host embeds no "${grammar.id}" grammar` };
      try {
        await stat(path);
        return { located: { path, origin: name } };
      } catch (failure) {
        return {
          miss: `embedded path ${path} is not readable (${systemCode(failure) ?? 'unknown error'})`,
        };
      }
    },
  };
}

/** Grammars shipped by an installed npm package, resolved from `resolveFrom` like `require`. */
export function npmPackageSource(resolveFrom: string, name = 'npm'): GrammarSource {
  const resolver = createRequire(resolveFrom);
  return {
    name,
    async locate(grammar) {
      let manifest: string;
      try {
        manifest = resolver.resolve(`${grammar.npmPackage}/package.json`);
      } catch (resolveFailure) {
        return {
          miss: `package ${grammar.npmPackage} is not installed (${systemCode(resolveFailure) ?? 'unresolvable'})`,
        };
      }
      const path = join(dirname(manifest), grammar.file);
      try {
        await stat(path);
        return { located: { path, origin: `${name}:${grammar.npmPackage}` } };
      } catch (failure) {
        if (isNotFound(failure)) {
          return { miss: `package ${grammar.npmPackage} ships no ${grammar.file}` };
        }
        return { miss: `${path} is unreadable (${systemCode(failure) ?? 'unknown error'})` };
      }
    },
  };
}

/** Where code-lens keeps per-user state. `ANVESA_HOME` overrides `~/.anvesa`. */
export function codeLensHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.ANVESA_HOME ?? join(homedir(), '.anvesa');
}

export interface StandardLayoutOptions {
  /** A project root. Its `.anvesa/grammars` directory is searched before the user's. */
  readonly projectDir?: string;
  readonly homeDir?: string;
  /** Grammars the host embeds, keyed by grammar id. */
  readonly embedded?: Readonly<Record<string, string>>;
  /** Resolve `tree-sitter-*` npm packages relative to this file path. */
  readonly npmFrom?: string;
}

export interface StandardLayout {
  readonly sources: readonly GrammarSource[];
  /** Directory `installGrammar` writes to by default: project if given, otherwise user. */
  readonly installDir: string;
  /** Lockfile paths, project first. */
  readonly lockPaths: readonly string[];
}

/** The usual search order: embedded, project, user, then npm packages. */
export function standardLayout(options: StandardLayoutOptions = {}): StandardLayout {
  const home = options.homeDir ?? codeLensHome();
  const userDir = join(home, 'grammars');
  const projectDir = options.projectDir ? join(options.projectDir, '.anvesa', 'grammars') : null;
  const sources: GrammarSource[] = [];
  if (options.embedded) sources.push(embeddedSource(options.embedded));
  if (projectDir) sources.push(directorySource('project', projectDir));
  sources.push(directorySource('user', userDir));
  if (options.npmFrom) sources.push(npmPackageSource(options.npmFrom));
  const lockPaths = [
    ...(options.projectDir ? [join(options.projectDir, '.anvesa', 'grammars.lock.json')] : []),
    join(home, 'grammars.lock.json'),
  ];
  return { sources, installDir: projectDir ?? userDir, lockPaths };
}

/**
 * Find a grammar in the first source that has it. When none does, the error lists every source
 * that was tried and why it missed, so "not installed" is never a guess.
 */
export async function locateGrammar(
  language: string,
  grammar: GrammarRef,
  sources: readonly GrammarSource[],
): Promise<LocatedGrammar> {
  const trail: SourceMiss[] = [];
  for (const source of sources) {
    const outcome = await source.locate(grammar);
    if ('located' in outcome) return outcome.located;
    trail.push({ source: source.name, reason: outcome.miss });
  }
  throw new GrammarMissingError(language, grammar.id, trail);
}
