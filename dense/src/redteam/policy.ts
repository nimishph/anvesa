import { createHash } from 'node:crypto';
import type { Trust } from '../card.ts';
import { DefinitionInvalidError, DenseSubsystemError } from '../errors.ts';
import { RedTeamGate } from './gate.ts';
import { defaultProfiles } from './profiles.ts';
import { defaultRules, regexRule } from './rules.ts';
import type { Action, Category, Profile, Rule, Severity } from './types.ts';

/** A rule a project or a source of learned patterns adds, as data. */
export interface RuleSpec {
  readonly id: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly description: string;
  /** A regular expression (JavaScript syntax). */
  readonly pattern: string;
  /** Any of `i`, `m`, `s`. Matching is always Unicode-aware and global. */
  readonly flags?: string;
  readonly message: string;
  /** When present the rule can sanitize: each match is replaced with this. */
  readonly replacement?: string;
  /**
   * Text the rule must match and text it must not. A rule that is not shown to catch something and
   * to leave ordinary text alone is not accepted: the fixtures are how a reader can trust it.
   */
  readonly fixtures: { readonly attack: readonly string[]; readonly benign: readonly string[] };
}

type Table = Readonly<Record<string, Action | 'off'>>;

/** What a policy file says: rules to add, and what each trust level does about any rule. */
export interface RedTeamPolicy {
  /** Where it came from, for error messages and `redteam list`. */
  readonly source: string;
  readonly rules: readonly RuleSpec[];
  readonly actions: Readonly<Partial<Record<Trust, Table>>>;
  readonly fallback: Readonly<Partial<Record<Trust, Partial<Record<Severity, Action>>>>>;
}

/** A custom rule that does not do what its fixtures say it should. */
export class RuleFixtureError extends DenseSubsystemError {
  readonly code = 'DENSE_RULE_FIXTURE';

  constructor(
    ruleId: string,
    kind: 'attack' | 'benign',
    fixture: string,
    source: string,
    init: { readonly cause?: unknown } = {},
  ) {
    super(
      kind === 'attack'
        ? `Red-team rule "${ruleId}" (${source}) does not match its attack fixture ${JSON.stringify(fixture)}`
        : `Red-team rule "${ruleId}" (${source}) matches its benign fixture ${JSON.stringify(fixture)}`,
      { ...init, context: { ruleId, kind, fixture, source } },
    );
  }
}

const TRUSTS: readonly Trust[] = ['first-party', 'third-party', 'untrusted'];
const CATEGORIES: readonly Category[] = [
  'injection',
  'obfuscation',
  'exfiltration',
  'secrets',
  'poisoning',
];
const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high'];
const ACTIONS: readonly Action[] = ['flag', 'sanitize', 'quarantine'];
const RULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A quantified group that is itself quantified, `(a+)+` or `(a|aa)*`: the shape whose matching time
 * can explode on a near miss. A rule runs over every card of an index, so a pattern like that is
 * refused instead of being left to stall a run.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

/**
 * Check untrusted JSON (a project's file, or what a source of rules returned) and return a policy.
 * Every problem names the field it is in, and nothing is guessed: an unknown key is an error.
 */
export function parsePolicy(raw: unknown, source: string): RedTeamPolicy {
  const bad = (field: string, problem: string): never => {
    throw new DefinitionInvalidError(`red-team policy ${source}`, field, problem);
  };
  if (!isRecord(raw)) return bad('(root)', 'must be an object');
  for (const key of Object.keys(raw)) {
    if (!['rules', 'actions', 'fallback', 'sources'].includes(key))
      bad(key, 'is not a known field');
  }

  const rules: RuleSpec[] = [];
  const seen = new Set<string>();
  const list = raw.rules ?? [];
  if (!Array.isArray(list)) bad('rules', 'must be an array of rules');
  for (const [index, entry] of (list as unknown[]).entries()) {
    const at = (field: string) => `rules[${index}].${field}`;
    if (!isRecord(entry)) return bad(`rules[${index}]`, 'must be an object');
    for (const key of Object.keys(entry)) {
      if (
        ![
          'id',
          'category',
          'severity',
          'description',
          'pattern',
          'flags',
          'message',
          'replacement',
          'fixtures',
        ].includes(key)
      ) {
        bad(at(key), 'is not a known field');
      }
    }
    const text = (field: string, required = true): string | undefined => {
      const value = entry[field];
      if (value === undefined && !required) return undefined;
      if (typeof value !== 'string' || value === '')
        return bad(at(field), 'must be a non-empty string');
      return value;
    };
    const id = text('id') as string;
    if (!RULE_ID.test(id)) bad(at('id'), 'must be lowercase words joined by "-"');
    if (seen.has(id)) bad(at('id'), `"${id}" is defined twice in this file`);
    seen.add(id);
    if (!CATEGORIES.includes(entry.category as Category))
      bad(at('category'), `must be one of ${CATEGORIES.join(', ')}`);
    if (!SEVERITIES.includes(entry.severity as Severity))
      bad(at('severity'), `must be one of ${SEVERITIES.join(', ')}`);
    const flags = text('flags', false) ?? '';
    if (!/^[ims]*$/.test(flags) || new Set(flags).size !== flags.length) {
      bad(at('flags'), 'may hold each of i, m and s once');
    }
    const pattern = text('pattern') as string;
    try {
      new RegExp(pattern, `${flags}gu`);
    } catch (failure) {
      throw new DefinitionInvalidError(
        `red-team policy ${source}`,
        at('pattern'),
        'is not a valid regular expression',
        { cause: failure },
      );
    }
    if (NESTED_QUANTIFIER.test(pattern)) {
      bad(at('pattern'), 'repeats a repeated group, which can take exponential time on some text');
    }
    if (new RegExp(pattern, `${flags}u`).test('')) bad(at('pattern'), 'matches the empty string');
    const replacement = entry.replacement;
    if (replacement !== undefined && typeof replacement !== 'string')
      bad(at('replacement'), 'must be a string');

    const fixtures = entry.fixtures;
    if (!isRecord(fixtures))
      return bad(
        at('fixtures'),
        'must be { attack: [...], benign: [...] }: every rule shows what it catches and what it leaves alone',
      );
    const cases = (kind: 'attack' | 'benign'): string[] => {
      const cases = fixtures[kind];
      if (!Array.isArray(cases) || cases.length === 0 || cases.some((c) => typeof c !== 'string')) {
        return bad(at(`fixtures.${kind}`), 'must be a non-empty array of strings');
      }
      return cases as string[];
    };
    rules.push({
      id,
      category: entry.category as Category,
      severity: entry.severity as Severity,
      description: text('description', false) ?? id,
      pattern,
      ...(flags ? { flags } : {}),
      message: text('message', false) ?? `Matched red-team rule ${id}.`,
      ...(typeof replacement === 'string' ? { replacement } : {}),
      fixtures: { attack: cases('attack'), benign: cases('benign') },
    });
  }

  const actions: Partial<Record<Trust, Record<string, Action | 'off'>>> = {};
  if (raw.actions !== undefined) {
    if (!isRecord(raw.actions)) return bad('actions', 'must be an object keyed by trust level');
    for (const [trust, table] of Object.entries(raw.actions)) {
      if (!TRUSTS.includes(trust as Trust))
        bad(`actions.${trust}`, `must be one of ${TRUSTS.join(', ')}`);
      if (!isRecord(table))
        return bad(`actions.${trust}`, 'must be an object of rule id to action');
      const entries: Record<string, Action | 'off'> = {};
      for (const [rule, action] of Object.entries(table)) {
        if (action !== 'off' && !ACTIONS.includes(action as Action)) {
          bad(`actions.${trust}.${rule}`, `must be off or one of ${ACTIONS.join(', ')}`);
        }
        entries[rule] = action as Action | 'off';
      }
      actions[trust as Trust] = entries;
    }
  }

  const fallback: Partial<Record<Trust, Partial<Record<Severity, Action>>>> = {};
  if (raw.fallback !== undefined) {
    if (!isRecord(raw.fallback)) return bad('fallback', 'must be an object keyed by trust level');
    for (const [trust, table] of Object.entries(raw.fallback)) {
      if (!TRUSTS.includes(trust as Trust))
        bad(`fallback.${trust}`, `must be one of ${TRUSTS.join(', ')}`);
      if (!isRecord(table))
        return bad(`fallback.${trust}`, 'must be an object of severity to action');
      const entries: Partial<Record<Severity, Action>> = {};
      for (const [severity, action] of Object.entries(table)) {
        if (!SEVERITIES.includes(severity as Severity))
          bad(`fallback.${trust}.${severity}`, `must be one of ${SEVERITIES.join(', ')}`);
        if (!ACTIONS.includes(action as Action))
          bad(`fallback.${trust}.${severity}`, `must be one of ${ACTIONS.join(', ')}`);
        entries[severity as Severity] = action as Action;
      }
      fallback[trust as Trust] = entries;
    }
  }
  return { source, rules, actions, fallback };
}

/** A rule from its spec, once its fixtures have shown it does what it says. */
function compile(spec: RuleSpec, source: string): Rule {
  const rule = regexRule({
    id: spec.id,
    category: spec.category,
    severity: spec.severity,
    description: spec.description,
    pattern: new RegExp(spec.pattern, `${spec.flags ?? ''}gu`),
    message: spec.message,
    ...(spec.replacement === undefined ? {} : { replacement: spec.replacement }),
  });
  for (const fixture of spec.fixtures.attack) {
    if (rule.find(fixture).length === 0)
      throw new RuleFixtureError(spec.id, 'attack', fixture, source);
  }
  for (const fixture of spec.fixtures.benign) {
    if (rule.find(fixture).length > 0)
      throw new RuleFixtureError(spec.id, 'benign', fixture, source);
  }
  return rule;
}

/**
 * The gate a set of policies describes: the built-in rules, plus every policy's rules, with the
 * actions each policy sets for each trust level. A rule id may be defined once, across the built-in
 * rules and every policy; an action may only name a rule that exists. Later policies win over
 * earlier ones where they set the same action.
 */
export function gateFrom(
  policies: readonly RedTeamPolicy[],
  builtin: readonly Rule[] = defaultRules(),
): RedTeamGate {
  const rules: Rule[] = [...builtin];
  const owner = new Map<string, string>(builtin.map((rule) => [rule.id, 'the built-in rules']));
  for (const policy of policies) {
    for (const spec of policy.rules) {
      const previous = owner.get(spec.id);
      if (previous !== undefined) {
        throw new DefinitionInvalidError(
          `red-team policy ${policy.source}`,
          `rule "${spec.id}"`,
          `is already defined by ${previous}`,
        );
      }
      owner.set(spec.id, policy.source);
      rules.push(compile(spec, policy.source));
    }
  }

  const profiles: Partial<Record<Trust, Profile>> = {};
  const base = defaultProfiles();
  for (const trust of TRUSTS) {
    let profile = base[trust];
    for (const policy of policies) {
      const actions = policy.actions[trust];
      if (actions) {
        for (const id of Object.keys(actions)) {
          if (!owner.has(id)) {
            throw new DefinitionInvalidError(
              `red-team policy ${policy.source}`,
              `actions.${trust}.${id}`,
              `names no rule (known: ${[...owner.keys()].join(', ')})`,
            );
          }
        }
        profile = { ...profile, rules: { ...profile.rules, ...actions } };
      }
      const fallback = policy.fallback[trust];
      if (fallback) profile = { ...profile, fallback: { ...profile.fallback, ...fallback } };
    }
    profiles[trust] = profile;
  }
  // The rule specs are data, so hashing them sees what the compiled rules' closures hide.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        policies.map((policy) => [policy.source, policy.rules, policy.actions, policy.fallback]),
      ),
    )
    .digest('hex');
  return new RedTeamGate({ rules, profiles, fingerprint });
}
