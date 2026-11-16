/**
 * The pattern resolver: the tiers in order, and the only place that knows which one wins. `find`
 * asks each tier for one named file and stops at the first that has it; `inventory` lists them
 * all. Design: `docs/design/patterns.md`.
 */

import { join } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import type { PatternSpec } from '@cntxt-labs/anvesa-structural';
import {
  DirectoryPatternSource,
  type InvalidPatternFile,
  type LoadedPattern,
  type PatternSource,
} from './loader.ts';

export interface PatternInventory {
  readonly patterns: readonly PatternSpec[];
  readonly invalid: readonly InvalidPatternFile[];
}

export class PatternResolver {
  constructor(private readonly sources: readonly PatternSource[]) {}

  /** The pattern called `name`, from the first tier that has it. */
  async find(name: string): Promise<LoadedPattern> {
    for (const source of this.sources) {
      const found = await source.find(name);
      if (found) return found;
    }
    // Only a miss pays for the full listing, to say what there is.
    const { patterns } = await this.inventory();
    const where = this.sources.map((source) => source.where).join(' or ');
    throw new InvalidArgumentError(
      'name',
      patterns.length > 0
        ? `one of ${patterns.map((p) => p.name).join(', ')}`
        : `a pattern in ${where}<name>.json (there are none yet; see: anvesa primer patterns)`,
      name,
    );
  }

  /** Every usable pattern, by name, and every file that could not be used, with why. */
  async inventory(): Promise<PatternInventory> {
    const tiers = await Promise.all(this.sources.map((source) => source.all()));
    const seen = new Set<string>();
    const patterns: PatternSpec[] = [];
    for (const tier of tiers) {
      for (const { spec } of tier.patterns) {
        if (seen.has(spec.name)) continue;
        seen.add(spec.name);
        patterns.push(spec);
      }
    }
    patterns.sort((a, b) => a.name.localeCompare(b.name));
    const invalid = tiers.flatMap((tier) => tier.invalid);
    invalid.sort((a, b) => a.file.localeCompare(b.file));
    return { patterns, invalid };
  }
}

/** The project's patterns: `<root>/.anvesa/patterns/<name>.json`. */
export function projectPatterns(root: string): PatternResolver {
  return new PatternResolver([
    new DirectoryPatternSource('project', join(root, '.anvesa', 'patterns'), '.anvesa/patterns/'),
  ]);
}
