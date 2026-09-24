import type { LinkSummary } from '../graph/index.ts';
import type { QuarantineReason } from '../store/index.ts';

/** Something a caller can show while a run is going. */
export type IndexEvent =
  | { readonly kind: 'started'; readonly interrupted: boolean }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly outcome: 'unchanged' | 'touched' | 'added' | 'modified' | 'quarantined';
      readonly reason?: QuarantineReason;
    }
  | { readonly kind: 'warning'; readonly message: string }
  | { readonly kind: 'linking'; readonly everything: boolean }
  | { readonly kind: 'finished'; readonly report: IndexReport };

export interface DenseReport {
  /** Files whose cards were rebuilt. */
  ingested: number;
  /** Files whose cards were already current. */
  current: number;
  cards: number;
  quarantinedCards: number;
  /** Files a channel failed on. Their previous cards were left in place. */
  failed: { path: string; channel: string; message: string }[];
}

/**
 * Everything a run did. Each source file the walk offered is in exactly one of `unchanged`,
 * `touched`, `added`, `modified`, `quarantined` or `stillQuarantined`, so the counts add up to
 * `seen`; files the walk did not offer are accounted for by `unsupported`, `outOfScope`,
 * `skippedLanguage` and `ignored`.
 */
export interface IndexReport {
  readonly complete: true;
  /** The previous run did not finish, so edges and cards were rebuilt instead of trusted. */
  readonly resumedAfterInterruption: boolean;
  /** The extractor or a mapping changed since these files were last read, so every file was read again. */
  readonly reextracted: boolean;
  readonly files: {
    readonly seen: number;
    /** Same size and modification time as last time: not read. */
    readonly unchanged: number;
    /** Read, found identical, timestamp updated. */
    readonly touched: number;
    readonly added: number;
    readonly modified: number;
    /** Newly quarantined this run. */
    readonly quarantined: number;
    /** Already quarantined and unchanged since. */
    readonly stillQuarantined: number;
    /** In the index but no longer in the workspace. */
    readonly removed: number;
    /** Excluded by the language filter. */
    readonly skippedLanguage: number;
    /** Extension -> files with no registered language. */
    readonly unsupported: ReadonlyMap<string, number>;
    readonly outOfScope: number;
    /** Files that disappeared or could not be examined between listing and stat. */
    readonly unreadable: readonly { path: string; message: string }[];
    /** Files hidden by ignore rules. */
    readonly ignored: number;
  };
  /** Files quarantined this run, and why. */
  readonly quarantined: readonly { path: string; reason: QuarantineReason; message: string }[];
  readonly link: LinkSummary | undefined;
  /** How many files were linked again. */
  readonly relinked: number;
  readonly dense: DenseReport | undefined;
  readonly elapsedMs: number;
  readonly warnings?: readonly string[];
}
