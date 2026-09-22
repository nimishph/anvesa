import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { toCodeLensError } from '@cntxt-labs/code-lens-core';

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every WebAssembly module starts with `\0asm`. Anything else is not a grammar. */
export function looksLikeWasm(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Write a file so a reader never sees half of it: the bytes go to a sibling temp file first and
 * are renamed into place. A failed write leaves the destination untouched and the temp file
 * removed.
 */
export async function writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (writeFailure) {
    const failure = toCodeLensError(writeFailure, 'atomic write', { path });
    await rm(temp, { force: true });
    throw failure;
  }
}

/** True for "the file is not there", false never; every other I/O failure propagates. */
export function isNotFound(failure: unknown): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    'code' in failure &&
    (failure.code === 'ENOENT' || failure.code === 'ENOTDIR')
  );
}

/** The `code` of a Node system error (`EACCES`, `EISDIR`, ...) when there is one. */
export function systemCode(failure: unknown): string | undefined {
  if (typeof failure === 'object' && failure !== null && 'code' in failure) {
    return typeof failure.code === 'string' ? failure.code : undefined;
  }
  return undefined;
}
