import type { Trust } from '../card.ts';
import type { PoisonSettings, Profile } from './types.ts';

/**
 * What each trust level does about each built-in rule.
 *
 * Trust follows the content's source, not the code's: code you maintain is `first-party`, docs and
 * vendored text `third-party`, and anything an outsider can write into (issue text, run digests,
 * scraped pages) `untrusted`. Stricter profiles turn more findings into quarantines.
 *
 * A profile is only a table. A project or Sage can supply its own, or extend one with
 * `withRules`, and pass it to the gate.
 */

const LIGHT_POISON: PoisonSettings = {
  floodFactor: 50,
  floodAction: 'flag',
  outlierZ: 4,
  outlierMinCards: 8,
  outlierAction: 'flag',
};

const STANDARD_POISON: PoisonSettings = {
  floodFactor: 20,
  floodAction: 'flag',
  outlierZ: 3.5,
  outlierMinCards: 8,
  outlierAction: 'flag',
};

const STRICT_POISON: PoisonSettings = {
  floodFactor: 10,
  floodAction: 'quarantine',
  outlierZ: 3,
  outlierMinCards: 8,
  outlierAction: 'quarantine',
};

const light: Profile = {
  name: 'light',
  rules: {
    'invisible-characters': 'sanitize',
    'unicode-tag-characters': 'quarantine',
    'mixed-script-words': 'flag',
    'instruction-override': 'quarantine',
    'role-reassignment': 'flag',
    'chat-role-markers': 'quarantine',
    // Code that implements tool calling legitimately mentions the syntax.
    'tool-call-syntax': 'flag',
    'imperative-density': 'off',
    'hidden-markup': 'sanitize',
    'exfiltration-markup': 'sanitize',
    'encoded-blob': 'flag',
    'secret-material': 'sanitize',
  },
  fallback: { low: 'flag', medium: 'flag', high: 'quarantine' },
  poison: LIGHT_POISON,
};

const standard: Profile = {
  name: 'standard',
  rules: {
    'invisible-characters': 'sanitize',
    'unicode-tag-characters': 'quarantine',
    'mixed-script-words': 'quarantine',
    'instruction-override': 'quarantine',
    'role-reassignment': 'flag',
    'chat-role-markers': 'quarantine',
    'tool-call-syntax': 'quarantine',
    'imperative-density': 'flag',
    'hidden-markup': 'sanitize',
    'exfiltration-markup': 'sanitize',
    'encoded-blob': 'sanitize',
    'secret-material': 'sanitize',
  },
  fallback: { low: 'flag', medium: 'flag', high: 'quarantine' },
  poison: STANDARD_POISON,
};

const strict: Profile = {
  name: 'strict',
  rules: {
    'invisible-characters': 'sanitize',
    'unicode-tag-characters': 'quarantine',
    'mixed-script-words': 'quarantine',
    'instruction-override': 'quarantine',
    'role-reassignment': 'quarantine',
    'chat-role-markers': 'quarantine',
    'tool-call-syntax': 'quarantine',
    'imperative-density': 'flag',
    'hidden-markup': 'sanitize',
    'exfiltration-markup': 'sanitize',
    'encoded-blob': 'quarantine',
    'secret-material': 'sanitize',
  },
  fallback: { low: 'flag', medium: 'quarantine', high: 'quarantine' },
  poison: STRICT_POISON,
};

export function defaultProfiles(): Readonly<Record<Trust, Profile>> {
  return { 'first-party': light, 'third-party': standard, untrusted: strict };
}

/** A copy of `profile` that also handles `ruleActions`, e.g. for rules a project added. */
export function withRules(
  profile: Profile,
  ruleActions: Readonly<Record<string, Profile['rules'][string]>>,
): Profile {
  return { ...profile, rules: { ...profile.rules, ...ruleActions } };
}
