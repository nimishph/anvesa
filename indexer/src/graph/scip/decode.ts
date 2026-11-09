import { ScipIndexError } from '../../errors.ts';

/**
 * Reads the parts of a SCIP index (https://github.com/sourcegraph/scip, `scip.proto`) that the
 * graph uses: each document's path, its occurrences, and the hover text of what it defines. A
 * small protobuf wire reader instead of a protobuf library, since only these fields are read and
 * anything else is skipped by wire type.
 *
 * Field numbers, from `scip.proto`:
 * - Index: documents = 2
 * - Document: relative_path = 1, occurrences = 2, symbols = 3
 * - Occurrence: range = 1 (packed int32), symbol = 2, symbol_roles = 3, enclosing_range = 7
 * - SymbolInformation: symbol = 1, documentation = 3 (repeated)
 */

/** Bits of `Occurrence.symbol_roles`. A reference is an occurrence without `definition`. */
export const SCIP_ROLE = {
  definition: 1,
  import: 2,
  writeAccess: 4,
  readAccess: 8,
  generated: 16,
  test: 32,
  forwardDefinition: 64,
} as const;

export interface ScipOccurrence {
  /** 0-based `[startLine, startCol, endCol]` or `[startLine, startCol, endLine, endCol]`. */
  readonly range: readonly number[];
  readonly symbol: string;
  readonly roles: number;
  readonly enclosingRange?: readonly number[];
}

export interface ScipSymbolInfo {
  readonly symbol: string;
  readonly documentation: readonly string[];
}

export interface ScipDocument {
  /** Relative to the project root, with `/` separators whatever the indexer's platform wrote. */
  readonly path: string;
  readonly occurrences: readonly ScipOccurrence[];
  readonly symbols: readonly ScipSymbolInfo[];
}

class Reader {
  #at = 0;
  readonly #bytes: Uint8Array;
  readonly #end: number;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.#bytes = bytes;
    this.#at = start;
    this.#end = end;
  }

  get done(): boolean {
    return this.#at >= this.#end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.#at >= this.#end) throw new ScipIndexError('it ends inside a number');
      const byte = this.#bytes[this.#at++] as number;
      // Beyond 2^53 a number loses precision; SCIP's numbers (lines, roles, lengths) never get there.
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new ScipIndexError('a number is malformed');
    }
  }

  /** A length-delimited field, as a reader over just its bytes. */
  sub(): Reader {
    const length = this.varint();
    const start = this.#at;
    this.#at += length;
    if (this.#at > this.#end) throw new ScipIndexError('it ends inside a field');
    return new Reader(this.#bytes, start, this.#at);
  }

  string(): string {
    const length = this.varint();
    const text = new TextDecoder().decode(this.#bytes.subarray(this.#at, this.#at + length));
    this.#at += length;
    return text;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.#at += 8;
    else if (wireType === 2) {
      // Read the length first: `#at += varint()` would add it to where the length started.
      const length = this.varint();
      this.#at += length;
    } else if (wireType === 5) this.#at += 4;
    else throw new ScipIndexError(`unsupported wire type ${wireType}`);
  }

  /** Packed int32s, or one unpacked value (both are valid encodings of a repeated int32). */
  int32s(wireType: number, into: number[]): void {
    if (wireType === 2) {
      const packed = this.sub();
      while (!packed.done) into.push(toInt32(packed.varint()));
    } else {
      into.push(toInt32(this.varint()));
    }
  }
}

const toInt32 = (value: number): number => (value > 0x7fffffff ? value - 2 ** 64 : value);

function occurrence(reader: Reader): ScipOccurrence {
  const range: number[] = [];
  const enclosing: number[] = [];
  let symbol = '';
  let roles = 0;
  while (!reader.done) {
    const key = reader.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 1) reader.int32s(wire, range);
    else if (field === 2) symbol = reader.string();
    else if (field === 3) roles = reader.varint();
    else if (field === 7) reader.int32s(wire, enclosing);
    else reader.skip(wire);
  }
  return { range, symbol, roles, ...(enclosing.length > 0 ? { enclosingRange: enclosing } : {}) };
}

function symbolInfo(reader: Reader): ScipSymbolInfo {
  let symbol = '';
  const documentation: string[] = [];
  while (!reader.done) {
    const key = reader.varint();
    const field = Math.floor(key / 8);
    if (field === 1) symbol = reader.string();
    else if (field === 3) documentation.push(reader.string());
    else reader.skip(key & 7);
  }
  return { symbol, documentation };
}

function document(reader: Reader): ScipDocument {
  let path = '';
  const occurrences: ScipOccurrence[] = [];
  const symbols: ScipSymbolInfo[] = [];
  while (!reader.done) {
    const key = reader.varint();
    const field = Math.floor(key / 8);
    if (field === 1) path = reader.string().replaceAll('\\', '/');
    else if (field === 2) occurrences.push(occurrence(reader.sub()));
    else if (field === 3) symbols.push(symbolInfo(reader.sub()));
    else reader.skip(key & 7);
  }
  return { path, occurrences, symbols };
}

/** The documents of a SCIP index. Metadata and external symbols are skipped. */
export function decodeScip(bytes: Uint8Array): ScipDocument[] {
  const reader = new Reader(bytes);
  const documents: ScipDocument[] = [];
  while (!reader.done) {
    const key = reader.varint();
    if (Math.floor(key / 8) === 2) documents.push(document(reader.sub()));
    else reader.skip(key & 7);
  }
  return documents;
}

/** The 0-based line an occurrence starts on. */
export const startLine = (occurrence: ScipOccurrence): number => occurrence.range[0] ?? 0;

/** The last descriptor's name: `npm pkg 1.0 src/`a.ts`/Cart#add().` gives `add`. */
export function descriptorName(symbol: string): string | undefined {
  const match = /([A-Za-z_$][\w$]*|`[^`]+`)(?:\(\)|#|\.|:)?\.?$/.exec(symbol);
  return match?.[1]?.replaceAll('`', '');
}
