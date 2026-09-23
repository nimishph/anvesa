import { stat } from 'node:fs/promises';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  GrammarLock,
  type InstallResult,
  type InstallSource,
  installGrammar,
  LanguageRegistry,
  type LanguageStatus,
  SyntaxRuntime,
  standardLayout,
} from '@cntxt-labs/anvesa-syntax';

/**
 * Where a host finds grammars beyond the directories every install has. A compiled binary embeds
 * the grammars it ships and passes them here; a library user usually passes nothing.
 */
export interface GrammarHost {
  /** Grammar id to the path of an embedded wasm file. */
  readonly embedded?: Readonly<Record<string, string>>;
  /** Path of `web-tree-sitter.wasm`, when the parser runtime cannot find its own. */
  readonly runtimeWasm?: string;
  /** Overrides `ANVESA_HOME` and `~/.anvesa`. */
  readonly home?: string;
  /** Resolve `tree-sitter-*` npm packages from here too. Development trees have them. */
  readonly npmFrom?: string;
}

function layoutFor(root: string, host: GrammarHost) {
  return standardLayout({
    projectDir: root,
    ...(host.home ? { homeDir: host.home } : {}),
    ...(host.embedded ? { embedded: host.embedded } : {}),
    ...(host.npmFrom ? { npmFrom: host.npmFrom } : {}),
  });
}

/** A parser runtime over the standard grammar layout, with the lockfiles that vouch for them. */
export async function createRuntime(root: string, host: GrammarHost = {}): Promise<SyntaxRuntime> {
  const layout = layoutFor(root, host);
  const locks = await Promise.all(layout.lockPaths.map((path) => GrammarLock.load(path)));
  return new SyntaxRuntime({
    sources: layout.sources,
    locks,
    ...(host.runtimeWasm ? { runtimeWasm: host.runtimeWasm } : {}),
  });
}

export interface GrammarRow {
  readonly language: string;
  readonly extensions: readonly string[];
  readonly grammar: string;
  readonly state: 'ready' | 'missing' | 'corrupt';
  /** Where it was found, or what was searched. */
  readonly detail: string;
}

const describe = (status: LanguageStatus): GrammarRow => {
  const { language, grammar } = status;
  const base = {
    language: language.key,
    extensions: language.extensions,
    grammar: language.grammar.id,
  };
  if (grammar.state === 'ready') {
    return {
      ...base,
      state: 'ready',
      detail: `${grammar.origin}${grammar.locked ? ', checksum locked' : ''}`,
    };
  }
  if (grammar.state === 'corrupt') {
    return {
      ...base,
      state: 'corrupt',
      detail: `${grammar.origin}: expected ${grammar.expectedSha256}, found ${grammar.actualSha256}`,
    };
  }
  return {
    ...base,
    state: 'missing',
    detail: `searched ${grammar.searched.map((miss) => miss.source).join(', ')}`,
  };
};

/** Every language code-lens knows and whether its grammar can be loaded right now. */
export async function listGrammars(
  root: string,
  host: GrammarHost = {},
): Promise<readonly GrammarRow[]> {
  const runtime = await createRuntime(root, host);
  try {
    return (await runtime.status()).map(describe);
  } finally {
    await runtime.dispose();
  }
}

export interface InstallGrammarOptions {
  readonly language: string;
  /** A wasm file, a directory holding it, or an `npm pack` tarball. Absent means download. */
  readonly from?: string;
  /** Install for the user (`~/.anvesa/grammars`) rather than this project. */
  readonly user?: boolean;
  /** Accept bytes that differ from the locked checksum and re-pin. */
  readonly updateLock?: boolean;
  /** Permit the network. Without `from`, an install needs this. */
  readonly download?: boolean;
}

async function sourceOf(path: string): Promise<InstallSource> {
  const info = await stat(path);
  if (info.isDirectory()) return { kind: 'directory', path };
  return /\.(tgz|tar\.gz)$/i.test(path) ? { kind: 'tarball', path } : { kind: 'file', path };
}

/** Put a grammar where the runtime will find it, and record its checksum in the lockfile. */
export async function installGrammarFor(
  root: string,
  options: InstallGrammarOptions,
  host: GrammarHost = {},
): Promise<InstallResult> {
  const layout = layoutFor(root, host);
  const registry = new LanguageRegistry();
  if (options.from === undefined && !options.download) {
    throw new InvalidArgumentError(
      '--from',
      'a wasm file, directory or tarball; or --download to fetch it',
      undefined,
    );
  }
  const destinationDir = options.user ? userGrammarDir(layout.lockPaths) : layout.installDir;
  const lockPath = options.user
    ? (layout.lockPaths[layout.lockPaths.length - 1] as string)
    : (layout.lockPaths[0] as string);
  const lock = await GrammarLock.load(lockPath);
  const result = await installGrammar({
    registry,
    language: options.language,
    source: options.from ? await sourceOf(options.from) : { kind: 'registry' as const },
    destinationDir,
    lock,
    offline: !options.download,
    ...(options.updateLock ? { updateLock: true } : {}),
  });
  await lock.save();
  return result;
}

/** `<home>/grammars`, from the user lockfile `<home>/grammars.lock.json`. */
function userGrammarDir(lockPaths: readonly string[]): string {
  const userLock = lockPaths[lockPaths.length - 1] as string;
  return userLock.replace(/grammars\.lock\.json$/, 'grammars');
}
