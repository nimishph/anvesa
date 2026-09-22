import { CodeLensError, type ErrorInit } from '@cntxt-labs/code-lens-core';

/** Every failure in this package. Codes are `INDEXER_<REASON>`. */
export abstract class IndexerSubsystemError extends CodeLensError {
  readonly subsystem = 'indexer' as const;
}

/** The workspace root does not exist or is not a directory. */
export class WorkspaceRootError extends IndexerSubsystemError {
  readonly code = 'INDEXER_WORKSPACE_ROOT';

  constructor(root: string, problem: string, init: ErrorInit = {}) {
    super(`Cannot open workspace at ${root}: ${problem}`, {
      ...init,
      context: { root, problem, ...init.context },
    });
  }
}

/** `.code-lens/workspace.json` is unreadable or does not fit its schema. `location` is the field. */
export class WorkspaceConfigError extends IndexerSubsystemError {
  readonly code = 'INDEXER_WORKSPACE_CONFIG';

  constructor(path: string, location: string, problem: string, init: ErrorInit = {}) {
    super(`Workspace config ${path} is invalid at ${location}: ${problem}`, {
      ...init,
      context: { path, location, problem, ...init.context },
    });
  }
}

/** A package manifest could not be read or understood. Discovery records it and carries on. */
export class ManifestInvalidError extends IndexerSubsystemError {
  readonly code = 'INDEXER_MANIFEST_INVALID';

  constructor(path: string, format: string, problem: string, init: ErrorInit = {}) {
    super(`Cannot read ${format} manifest ${path}: ${problem}`, {
      ...init,
      context: { path, format, problem, ...init.context },
    });
  }
}

/** An ignore file exists but could not be read. */
export class IgnoreFileError extends IndexerSubsystemError {
  readonly code = 'INDEXER_IGNORE_FILE';

  constructor(path: string, init: ErrorInit = {}) {
    super(`Cannot read ignore file ${path}`, { ...init, context: { path, ...init.context } });
  }
}

/** A source file could not be read at the moment it was needed. */
export class SourceReadError extends IndexerSubsystemError {
  readonly code = 'INDEXER_SOURCE_READ';

  constructor(path: string, init: ErrorInit = {}) {
    super(`Cannot read source file ${path}`, { ...init, context: { path, ...init.context } });
  }
}

/** A directory could not be listed during the walk. The walk continues; the summary keeps this. */
export class DirectoryReadError extends IndexerSubsystemError {
  readonly code = 'INDEXER_DIRECTORY_READ';

  constructor(path: string, init: ErrorInit = {}) {
    super(`Cannot list directory ${path === '' ? '(workspace root)' : path}`, {
      ...init,
      context: { path, ...init.context },
    });
  }
}

/** A package name or root given for scoping does not exist in the workspace. */
export class UnknownPackageError extends IndexerSubsystemError {
  readonly code = 'INDEXER_UNKNOWN_PACKAGE';

  constructor(requested: string, known: readonly string[], init: ErrorInit = {}) {
    super(`No package named or rooted at "${requested}" in this workspace`, {
      hint: known.length > 0 ? `Packages: ${known.join(', ')}.` : 'This workspace has no packages.',
      ...init,
      context: { requested, known, ...init.context },
    });
  }
}

/** The index database could not be opened or created. */
export class StoreOpenError extends IndexerSubsystemError {
  readonly code = 'INDEXER_STORE_OPEN';

  constructor(path: string, init: ErrorInit = {}) {
    super(`Cannot open index database ${path}`, { ...init, context: { path, ...init.context } });
  }
}

/**
 * The database's schema is not one this version can use: written by a newer version, or not an
 * index at all. Old schemas are migrated; these two cases are refused rather than guessed at.
 */
export class StoreSchemaError extends IndexerSubsystemError {
  readonly code = 'INDEXER_STORE_SCHEMA';

  constructor(path: string, problem: string, init: ErrorInit = {}) {
    super(`Index database ${path} cannot be used: ${problem}`, {
      ...init,
      context: { path, problem, ...init.context },
    });
  }
}

/** A database operation failed. `sqliteCode` (e.g. `SQLITE_BUSY`) is in the context when known. */
export class StoreOperationError extends IndexerSubsystemError {
  readonly code = 'INDEXER_STORE_OPERATION';

  constructor(operation: string, sqliteCode: string | undefined, init: ErrorInit = {}) {
    const hint = storeHint(sqliteCode);
    super(`Index database failed to ${operation}${sqliteCode ? ` (${sqliteCode})` : ''}`, {
      ...(hint === undefined ? {} : { hint }),
      ...init,
      context: { operation, sqliteCode, ...init.context },
    });
  }
}

function storeHint(sqliteCode: string | undefined): string | undefined {
  switch (sqliteCode) {
    case 'SQLITE_BUSY':
    case 'SQLITE_LOCKED':
      return 'Another process is using the index. Wait for it to finish, or open the store with a busy timeout.';
    case 'SQLITE_FULL':
      return 'The disk holding the index is full.';
    case 'SQLITE_READONLY':
      return 'The index is read-only; check permissions on the file and its directory.';
    default:
      return undefined;
  }
}

/** Something stored could not be read back, so the index needs rebuilding. */
export class StoreCorruptError extends IndexerSubsystemError {
  readonly code = 'INDEXER_STORE_CORRUPT';

  constructor(table: string, key: string, problem: string, init: ErrorInit = {}) {
    super(`Index database has an unreadable ${table} row (${key}): ${problem}`, {
      hint: 'Rebuild the index; nothing in it is the only copy of anything.',
      ...init,
      context: { table, key, problem, ...init.context },
    });
  }
}

/** The store was used after `close()`. */
export class StoreClosedError extends IndexerSubsystemError {
  readonly code = 'INDEXER_STORE_CLOSED';

  constructor(operation: string, init: ErrorInit = {}) {
    super(`Cannot ${operation}: the index database is closed`, {
      ...init,
      context: { operation, ...init.context },
    });
  }
}

/** `.code-lens/fragments.json` is unreadable or does not fit its schema. `location` is the field. */
export class FragmentManifestError extends IndexerSubsystemError {
  readonly code = 'INDEXER_FRAGMENT_MANIFEST';

  constructor(path: string, location: string, problem: string, init: ErrorInit = {}) {
    super(`Fragment manifest ${path} is invalid at ${location}: ${problem}`, {
      ...init,
      context: { path, location, problem, ...init.context },
    });
  }
}

/** Sharded storage cannot be opened or used as asked. */
export class ShardError extends IndexerSubsystemError {
  readonly code = 'INDEXER_SHARD';

  constructor(problem: string, init: ErrorInit = {}) {
    super(`Sharded index: ${problem}`, {
      ...init,
      context: { problem, ...init.context },
    });
  }
}
