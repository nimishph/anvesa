import type { Card, Trust } from '../card.ts';
import { DefinitionInvalidError } from '../errors.ts';
import { dot, normalize } from '../vectors.ts';
import { defaultProfiles } from './profiles.ts';
import { defaultRules } from './rules.ts';
import type {
  Action,
  BatchBaseline,
  BatchResult,
  Field,
  Finding,
  Profile,
  QuarantinedCard,
  Removal,
  Rule,
  RuleHit,
  ScreenResult,
} from './types.ts';

export interface GateOptions {
  /** The rules to run. Defaults to the built-in set. */
  readonly rules?: readonly Rule[];
  /** Profiles to use in place of the built-in ones, per trust level. */
  readonly profiles?: Partial<Record<Trust, Profile>>;
}

/** Makes the median absolute deviation comparable to a standard deviation (Iglewicz and Hoaglin). */
const MODIFIED_Z_SCALE = 0.6745;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Width of the evidence quoted in a finding. Longer matches are cut and marked as cut. */
const EVIDENCE_WIDTH = 120;

/**
 * Screens cards before they are embedded, so nothing a model would later be shown as retrieved
 * context is instruction-shaped, hidden, or a credential.
 *
 * The gate knows nothing about specific rules or thresholds: those come from its rule list and
 * from the profile for each card's trust level.
 */
export class RedTeamGate {
  readonly rules: readonly Rule[];
  readonly #profiles: Readonly<Record<Trust, Profile>>;

  constructor(options: GateOptions = {}) {
    this.rules = options.rules ?? defaultRules();
    const seen = new Set<string>();
    for (const rule of this.rules) {
      if (seen.has(rule.id)) {
        throw new DefinitionInvalidError('red-team rules', `rule "${rule.id}"`, 'is defined twice');
      }
      seen.add(rule.id);
    }
    this.#profiles = { ...defaultProfiles(), ...options.profiles } as Record<Trust, Profile>;
  }

  profileFor(trust: Trust): Profile {
    return this.#profiles[trust];
  }

  /** Screen one card. */
  screen(card: Card): ScreenResult {
    const profile = this.profileFor(card.provenance.trust);
    const findings = this.#scan(fieldsOf(card), profile);
    if (findings.length === 0) return { card, verdict: 'pass', findings, removed: [] };

    if (findings.some((finding) => this.#mustQuarantine(finding))) {
      return { card, verdict: 'quarantine', findings, removed: [] };
    }
    if (!findings.some((finding) => finding.action === 'sanitize')) {
      return {
        card: withScreen(card, 'pass', findings),
        verdict: 'pass',
        findings,
        removed: [],
      };
    }

    const { fields, removed } = this.#sanitize(fieldsOf(card), findings, profile);
    const residual = this.#scan(fields, profile).filter(
      (finding) => finding.action === 'sanitize' || finding.action === 'quarantine',
    );
    const cleaned = rebuild(card, fields);
    if (residual.length > 0 || cleaned.text.trim() === '') {
      return { card, verdict: 'quarantine', findings: [...findings, ...residual], removed: [] };
    }
    return {
      card: withScreen(cleaned, 'sanitize', findings),
      verdict: 'sanitize',
      findings,
      removed,
    };
  }

  /**
   * Screen the cards from one source together. On top of screening each card it drops exact
   * duplicates and, given a baseline, notices a source that produced far more cards than is
   * usual for the channel.
   */
  screenBatch(
    cards: readonly Card[],
    options: { readonly baseline?: BatchBaseline } = {},
  ): BatchResult {
    const accepted: Card[] = [];
    const quarantined: QuarantinedCard[] = [];
    const duplicates: Card[] = [];
    const findings: Finding[] = [];
    let sanitized = 0;
    const seen = new Set<string>();

    for (const card of cards) {
      const result = this.screen(card);
      findings.push(...result.findings);
      if (result.verdict === 'quarantine') {
        quarantined.push(quarantine(card, result.findings));
        continue;
      }
      const key = `${result.card.source.path}\u0000${normalizeForCompare(result.card.text)}`;
      if (seen.has(key)) {
        duplicates.push(result.card);
        continue;
      }
      seen.add(key);
      if (result.verdict === 'sanitize') sanitized += 1;
      accepted.push(result.card);
    }

    const flood = this.#flood(accepted, options.baseline);
    findings.push(...flood.findings);
    quarantined.push(...flood.quarantined);
    return { accepted: flood.kept, quarantined, duplicates, sanitized, findings };
  }

  /**
   * After embedding: find cards whose vectors sit unusually close to the centre of the batch. A
   * card written to be near every query ("hubness") is a known way to poison a retriever. Needs
   * enough cards for the statistic to mean anything; below that it reports nothing.
   */
  screenVectors(
    cards: readonly Card[],
    vectors: readonly Float32Array[],
  ): {
    readonly kept: readonly boolean[];
    readonly quarantined: readonly QuarantinedCard[];
    readonly findings: readonly Finding[];
  } {
    if (cards.length !== vectors.length) {
      throw new DefinitionInvalidError('vector screen', 'vectors', 'must be one per card', {
        context: { cards: cards.length, vectors: vectors.length },
      });
    }
    const kept = cards.map(() => true);
    const quarantined: QuarantinedCard[] = [];
    const findings: Finding[] = [];
    if (cards.length === 0) return { kept, quarantined, findings };

    const unit = vectors.map(normalize);
    const centroid = new Float32Array((unit[0] as Float32Array).length);
    for (const vector of unit)
      for (let i = 0; i < centroid.length; i += 1)
        centroid[i] = (centroid[i] as number) + (vector[i] as number);
    const center = normalize(centroid);
    const sims = unit.map((vector) => dot(vector, center));
    // Modified z-score: measured against the median and the median absolute deviation, so the
    // outlier being looked for cannot hide by inflating the spread it is compared to.
    const middle = median(sims);
    const spread = median(sims.map((sim) => Math.abs(sim - middle)));

    cards.forEach((card, index) => {
      const poison = this.profileFor(card.provenance.trust).poison;
      if (poison.outlierZ === null || cards.length < poison.outlierMinCards || spread === 0) return;
      const z = (MODIFIED_Z_SCALE * ((sims[index] as number) - middle)) / spread;
      if (z <= poison.outlierZ) return;
      const finding = batchFinding(
        'vector-outlier',
        `Sits unusually close to the centre of its batch (modified z-score ${z.toFixed(1)}).`,
        poison.outlierAction,
      );
      findings.push(finding);
      if (poison.outlierAction === 'quarantine') {
        kept[index] = false;
        quarantined.push(quarantine(card, [finding]));
      }
    });
    return { kept, quarantined, findings };
  }

  // ---------------------------------------------------------------------------------------------

  #actionFor(rule: Rule, profile: Profile): Action | 'off' {
    return profile.rules[rule.id] ?? profile.fallback[rule.severity];
  }

  #scan(fields: readonly FieldValue[], profile: Profile): Finding[] {
    const findings: Finding[] = [];
    for (const rule of this.rules) {
      const action = this.#actionFor(rule, profile);
      if (action === 'off') continue;
      for (const { field, value } of fields) {
        for (const hit of rule.find(value))
          findings.push(toFinding(rule, field, value, hit, action));
      }
    }
    return findings;
  }

  /** Quarantine when the profile says so, or when asked to sanitize something that cannot be. */
  #mustQuarantine(finding: Finding): boolean {
    if (finding.action === 'quarantine') return true;
    if (finding.action !== 'sanitize') return false;
    const rule = this.rules.find((candidate) => candidate.id === finding.ruleId);
    return rule?.sanitize === undefined || finding.field === 'source.path';
  }

  #sanitize(
    fields: readonly FieldValue[],
    findings: readonly Finding[],
    profile: Profile,
  ): { fields: FieldValue[]; removed: Removal[] } {
    const removed: Removal[] = [];
    const out = fields.map((entry) => ({ ...entry }));
    for (const rule of this.rules) {
      if (this.#actionFor(rule, profile) !== 'sanitize' || rule.sanitize === undefined) continue;
      for (const entry of out) {
        if (!findings.some((f) => f.ruleId === rule.id && f.field === entry.field)) continue;
        const hits = rule.find(entry.value);
        if (hits.length === 0) continue;
        for (const hit of hits) {
          removed.push({
            ruleId: rule.id,
            field: entry.field,
            text: entry.value.slice(hit.span.start, hit.span.end),
          });
        }
        entry.value = rule.sanitize(entry.value, hits);
      }
    }
    return { fields: out, removed };
  }

  #flood(
    accepted: readonly Card[],
    baseline: BatchBaseline | undefined,
  ): { kept: Card[]; quarantined: QuarantinedCard[]; findings: Finding[] } {
    const kept: Card[] = [];
    const quarantined: QuarantinedCard[] = [];
    const findings: Finding[] = [];
    if (!baseline) return { kept: [...accepted], quarantined, findings };

    const perSource = new Map<string, number>();
    for (const card of accepted) {
      const { floodFactor, floodAction } = this.profileFor(card.provenance.trust).poison;
      const count = (perSource.get(card.source.path) ?? 0) + 1;
      perSource.set(card.source.path, count);
      const allowance =
        floodFactor === null
          ? Number.POSITIVE_INFINITY
          : floodFactor * Math.max(1, baseline.cardsPerSource);
      if (count <= allowance) {
        kept.push(card);
        continue;
      }
      const finding = batchFinding(
        'source-flood',
        `Source ${card.source.path} produced more than ${allowance} cards, ${floodFactor}x the channel's typical ${baseline.cardsPerSource}.`,
        floodAction,
      );
      if (count === Math.floor(allowance) + 1) findings.push(finding);
      if (floodAction === 'quarantine') quarantined.push(quarantine(card, [finding]));
      else kept.push(card);
    }
    return { kept, quarantined, findings };
  }
}

// --- helpers ------------------------------------------------------------------------------------

interface FieldValue {
  field: Field;
  value: string;
}

function fieldsOf(card: Card): FieldValue[] {
  return [
    { field: 'text', value: card.text },
    { field: 'source.path', value: card.source.path },
    ...Object.entries(card.attrs).map(([key, value]) => ({ field: `attr:${key}` as Field, value })),
  ];
}

/** Put possibly-sanitised fields back onto a card. The path is never rewritten. */
function rebuild(card: Card, fields: readonly FieldValue[]): Card {
  const attrs: Record<string, string> = { ...card.attrs };
  let text = card.text;
  for (const { field, value } of fields) {
    if (field === 'text') text = value;
    else if (field.startsWith('attr:')) attrs[field.slice('attr:'.length)] = value;
  }
  return { ...card, text, attrs };
}

function withScreen(card: Card, verdict: 'pass' | 'sanitize', findings: readonly Finding[]): Card {
  return { ...card, screen: { verdict, findings: [...new Set(findings.map((f) => f.ruleId))] } };
}

function toFinding(rule: Rule, field: Field, value: string, hit: RuleHit, action: Action): Finding {
  const matched = value.slice(hit.span.start, hit.span.end);
  const truncated = matched.length > EVIDENCE_WIDTH;
  return {
    ruleId: rule.id,
    category: rule.category,
    severity: rule.severity,
    field,
    span: hit.span,
    excerpt: truncated ? matched.slice(0, EVIDENCE_WIDTH) : matched,
    excerptTruncated: truncated,
    message: hit.message,
    action,
  };
}

function batchFinding(ruleId: string, message: string, action: Action): Finding {
  return {
    ruleId,
    category: 'poisoning',
    severity: 'medium',
    field: 'text',
    span: { start: 0, end: 0 },
    excerpt: '',
    excerptTruncated: false,
    message,
    action,
  };
}

function quarantine(card: Card, findings: readonly Finding[]): QuarantinedCard {
  const blocking = findings.filter((f) => f.action !== 'flag');
  const reasons = (blocking.length > 0 ? blocking : findings).map(
    (f) => `${f.ruleId}: ${f.message}`,
  );
  return { card, findings, reasons };
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
