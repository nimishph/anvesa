import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source files must not hide characters from the people who review them. Zero-width and
 * bidirectional-control characters can make code read differently from how it runs, and Unicode
 * tag characters can carry a hidden message. This package builds a security screen for exactly
 * these, so its own files are held to it. The ranges below are numbers so this file contains none
 * of the characters itself.
 */

const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const isHidden = (codePoint: number) =>
  HIDDEN_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);

const workspace = join(import.meta.dir, '..');
const SOURCE = /\.(ts|json|cjs|grit|md)$/;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'probe' || entry.name.startsWith('__'))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE.test(entry.name)) files.push(path);
  }
  return files;
}

describe('source hygiene', () => {
  test('no file in the workspace contains hidden or bidirectional-control characters', () => {
    const offenders: string[] = [];
    const files = sourceFiles(workspace);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const char of text) {
        const codePoint = char.codePointAt(0) as number;
        if (isHidden(codePoint)) {
          offenders.push(
            `${file.slice(workspace.length + 1)}: U+${codePoint.toString(16).toUpperCase()}`,
          );
          break;
        }
      }
    }
    expect(files.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
