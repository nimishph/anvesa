import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deadline } from '@sutras/code-lens-core';
import { SourceReadError } from '../errors.ts';

/**
 * How much of a file is checked for a NUL byte to decide it is binary. This is git's own rule
 * (it looks at the first 8000 bytes), chosen so the indexer and git agree on what is text.
 */
export const BINARY_SNIFF_BYTES = 8000;

export type SourceContent =
  | {
      readonly kind: 'text';
      readonly content: string;
      /** SHA-256 of the raw bytes, hex. Identifies the exact version of the file. */
      readonly hash: string;
      readonly bytes: number;
      /** The bytes were not valid in their encoding, so some characters were replaced. */
      readonly lossy: boolean;
      readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
    }
  | { readonly kind: 'binary'; readonly bytes: number };

/**
 * Read a source file for indexing. There is no size limit here: a file's size is not, by itself, a
 * reason to leave it out. A caller that must bound the work bounds it with a `Deadline` on the
 * parse, and reports what it skipped.
 */
export async function readSource(
  root: string,
  path: string,
  options: { readonly deadline?: Deadline } = {},
): Promise<SourceContent> {
  options.deadline?.throwIfExpired(`read ${path}`);
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, path));
  } catch (failure) {
    throw new SourceReadError(path, { cause: failure });
  }

  const encoding = byteOrderMark(bytes);
  if (encoding === undefined && hasNul(bytes)) return { kind: 'binary', bytes: bytes.length };

  const hash = createHash('sha256').update(bytes).digest('hex');
  const label = encoding ?? 'utf-8';
  let lossy = false;
  let content: string;
  try {
    content = new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    // Not valid in its encoding: decode anyway, replacing what cannot be read, and say so.
    lossy = true;
    content = new TextDecoder(label).decode(bytes);
  }
  return { kind: 'text', content, hash, bytes: bytes.length, lossy, encoding: label };
}

function hasNul(bytes: Uint8Array): boolean {
  const end = Math.min(BINARY_SNIFF_BYTES, bytes.length);
  return bytes.subarray(0, end).includes(0);
}

/** UTF-16 text is full of NUL bytes, so it is recognised by its byte-order mark first. */
function byteOrderMark(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return undefined;
}
