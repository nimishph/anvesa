import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Charsmap } from './charsmap.ts';
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
  test('a model type it does not know, or a part it cannot reproduce, is named', () => {
    const unknownModel = JSON.stringify({ model: { type: 'WordLevel', vocab: {} } });
    try {
      tokenizerFromJson(unknownModel, 'model.json');
      throw new TokenizerInvalidError('x', 'x', 'expected a failure');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(TokenizerInvalidError);
      expect((thrown as TokenizerInvalidError).context.location).toBe('model.type');
    }
    const other = JSON.stringify({
      normalizer: { type: 'NFKC' },
      model: { type: 'WordPiece', vocab: {} },
    });
    expect(() => tokenizerFromJson(other, 'n.json')).toThrow(/normalizer\.type/);

    const bpe = (extra: object) =>
      JSON.stringify({
        pre_tokenizer: { type: 'ByteLevel' },
        ...extra,
        model: { type: 'BPE', vocab: { a: 0 }, merges: [] },
      });
    expect(() => tokenizerFromJson(bpe({ normalizer: { type: 'BertNormalizer' } }), 'b')).toThrow(
      /normalizer\.type/,
    );
    expect(() => tokenizerFromJson(bpe({ post_processor: { type: 'Mystery' } }), 'b')).toThrow(
      /post_processor\.type/,
    );
    expect(() =>
      tokenizerFromJson(
        JSON.stringify({ model: { type: 'BPE', vocab: {}, merges: [] } }),
        'no-pre.json',
      ),
    ).toThrow(/byte-level/);
    expect(() =>
      tokenizerFromJson(bpe({ added_tokens: [{ id: 1, content: 'x', special: false }] }), 'b'),
    ).toThrow(/added_tokens/);
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

describe('byte-level BPE and SentencePiece unigram against the reference implementation', () => {
  // Trained on this repository's text with Hugging Face `tokenizers` (see
  // scripts/make-tokenizer-fixtures.py); the ids are what the reference gave for each text, and the
  // same code was also compared on 1500 real source lines against RoBERTa, CodeT5+, Jina code and
  // multilingual E5 with no difference.
  for (const name of ['bpe', 'unigram', 'unigram-precompiled']) {
    const tokenizer = tokenizerFromJson(fixture(`${name}.tokenizer.json`), `${name} fixture`);
    const rows = JSON.parse(fixture(`${name}.golden.json`)) as {
      text: string;
      ids: number[];
      bare: number;
    }[];
    test(`${name}: every text gets the reference's ids and count`, () => {
      const wrong = rows.filter(
        (row) =>
          JSON.stringify(tokenizer.encode(row.text)) !== JSON.stringify(row.ids) ||
          tokenizer.count(row.text) !== row.bare,
      );
      expect(wrong.map((row) => row.text)).toEqual([]);
      expect(rows.length).toBeGreaterThan(100);
    });

    test(`${name}: literal special tokens in a text are ordinary text`, () => {
      const bare = tokenizer.encode('');
      const withLiteral = tokenizer.encode('a <s> b </s> c');
      const inner = withLiteral.slice(
        tokenizer.specialTokens / 2,
        withLiteral.length - tokenizer.specialTokens / 2,
      );
      expect(inner.length).toBeGreaterThan(3);
      expect(inner.filter((id) => bare.includes(id))).toEqual([]);
    });
  }

  test('the frame around a text is what the post-processor says, and padding is found', () => {
    const bpe = tokenizerFromJson(fixture('bpe.tokenizer.json'), 'bpe');
    expect(bpe.specialTokens).toBe(2);
    expect(bpe.encode('x')[0]).not.toBe(bpe.padId);
    const unigram = tokenizerFromJson(fixture('unigram.tokenizer.json'), 'unigram');
    expect(unigram.encode('').length).toBe(2);
    expect(unigram.vocabSize).toBeGreaterThan(100);
  });

  test('a very long word with no spaces is merged without quadratic work', () => {
    const bpe = tokenizerFromJson(fixture('bpe.tokenizer.json'), 'bpe');
    const started = performance.now();
    const ids = bpe.tokenize('ab'.repeat(200_000));
    expect(ids.length).toBeGreaterThan(1000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('the precompiled normalisation table', () => {
  const json = JSON.parse(fixture('unigram-precompiled.tokenizer.json')) as {
    normalizer: { normalizers: { precompiled_charsmap: string }[] };
  };
  const charsmap = Charsmap.fromBase64(
    json.normalizer.normalizers[0]?.precompiled_charsmap as string,
    'fixture',
  );

  test('folds compatibility characters, controls and whitespace as SentencePiece does', () => {
    expect(charsmap.normalize('ｆｕｌｌ ＴＥＸＴ ①②')).toBe('full TEXT 12');
    expect(charsmap.normalize('ﬁnance')).toBe('finance');
    // Built from code points, so the source file itself holds no invisible characters.
    const nbsp = String.fromCodePoint(0xa0);
    const nul = String.fromCodePoint(0);
    const zeroWidth = String.fromCodePoint(0x200b);
    expect(charsmap.normalize(`a${nbsp}b	c`)).toBe('a b c');
    // A zero-width space is replaced by a space; a NUL is left for the pre-tokenizer to deal with.
    expect(charsmap.normalize(`x${nul}y${zeroWidth}z`)).toBe(`x${nul}y z`);
    expect(charsmap.normalize('plain text')).toBe('plain text');
  });

  test('a table that does not fit its own header is refused', () => {
    expect(() => Charsmap.fromBase64('AAAA', 'bad')).toThrow(TokenizerInvalidError);
    expect(() =>
      Charsmap.fromBase64(Buffer.from([255, 255, 0, 0, 1]).toString('base64'), 'bad'),
    ).toThrow(/trie size/);
  });
});
