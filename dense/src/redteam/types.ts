import type { Card } from '../card.ts';

/** How dangerous a rule's finding is, before any profile decides what to do about it. */
export type Severity = 'low' | 'medium' | 'high';

/**
 * What the gate does about a finding.
 * - `flag`: keep the card, record the finding.
 * - `sanitize`: remove the offending text, keep the rest. Needs the rule to know how.
 * - `quarantine`: do not index the card; record why.
 */
export type Action = 'flag' | 'sanitize' | 'quarantine';

export type Category = 'injection' | 'obfuscation' | 'exfiltration' | 'secrets' | 'poisoning';

/** Character offsets into the scanned text: `start` inclusive, `end` exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface RuleHit {
  readonly span: Span;
  readonly message: string;
}

/**
 * One heuristic. Rules are plain data plus two functions, so a set can be built, extended or
 * replaced without touching the gate, for instance a list supplied by a project or by Sage.
 */
export interface Rule {
  readonly id: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly description: string;
  find(text: string): readonly RuleHit[];
  /**
   * Remove what `find` reported. A rule without this can flag or quarantine but never sanitize;
   * a profile that asks it to sanitize gets a quarantine instead.
   */
  sanitize?(text: string, hits: readonly RuleHit[]): string;
}

/** Where in a card a finding was made. */
export type Field = 'text' | 'source.path' | `attr:${string}`;

export interface Finding {
  readonly ruleId: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly field: Field;
  readonly span: Span;
  /** The matched text, or the start of it when it is long (see `excerptTruncated`). */
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
  readonly message: string;
  readonly action: Action;
}

export interface Removal {
  readonly ruleId: string;
  readonly field: Field;
  readonly text: string;
}

/** Thresholds for checks that look across cards instead of at one. */
export interface PoisonSettings {
  /**
   * A source producing more than `floodFactor` times the channel's typical number of cards is
   * suspicious. `null` turns the check off. It needs a baseline; without one it does not run.
   */
  readonly floodFactor: number | null;
  readonly floodAction: Action;
  /**
   * A card whose similarity to the batch centroid has a modified z-score above this. 3.5 is the
   * conventional cut-off; the score uses the median, so the outlier cannot hide by widening the spread.
   */
  readonly outlierZ: number | null;
  /** Fewer cards than this and the statistic means nothing, so the check does not run. */
  readonly outlierMinCards: number;
  readonly outlierAction: Action;
}

export interface Profile {
  readonly name: string;
  /** Action per rule id, or `off` to skip a rule entirely. */
  readonly rules: Readonly<Record<string, Action | 'off'>>;
  /** What to do for a rule the table above does not mention, by severity. */
  readonly fallback: Readonly<Record<Severity, Action>>;
  readonly poison: PoisonSettings;
}

export type Verdict = 'pass' | 'sanitize' | 'quarantine';

export interface ScreenResult {
  /** The card to index: unchanged, or with offending text removed. Present unless quarantined. */
  readonly card: Card;
  readonly verdict: Verdict;
  readonly findings: readonly Finding[];
  readonly removed: readonly Removal[];
}

export interface QuarantinedCard {
  readonly card: Card;
  readonly findings: readonly Finding[];
  /** Why, in words a `status` or `diagnose` command can print. */
  readonly reasons: readonly string[];
}

export interface BatchBaseline {
  /** Typical number of cards per source in this channel. */
  readonly cardsPerSource: number;
}

export interface BatchResult {
  readonly accepted: readonly Card[];
  readonly quarantined: readonly QuarantinedCard[];
  /** Cards dropped because an identical card from the same source came first. */
  readonly duplicates: readonly Card[];
  readonly sanitized: number;
  /** Every finding, on cards kept and dropped alike. */
  readonly findings: readonly Finding[];
}
