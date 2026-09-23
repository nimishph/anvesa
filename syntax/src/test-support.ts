import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { InvariantViolationError } from '@cntxt-labs/anvesa-core';
import { builtinLanguages } from './languages.ts';
import { locateGrammar, npmPackageSource } from './sources.ts';

/** Test-only helpers. Not exported from the package. */

export interface TempDir {
  readonly path: string;
  cleanup(): Promise<void>;
}

export async function makeTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), 'anvesa-syntax-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Where the npm packages that ship real grammars are installed for tests. */
export const npmSource = npmPackageSource(import.meta.filename);

/** The real wasm bytes of a built-in grammar, read from its npm package. */
export async function grammarBytes(languageKey: string): Promise<Uint8Array> {
  const definition = builtinLanguages().find((language) => language.key === languageKey);
  if (!definition)
    throw new InvariantViolationError(`test setup: no built-in language ${languageKey}`);
  const located = await locateGrammar(languageKey, definition.grammar, [npmSource]);
  return new Uint8Array(await readFile(located.path));
}

const BLOCK = 512;

/** A gzipped ustar archive holding the given files, like `npm pack` produces. */
export function makeTarball(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const { name, data } of entries) {
    const header = new Uint8Array(BLOCK);
    const put = (offset: number, text: string) =>
      header.set(new TextEncoder().encode(text), offset);
    put(0, name);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, `${data.length.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, data, new Uint8Array((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.length;
  }
  return new Uint8Array(gzipSync(tar));
}
