import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtinMappings } from '../structural/src/mapping.ts';

/**
 * The agent skill is what agents trust about anvesa, so it must not drift from what ships. It has
 * one source, skills/anvesa/SKILL.md; the npm package and the Claude Code plugin carry copies.
 */

const root = resolve(import.meta.dir, '..');
const skill = readFileSync(join(root, 'skills', 'anvesa', 'SKILL.md'), 'utf8');
const version = (
  JSON.parse(readFileSync(join(root, 'cli', 'package.json'), 'utf8')) as { version: string }
).version;

/** How the skill names a language, by the language ids mappings register. */
const NAMES: Readonly<Record<string, readonly string[]>> = {
  TypeScript: ['typescript', 'tsx'],
  JS: ['javascript'],
  Vue: ['vue'],
  Python: ['python'],
  PHP: ['php'],
  Go: ['go'],
  Rust: ['rust'],
  Java: ['java'],
  Ruby: ['ruby'],
  C: ['c'],
  'C++': ['cpp'],
};

describe('the agent skill', () => {
  test('has one source', () => {
    expect(existsSync(join(root, 'cli', 'skills', 'anvesa', 'SKILL.md'))).toBe(
      // Only the release copies it there; a checked-in copy would drift.
      false,
    );
  });

  test("states the package's version", () => {
    expect(/^version: "([^"]+)"$/m.exec(skill)?.[1]).toBe(version);
  });

  test('lists exactly the bundled mappings', () => {
    const line = /^Bundled mappings: (.+)\.$/m.exec(skill)?.[1] ?? '';
    const named = line.split(/[,/]/).map((n) => n.trim());
    const unknown = named.filter((n) => NAMES[n] === undefined);
    expect(unknown).toEqual([]);
    const listed = named.flatMap((n) => NAMES[n] ?? []).sort();
    const shipped = builtinMappings()
      .flatMap((entry) => entry.languages)
      .sort();
    expect(listed).toEqual(shipped);
  });
});
