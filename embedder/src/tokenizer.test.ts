import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TokenizerInvalidError } from './errors.ts';
import { tokenizerFromJson, tokenizerFromVocabulary } from './tokenizer.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

interface Golden {
  readonly text: string;
  readonly ids: readonly number[];
}
const golden = JSON.parse(fixture('wordpiece-golden.json')) as Record<string, Golden[]>;

describe('WordPiece against the reference implementation', () => {
  // The fixtures were produced by Hugging Face `tokenizers` (Rust), on vocabularies trained for
  // the purpose: every case below is an id sequence that implementation gave for the same text.
  for (const variant of ['uncased', 'cased'] as const) {
    const tokenizer = tokenizerFromJson(fixture(`${variant}.tokenizer.json`), `${variant} fixture`);
    test.each(golden[variant] as Golden[])(`${variant}: $text`, ({ text, ids }) => {
      expect(tokenizer.encode(text)).toEqual([...ids]);
    });
  }

  test('count is the length of the text alone, without the special tokens', () => {
    const tokenizer = tokenizerFromJson(fixture('uncased.tokenizer.json'), 'uncased fixture');
    for (const { text, ids } of golden.uncased as Golden[]) {
      expect(tokenizer.count(text)).toBe(ids.length - tokenizer.specialTokens);
    }
  });
});

describe('special tokens in the text', () => {
  test('literal [SEP] or [CLS] is ordinary text, so a file cannot change how its card is read', () => {
    const tokenizer = tokenizerFromJson(fixture('uncased.tokenizer.json'), 'uncased fixture');
    const [cls, ...rest] = tokenizer.encode('[SEP] [CLS] [MASK]');
    const inner = rest.slice(0, rest.length - 1);
    expect(cls).toBe(tokenizer.encode('')[0]);
    // The reference treats them as special ids; here they are brackets and words.
    expect(inner.length).toBeGreaterThan(3);
    expect(inner).not.toContain(tokenizer.encode('')[0] as number);
  });
});

describe('loading', () => {
  test('a file that is not a WordPiece tokenizer says which part is unsupported', () => {
    const bpe = JSON.stringify({ model: { type: 'BPE', vocab: {} } });
    expect(() => tokenizerFromJson(bpe, 'model.json')).toThrow(TokenizerInvalidError);
    try {
      tokenizerFromJson(bpe, 'model.json');
    } catch (thrown) {
      expect((thrown as TokenizerInvalidError).context.location).toBe('model.type');
    }
    const other = JSON.stringify({
      normalizer: { type: 'NFKC' },
      model: { type: 'WordPiece', vocab: {} },
    });
    expect(() => tokenizerFromJson(other, 'n.json')).toThrow(/normalizer\.type/);
  });

  test('invalid JSON keeps its cause', () => {
    try {
      tokenizerFromJson('{oops', 'bad.json');
      throw new TokenizerInvalidError('x', 'x', 'expected a failure');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(TokenizerInvalidError);
      expect((thrown as TokenizerInvalidError).cause).toBeDefined();
    }
  });

  test('a vocabulary without the tokens the model needs is refused', () => {
    expect(() => tokenizerFromVocabulary('hello\nworld', 'vocab.txt', { lowercase: true })).toThrow(
      /classification/,
    );
  });

  test('a vocab.txt works: one token per line, line number is the id', () => {
    const text = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', 'wor', '##ld', ''].join('\n');
    const tokenizer = tokenizerFromVocabulary(text, 'vocab.txt', { lowercase: true });
    expect(tokenizer.encode('Hello world')).toEqual([2, 4, 5, 6, 3]);
    expect(tokenizer.encode('zzz')).toEqual([2, 1, 3]);
    expect(tokenizer.vocabSize).toBe(7);
  });
});
