/**
 * The pattern loader: one tier's folder of pattern files, turned into specs. It reads one named
 * file for `run`, or every file at once for `list`, and knows nothing about other tiers; which tier
 * wins is the resolver's job (`resolver.ts`). Design: `docs/design/patterns.md`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
import { compilePattern, type PatternSpec } from '@cntxt-labs/anvesa-structural';

/** Where a pattern comes from, first tier first: a project's own, then the person's. */
export const PATTERN_TIERS = ['project', 'user'] as const;
export type PatternTier = (typeof PATTERN_TIERS)[number];

/**
 * A pattern's name, which is also its file's name (`<name>.json`): lowercase, so two files never
 * differ only by case, and nothing that reaches a path.
 */
export const PATTERN_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A pattern file's `$schema`, for completion and errors in an editor. */
export const PATTERN_SCHEMA_URL =
  'https://raw.githubusercontent.com/nimishph/anvesa/main/schemas/pattern.v1.json';

/** A pattern file that could not be used, and why. Never dropped silently. */
export interface InvalidPatternFile {
  readonly tier: PatternTier;
  readonly file: string;
  readonly code: string;
  readonly message: string;
}

export interface LoadedPattern {
  readonly tier: PatternTier;
  readonly file: string;
  /** Where the file is, as a person would open it. */
  readonly path: string;
  readonly spec: PatternSpec;
}

export interface TierInventory {
  readonly patterns: readonly LoadedPattern[];
  readonly invalid: readonly InvalidPatternFile[];
}

/** One tier's patterns. */
export interface PatternSource {
  readonly tier: PatternTier;
  /** What a person should be told to create: the folder, as they would write it. */
  readonly where: string;
  /** The pattern called `name`, undefined when this tier has none; throws when its file is invalid. */
  find(name: string): Promise<LoadedPattern | undefined>;
  /** Every pattern in this tier, and every file it could not use. */
  all(): Promise<TierInventory>;
}

/**
 * Check one pattern file's text and give its spec. `file` is its file name, whose stem must be the
 * pattern's name.
 */
export function parsePatternFile(text: string, file: string): PatternSpec {
  let parsed: PatternSpec;
  try {
    parsed = JSON.parse(text) as PatternSpec;
  } catch (failure) {
    throw new InvalidArgumentError('pattern file', 'valid JSON', file, { cause: failure });
  }
  if (!parsed || typeof parsed.name !== 'string' || !parsed.name || !parsed.target) {
    throw new InvalidArgumentError('pattern', 'an object with "name" and "target"', file);
  }
  if (typeof parsed.description !== 'string' || !parsed.description.trim()) {
    throw new InvalidArgumentError('pattern', 'a "description" saying what it finds', file);
  }
  const stem = file.replace(/\.json$/, '');
  if (parsed.name !== stem) {
    throw new InvalidArgumentError(
      'pattern',
      `the file name to be the pattern's name (rename it to ${parsed.name}.json, or set "name" to "${stem}")`,
      file,
    );
  }
  if (!PATTERN_NAME.test(parsed.name)) {
    throw new InvalidArgumentError(
      'pattern name',
      'lowercase letters, digits and "-", starting with a letter or digit',
      parsed.name,
    );
  }
  compilePattern(parsed);
  return parsed;
}

function invalidFile(tier: PatternTier, file: string, failure: unknown): InvalidPatternFile {
  const typed = toCodeLensError(failure, `load pattern ${file}`);
  return { tier, file, code: typed.code, message: typed.message };
}

function isMissing(failure: unknown): boolean {
  return (failure as { code?: unknown } | null)?.code === 'ENOENT';
}

/** A tier kept as a folder of `<name>.json` files. */
export class DirectoryPatternSource implements PatternSource {
  constructor(
    readonly tier: PatternTier,
    readonly directory: string,
    readonly where: string,
  ) {}

  async find(name: string): Promise<LoadedPattern | undefined> {
    // A name that could not be a file name is never looked up, so it never reaches a path.
    if (!PATTERN_NAME.test(name)) return undefined;
    const file = `${name}.json`;
    let text: string;
    try {
      text = await readFile(join(this.directory, file), 'utf8');
    } catch (failure) {
      if (isMissing(failure)) return undefined;
      throw toCodeLensError(failure, `load pattern ${file}`);
    }
    return {
      tier: this.tier,
      file,
      path: join(this.directory, file),
      spec: parsePatternFile(text, file),
    };
  }

  async all(): Promise<TierInventory> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (failure) {
      if (isMissing(failure)) return { patterns: [], invalid: [] };
      throw toCodeLensError(failure, `list patterns in ${this.where}`);
    }
    const files = names.filter((name) => name.endsWith('.json')).sort();
    // Read every file at once: serial reads were nearly all of `list`'s time.
    const outcomes = await Promise.all(
      files.map(async (file) => {
        try {
          const text = await readFile(join(this.directory, file), 'utf8');
          return { file, spec: parsePatternFile(text, file) };
        } catch (failure) {
          return { file, failure };
        }
      }),
    );
    const patterns: LoadedPattern[] = [];
    const invalid: InvalidPatternFile[] = [];
    for (const outcome of outcomes) {
      if ('spec' in outcome)
        patterns.push({
          tier: this.tier,
          file: outcome.file,
          path: join(this.directory, outcome.file),
          spec: outcome.spec,
        });
      else invalid.push(invalidFile(this.tier, outcome.file, outcome.failure));
    }
    return { patterns, invalid };
  }
}
