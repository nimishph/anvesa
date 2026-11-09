import { describe, expect, test } from 'bun:test';
import { ScipIndexError } from '../../errors.ts';
import { decodeScip, descriptorName, SCIP_ROLE } from './decode.ts';

// A protobuf writer just big enough to build SCIP indexes by hand.
const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
};
const field = (number: number, wire: number): number[] => varint(number * 8 + wire);
const bytes = (number: number, body: readonly number[]): number[] => [
  ...field(number, 2),
  ...varint(body.length),
  ...body,
];
const text = (number: number, value: string): number[] =>
  bytes(number, [...new TextEncoder().encode(value)]);
const int = (number: number, value: number): number[] => [...field(number, 0), ...varint(value)];
const packed = (number: number, values: readonly number[]): number[] =>
  bytes(number, values.flatMap(varint));

const SYMBOL = 'scip-typescript npm shop 1.0.0 src/`cart.ts`/addItem().';

function index(): Uint8Array {
  const definition = [...packed(1, [4, 16, 23]), ...text(2, SYMBOL), ...int(3, 1)];
  const reference = [...packed(1, [9, 2, 9]), ...text(2, SYMBOL), ...packed(7, [8, 0, 10, 1])];
  const info = [...text(1, SYMBOL), ...text(3, 'function addItem(id: string): void')];
  const document = [
    ...text(4, 'TypeScript'), // language, not read
    ...text(1, 'src\\cart.ts'),
    ...bytes(2, definition),
    ...bytes(2, reference),
    ...bytes(3, info),
    ...int(9, 7), // a field this reader does not know
  ];
  return new Uint8Array([...bytes(1, text(1, 'metadata')), ...bytes(2, document)]);
}

describe('decoding a SCIP index', () => {
  test('documents, their occurrences and their hover text, with `/` paths', () => {
    const [document] = decodeScip(index());
    expect(document?.path).toBe('src/cart.ts');
    expect(document?.occurrences).toEqual([
      { range: [4, 16, 23], symbol: SYMBOL, roles: SCIP_ROLE.definition },
      { range: [9, 2, 9], symbol: SYMBOL, roles: 0, enclosingRange: [8, 0, 10, 1] },
    ]);
    expect(document?.symbols).toEqual([
      { symbol: SYMBOL, documentation: ['function addItem(id: string): void'] },
    ]);
  });

  test('a reference is an occurrence without the definition bit: SCIP has no reference role', () => {
    const [, reference] = decodeScip(index())[0]?.occurrences ?? [];
    expect((reference?.roles ?? -1) & SCIP_ROLE.definition).toBe(0);
    expect(SCIP_ROLE.import).toBe(2);
  });

  test('a truncated index is refused, not half read', () => {
    const whole = index();
    expect(() => decodeScip(whole.subarray(0, whole.length - 5))).toThrow(ScipIndexError);
  });

  test('the name of the last descriptor', () => {
    expect(descriptorName(SYMBOL)).toBe('addItem');
    expect(descriptorName('scip-typescript npm shop 1.0.0 src/`cart.ts`/Cart#')).toBe('Cart');
    expect(descriptorName('scip-typescript npm shop 1.0.0 src/`cart.ts`/Cart#items.')).toBe(
      'items',
    );
  });
});
