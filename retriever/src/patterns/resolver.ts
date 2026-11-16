/**
 * The pattern resolver: the tiers in order, and the only place that knows which one wins. A
 * project's pattern shadows the person's pattern of the same name. `find` asks each tier for one
 * named file and stops at the first that has it, and `tier:name` asks only that tier, which is how
 * a shadowed pattern is still reached. Design: `docs/design/patterns.md`.
 */

import { join, sep } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import type { PatternSpec } from '@cntxt-labs/anvesa-structural';
import {
  DirectoryPatternSource,
  type InvalidPatternFile,
  type LoadedPattern,
  PATTERN_TIERS,
  type PatternSource,
  type PatternTier,
} from './loader.ts';

/** A pattern as `list` shows it: its spec, the tier it is in, and the tiers it hides. */
export type ListedPattern = PatternSpec & {
  readonly tier: PatternTier;
  /** Lower tiers with a pattern of the same name, which `tier:name` still reaches. */
  readonly shadows?: readonly PatternTier[];
};

export interface PatternInventory {
  readonly patterns: readonly ListedPattern[];
  readonly invalid: readonly InvalidPatternFile[];
}

function isTier(value: string): value is PatternTier {
  return (PATTERN_TIERS as readonly string[]).includes(value);
}

export class PatternResolver {
  constructor(private readonly sources: readonly PatternSource[]) {}

  /** The pattern called `name` from the first tier that has it, or from one tier: `user:name`. */
  async find(reference: string): Promise<LoadedPattern> {
    const colon = reference.indexOf(':');
    const tier = colon < 0 ? undefined : reference.slice(0, colon);
    const name = colon < 0 ? reference : reference.slice(colon + 1);
    if (tier !== undefined && !isTier(tier)) {
      throw new InvalidArgumentError(
        'pattern tier',
        `one of ${PATTERN_TIERS.join(', ')}, as in user:${name}`,
        tier,
      );
    }
    const asked = tier === undefined ? this.sources : this.sources.filter((s) => s.tier === tier);
    for (const source of asked) {
      const found = await source.find(name);
      if (found) return found;
    }
    // Only a miss pays for the full listing, to say what there is.
    const { patterns } = await this.inventory();
    const known = patterns.filter(
      (p) => tier === undefined || p.tier === tier || p.shadows?.includes(tier),
    );
    const where = asked.map((source) => `${source.where}<name>.json`).join(' or ');
    throw new InvalidArgumentError(
      'name',
      known.length > 0
        ? `one of ${known.map((p) => (tier === undefined ? p.name : `${tier}:${p.name}`)).join(', ')}`
        : `a pattern in ${where} (there are none yet; see: anvesa primer patterns)`,
      reference,
    );
  }

  /** Every usable pattern, once per name with the tiers it shadows, and every file that is not. */
  async inventory(): Promise<PatternInventory> {
    const tiers = await Promise.all(this.sources.map((source) => source.all()));
    const byName = new Map<
      string,
      { spec: PatternSpec; tier: PatternTier; shadows: PatternTier[] }
    >();
    for (const tier of tiers) {
      for (const { spec, tier: from } of tier.patterns) {
        const first = byName.get(spec.name);
        if (first) first.shadows.push(from);
        else byName.set(spec.name, { spec, tier: from, shadows: [] });
      }
    }
    const patterns: ListedPattern[] = [...byName.values()]
      .map(({ spec, tier, shadows }) => ({
        ...spec,
        tier,
        ...(shadows.length > 0 ? { shadows } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const invalid = tiers
      .flatMap((tier) => tier.invalid)
      .sort((a, b) => a.tier.localeCompare(b.tier) || a.file.localeCompare(b.file));
    return { patterns, invalid };
  }
}

/** The project's patterns, then the person's: `.anvesa/patterns/`, then `<home>/patterns/`. */
export function standardPatterns(root: string, home: string): PatternResolver {
  return new PatternResolver([
    new DirectoryPatternSource('project', join(root, '.anvesa', 'patterns'), '.anvesa/patterns/'),
    new DirectoryPatternSource('user', join(home, 'patterns'), `${join(home, 'patterns')}${sep}`),
  ]);
}

/** Only the project's patterns: `<root>/.anvesa/patterns/<name>.json`. */
export function projectPatterns(root: string): PatternResolver {
  return new PatternResolver([
    new DirectoryPatternSource('project', join(root, '.anvesa', 'patterns'), '.anvesa/patterns/'),
  ]);
}
