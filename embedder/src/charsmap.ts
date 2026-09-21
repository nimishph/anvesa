import { TokenizerInvalidError } from './errors.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * SentencePiece's precompiled normalisation table: a double-array trie (darts-clone layout) from a
 * character sequence to its replacement, and a blob of zero-terminated replacements. It is how
 * XLM-R and its relatives fold compatibility characters, control characters and runs of
 * whitespace before a text is split.
 */
export class Charsmap {
  readonly #units: Uint32Array;
  readonly #normalized: Uint8Array;
  readonly #segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  private constructor(units: Uint32Array, normalized: Uint8Array) {
    this.#units = units;
    this.#normalized = normalized;
  }

  /** `bytes` = 4-byte little-endian trie size in bytes, the trie's units, then the replacements. */
  static fromBase64(encoded: string, source: string): Charsmap {
    const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
    if (bytes.length < 4) throw new TokenizerInvalidError(source, 'charsmap', 'it is too short');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const trieBytes = view.getUint32(0, true);
    if (trieBytes % 4 !== 0 || 4 + trieBytes > bytes.length) {
      throw new TokenizerInvalidError(source, 'charsmap', 'its trie size does not fit the data');
    }
    const units = new Uint32Array(trieBytes / 4);
    for (let i = 0; i < units.length; i += 1) units[i] = view.getUint32(4 + i * 4, true);
    return new Charsmap(units, bytes.subarray(4 + trieBytes));
  }

  /** The values of every key that is a prefix of `key`, shortest first. */
  #prefixes(key: Uint8Array): number[] {
    const units = this.#units;
    const found: number[] = [];
    const offset = (unit: number): number => (unit >>> 10) << ((unit & 0x200) >>> 6);
    let node = 0;
    let unit = units[node] as number;
    node ^= offset(unit);
    for (const byte of key) {
      node ^= byte;
      unit = units[node] as number;
      if (unit === undefined || (unit & 0x800000ff) >>> 0 !== byte) return found;
      node ^= offset(unit);
      if ((unit >>> 8) & 1) found.push((units[node] as number) & 0x7fffffff);
    }
    return found;
  }

  #replacement(chunk: string): Uint8Array | undefined {
    const matches = this.#prefixes(encoder.encode(chunk));
    const start = matches[0];
    if (start === undefined) return undefined;
    let end = start;
    while (end < this.#normalized.length && this.#normalized[end] !== 0) end += 1;
    return this.#normalized.subarray(start, end);
  }

  /**
   * Replace each character (or, when a whole grapheme is short, the grapheme) that has an entry.
   * Text without an entry is kept as it is.
   */
  normalize(text: string): string {
    const parts: Uint8Array[] = [];
    for (const { segment } of this.#segmenter.segment(text)) {
      if (encoder.encode(segment).length < 6) {
        const whole = this.#replacement(segment);
        if (whole) {
          parts.push(whole);
          continue;
        }
      }
      for (const char of segment) parts.push(this.#replacement(char) ?? encoder.encode(char));
    }
    return decoder.decode(Buffer.concat(parts));
  }
}
