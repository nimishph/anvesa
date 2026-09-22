import { CodeLensError, type ErrorInit } from '@cntxt-labs/code-lens-core';

/** Every failure in this package. Codes are `SYNTAX_<REASON>`. */
export abstract class SyntaxSubsystemError extends CodeLensError {
  readonly subsystem = 'syntax' as const;
}

/** One place a grammar was looked for, and why it was not there. */
export interface SourceMiss {
  readonly source: string;
  readonly reason: string;
}

/** A language key, extension or path that no registered language claims. */
export class UnknownLanguageError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_UNKNOWN_LANGUAGE';

  constructor(
    requested: { readonly language?: string; readonly path?: string },
    known: readonly string[],
    init: ErrorInit = {},
  ) {
    const what =
      requested.language !== undefined
        ? `language "${requested.language}"`
        : `path "${requested.path}"`;
    super(`No registered language for ${what}`, {
      ...init,
      context: { ...requested, known, ...init.context },
    });
  }
}

/** Two language definitions claim the same key or extension. */
export class LanguageConflictError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_LANGUAGE_CONFLICT';

  constructor(
    claim: string,
    existingLanguage: string,
    incomingLanguage: string,
    init: ErrorInit = {},
  ) {
    super(
      `Cannot register "${incomingLanguage}": ${claim} already belongs to "${existingLanguage}"`,
      { ...init, context: { claim, existingLanguage, incomingLanguage, ...init.context } },
    );
  }
}

/** No grammar wasm could be found for a language in any configured source. */
export class GrammarMissingError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_GRAMMAR_MISSING';
  readonly searched: readonly SourceMiss[];

  constructor(
    language: string,
    grammarId: string,
    searched: readonly SourceMiss[],
    init: ErrorInit = {},
  ) {
    super(`No grammar available for "${language}" (grammar "${grammarId}")`, {
      hint: `Install it: code-lens grammar install ${language} --from <dir|tarball> (or allow the network).`,
      ...init,
      context: { language, grammarId, searched, ...init.context },
    });
    this.searched = searched;
  }
}

/** A grammar's bytes do not match the hash recorded for it. It is never loaded. */
export class GrammarIntegrityError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_GRAMMAR_INTEGRITY';
  readonly origin: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(
    grammarId: string,
    origin: string,
    expectedSha256: string,
    actualSha256: string,
    init: ErrorInit = {},
  ) {
    super(`Grammar "${grammarId}" from ${origin} does not match its recorded checksum`, {
      hint: 'Reinstall the grammar, or update the lockfile deliberately if the change is expected.',
      ...init,
      context: { grammarId, origin, expectedSha256, actualSha256, ...init.context },
    });
    this.origin = origin;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

/** The wasm loaded but the parser runtime refuses it, e.g. an ABI version mismatch. */
export class GrammarIncompatibleError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_GRAMMAR_INCOMPATIBLE';

  constructor(grammarId: string, origin: string, init: ErrorInit = {}) {
    super(`Grammar "${grammarId}" from ${origin} cannot be used by the parser runtime`, {
      hint: 'Install a grammar built for the same tree-sitter ABI as the bundled runtime.',
      ...init,
      context: { grammarId, origin, ...init.context },
    });
  }
}

/** The lockfile is unreadable, malformed or not a lockfile this version understands. */
export class GrammarLockError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_LOCKFILE_INVALID';

  constructor(path: string, problem: string, init: ErrorInit = {}) {
    super(`Grammar lockfile ${path} is invalid: ${problem}`, {
      ...init,
      context: { path, problem, ...init.context },
    });
  }
}

/** A grammar could not be installed. `stage` says how far it got. */
export class GrammarInstallError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_INSTALL_FAILED';

  constructor(
    grammarId: string,
    stage: 'locate' | 'fetch' | 'extract' | 'validate' | 'write' | 'lock',
    detail: string,
    init: ErrorInit = {},
  ) {
    super(`Installing grammar "${grammarId}" failed while trying to ${stage}: ${detail}`, {
      ...init,
      context: { grammarId, stage, detail, ...init.context },
    });
  }
}

/** An install would need the network but the caller forbade it. */
export class NetworkForbiddenError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_NETWORK_FORBIDDEN';

  constructor(grammarId: string, url: string, init: ErrorInit = {}) {
    super(`Installing "${grammarId}" needs the network, but offline mode is on`, {
      hint: 'Install from a local copy instead: code-lens grammar install <lang> --from <dir|tarball>.',
      ...init,
      context: { grammarId, url, ...init.context },
    });
  }
}

/** The tree-sitter wasm runtime itself could not start. */
export class RuntimeInitError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_RUNTIME_INIT_FAILED';

  constructor(problem: string, init: ErrorInit = {}) {
    super(`Parser runtime failed to start: ${problem}`, {
      ...init,
      context: { problem, ...init.context },
    });
  }
}

/** The parser produced no tree for reasons other than a deadline. */
export class ParseFailedError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_PARSE_FAILED';

  constructor(language: string, path: string | undefined, init: ErrorInit = {}) {
    super(`Parsing ${path ?? 'source'} as ${language} produced no tree`, {
      ...init,
      context: { language, path, ...init.context },
    });
  }
}

/** A tree or node was used after `dispose()`. Its wasm memory is gone. */
export class TreeDisposedError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_TREE_DISPOSED';

  constructor(language: string, path: string | undefined, init: ErrorInit = {}) {
    super(`Syntax tree for ${path ?? 'source'} (${language}) was used after dispose()`, {
      ...init,
      context: { language, path, ...init.context },
    });
  }
}

/** The runtime was disposed and can no longer parse. */
export class RuntimeDisposedError extends SyntaxSubsystemError {
  readonly code = 'SYNTAX_RUNTIME_DISPOSED';

  constructor(operation: string, init: ErrorInit = {}) {
    super(`Cannot ${operation}: the syntax runtime was disposed`, init);
  }
}
