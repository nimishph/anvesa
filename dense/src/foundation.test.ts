import { describe, expect, test } from 'bun:test';
import { Deadline, InvalidArgumentError, OperationAbortedError } from '@sutras/code-lens-core';
import { budgetFor, packCards, splitToFit, type TokenBudget } from './budget.ts';
import {
  type Card,
  type CardDraft,
  defineTransformer,
  inputFile,
  makeCard,
  makeCards,
  type Transformer,
  validateCard,
} from './card.ts';
import { ChannelRegistry } from './channel.ts';
import { embedAll } from './embedder.ts';
import {
  ChannelConflictError,
  ChannelNotFoundError,
  DefinitionInvalidError,
  EmbedFailedError,
} from './errors.ts';
import { MemoryVectorStore, topK } from './store.ts';
import { vectorStoreContract } from './store-contract.ts';
import { countTokens, seeded, wordEmbedder } from './test-support.ts';
import { decomposeIdentifier, decomposePath, normalizeDoc, splitSentences } from './text.ts';
import { normalize } from './vectors.ts';

const words = (text: string) => text.split(/\s+/).filter((w) => w.length > 0);
const budget = (maxTokens: number, count = words): TokenBudget => ({
  maxTokens,
  count: (text) => count(text).length,
});

describe('text', () => {
  test.each([
    ['resolveGrants', ['resolve', 'grants']],
    ['parseHTTPResponse', ['parse', 'http', 'response']],
    ['snake_case_name', ['snake', 'case', 'name']],
    ['SCREAMING_SNAKE', ['screaming', 'snake']],
    ['kebab-case', ['kebab', 'case']],
    ['App\\Http\\Controller', ['app', 'http', 'controller']],
    ['ns::inner::fn', ['ns', 'inner', 'fn']],
    ['$phpVar', ['php', 'var']],
    ['empty?', ['empty']],
    ['', []],
  ])('decomposeIdentifier(%s)', (input, expected) => {
    expect(decomposeIdentifier(input)).toEqual(expected);
  });

  test('decomposePath drops the extension and dot segments', () => {
    expect(decomposePath('./services/pipelineController.ts')).toEqual([
      'services',
      'pipeline',
      'controller',
    ]);
  });

  test('normalizeDoc strips markers and code fences but keeps prose and tagged prose', () => {
    const doc = `/**
 * Parses the input.
 * @param text the text to parse
 * \`\`\`ts
 * parse("x")
 * \`\`\`
 * @returns the tree
 */`;
    const out = normalizeDoc(doc);
    expect(out).toContain('Parses the input.');
    expect(out).toContain('the text to parse');
    expect(out).toContain('the tree');
    expect(out).not.toContain('@param');
    expect(out).not.toContain('parse("x")');
  });

  test('normalizeDoc handles line comments, docstrings and hash comments', () => {
    expect(normalizeDoc('// one\n// two')).toBe('one two');
    expect(normalizeDoc('"""Stores things."""')).toBe('Stores things.');
    expect(normalizeDoc('# note\n# more')).toBe('note more');
  });

  test('splitSentences keeps every character of the words', () => {
    const text = 'First one. Second one! Third? Fourth (with parens). End.';
    expect(splitSentences(text).join(' ')).toBe(text);
  });
});

describe('token budget', () => {
  test('budgetFor takes the encoder window less its special tokens', () => {
    const b = budgetFor({ maxTokens: 512, count: countTokens });
    expect(b.maxTokens).toBe(510);
    expect(budgetFor({ maxTokens: 512, specialTokens: 4, count: countTokens }).maxTokens).toBe(508);
  });

  test('a window smaller than its own special tokens is refused', () => {
    expect(() => budgetFor({ maxTokens: 2, count: countTokens })).toThrow(InvalidArgumentError);
  });

  test('text that fits is returned whole', () => {
    expect(splitToFit('one two three', budget(10))).toEqual(['one two three']);
    expect(splitToFit('   ', budget(10))).toEqual([]);
  });

  test('prefers paragraph boundaries, then sentences, then words', () => {
    const paragraphs = 'alpha beta gamma\n\ndelta epsilon zeta';
    expect(splitToFit(paragraphs, budget(3))).toEqual(['alpha beta gamma', 'delta epsilon zeta']);
    const sentences = 'One two three. Four five six. Seven eight nine.';
    expect(splitToFit(sentences, budget(6))).toEqual([
      'One two three. Four five six.',
      'Seven eight nine.',
    ]);
    expect(splitToFit('a b c d e f g', budget(3))).toEqual(['a b c', 'd e f', 'g']);
  });

  test('a single token longer than the window is split by characters, not dropped', () => {
    const chars = (text: string) => [...text];
    const pieces = splitToFit('abcdefghij', budget(4, chars));
    expect(pieces).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('property: pieces fit, and read in order they contain all of the text', () => {
    const random = seeded(7);
    const vocabulary = ['alpha', 'be', 'gamma', 'delta', 'ε', 'zetazetazeta', 'a', 'longerword'];
    for (let round = 0; round < 60; round += 1) {
      const paragraphs = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
        Array.from(
          { length: 2 + Math.floor(random() * 3) },
          () =>
            `${Array.from({ length: 2 + Math.floor(random() * 8) }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(' ')}.`,
        ).join(' '),
      ).join('\n\n');
      const limit = 3 + Math.floor(random() * 10);
      // A counter that is not simply additive: tokens are ceil(characters / 4).
      const quarters = (text: string) => ({ length: Math.ceil(text.length / 4) }) as string[];
      for (const counter of [words, quarters]) {
        const b = budget(limit, counter);
        const pieces = splitToFit(paragraphs, b);
        for (const piece of pieces) expect(b.count(piece)).toBeLessThanOrEqual(limit);
        expect(pieces.join('').replace(/\s/g, '')).toBe(paragraphs.replace(/\s/g, ''));
      }
    }
  });

  test('packCards repeats the head on every card and keeps blocks whole when they fit', () => {
    const b = budget(12);
    const { texts, headSplit } = packCards(
      'kind name — module m',
      [
        { text: 'first block of words here' },
        { text: 'second block of words here' },
        { text: 'sig(a)' },
      ],
      b,
    );
    expect(headSplit).toBe(false);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text.startsWith('kind name — module m')).toBe(true);
      expect(b.count(text)).toBeLessThanOrEqual(12);
    }
    const joined = texts.join('\n');
    for (const block of ['first block of words here', 'second block of words here', 'sig(a)']) {
      expect(joined).toContain(block);
    }
  });

  test('packCards splits a block that cannot fit any card, and loses nothing', () => {
    const b = budget(10);
    const doc = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const { texts } = packCards('head', [{ text: doc }], b);
    expect(texts.length).toBeGreaterThan(3);
    for (const text of texts) expect(b.count(text)).toBeLessThanOrEqual(10);
    const recovered = texts.flatMap((t) => words(t)).filter((w) => w !== 'head');
    expect(recovered).toEqual(words(doc));
  });

  test('a card with only a head is one card, and an oversize head is split and reported', () => {
    expect(packCards('just a head', [], budget(10)).texts).toEqual(['just a head']);
    const big = Array.from({ length: 30 }, (_, i) => `h${i}`).join(' ');
    const packed = packCards(big, [{ text: 'body' }], budget(10));
    expect(packed.headSplit).toBe(true);
    expect(packed.texts.length).toBeGreaterThan(1);
  });
});

const transformerFor = (over: Partial<Transformer> = {}): Transformer => ({
  name: 'demo',
  version: '1',
  channel: 'demo',
  categoryId: 'custom.demo',
  categoryLabel: 'Demo',
  trust: 'third-party',
  claim: () => true,
  transform: () => [],
  ...over,
});

describe('cards and transformers', () => {
  test('defineTransformer accepts a good definition and returns it', () => {
    const t = transformerFor();
    expect(defineTransformer(t)).toBe(t);
  });

  test.each([
    [{ name: 'Bad Name' }, 'name'],
    [{ channel: 'has space' }, 'channel'],
    [{ categoryId: 'Has.Caps' }, 'categoryId'],
    [{ categoryLabel: '  ' }, 'categoryLabel'],
    [{ version: '' }, 'version'],
    [{ trust: 'friendly' as never }, 'trust'],
    [{ claim: undefined as never }, 'claim'],
    [{ transform: 'x' as never }, 'transform'],
  ])('defineTransformer rejects %#, naming the field', (override, field) => {
    try {
      defineTransformer(transformerFor(override));
      throw new InvalidArgumentError('test', 'a failure', '');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(DefinitionInvalidError);
      expect((thrown as DefinitionInvalidError).context.field).toBe(field);
    }
  });

  test('makeCard completes a draft with ids, provenance, part and group', () => {
    const file = inputFile('docs/a.md', 'content');
    const card = makeCard(transformerFor(), file, {
      key: 'Guide/Install',
      text: 'hello',
      part: { index: 2, of: 3 },
      span: { startLine: 4, endLine: 9 },
    });
    expect(card.id).toBe('docs/a.md#Guide/Install~2');
    expect(card.channel).toBe('demo');
    expect(card.attrs).toMatchObject({ group: 'Guide/Install', part: '2', parts: '3' });
    expect(card.source).toEqual({
      path: 'docs/a.md',
      contentHash: file.hash,
      span: { startLine: 4, endLine: 9 },
    });
    expect(card.provenance).toEqual({
      transformer: 'demo',
      transformerVersion: '1',
      trust: 'third-party',
    });
  });

  test('inputFile hashes the content, so equal content has an equal hash', () => {
    expect(inputFile('a', 'x').hash).toBe(inputFile('b', 'x').hash);
    expect(inputFile('a', 'x').hash).not.toBe(inputFile('a', 'y').hash);
    expect(inputFile('a', 'x').hash).toHaveLength(64);
  });

  test('validateCard rejects blank text and a bad span, naming the card', () => {
    const file = inputFile('a.md', 'x');
    const good = makeCard(transformerFor(), file, { key: 'k', text: 'ok' });
    expect(() => validateCard({ ...good, text: '   ' })).toThrow(DefinitionInvalidError);
    expect(() =>
      validateCard({ ...good, source: { ...good.source, span: { startLine: 5, endLine: 2 } } }),
    ).toThrow(/source\.span/);
  });

  test('makeCards refuses two drafts with the same identity', () => {
    const drafts: CardDraft[] = [
      { key: 'same', text: 'one' },
      { key: 'same', text: 'two' },
    ];
    expect(() => makeCards(transformerFor(), inputFile('a.md', 'x'), drafts)).toThrow(
      /produced twice/,
    );
  });
});

describe('channels', () => {
  test('groups transformers by channel and finds those that claim a file', () => {
    const registry = new ChannelRegistry([
      transformerFor({
        name: 'md',
        channel: 'docs',
        categoryId: 'doc.x',
        claim: (f) => f.path.endsWith('.md'),
      }),
      transformerFor({
        name: 'ts',
        channel: 'code',
        categoryId: 'code.x',
        claim: (f) => f.path.endsWith('.ts'),
      }),
    ]);
    expect(registry.channels()).toEqual(['code', 'docs']);
    expect(registry.claimants(inputFile('a.md', '')).map((t) => t.name)).toEqual(['md']);
    expect(registry.claimants(inputFile('a.bin', ''))).toEqual([]);
  });

  test('two transformers may share a channel when they make the same category', () => {
    const registry = new ChannelRegistry();
    registry.register(transformerFor({ name: 'a' }));
    registry.register(transformerFor({ name: 'b' }));
    expect(registry.require('demo')).toHaveLength(2);
  });

  test('conflicts: a repeated name, or a channel mixing categories', () => {
    const registry = new ChannelRegistry([transformerFor()]);
    expect(() => registry.register(transformerFor())).toThrow(ChannelConflictError);
    expect(() =>
      registry.register(transformerFor({ name: 'other', categoryId: 'custom.other' })),
    ).toThrow(/holds category/);
  });

  test('an unknown channel is an error that lists the known ones', () => {
    try {
      new ChannelRegistry([transformerFor()]).require('nope');
      throw new InvalidArgumentError('test', 'a failure', '');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ChannelNotFoundError);
      expect((thrown as ChannelNotFoundError).hint).toContain('demo');
    }
  });

  test('unregister frees the names for reuse', () => {
    const registry = new ChannelRegistry([transformerFor()]);
    expect(registry.unregister('demo')).toBe(true);
    expect(registry.unregister('demo')).toBe(false);
    registry.register(transformerFor());
    expect(registry.has('demo')).toBe(true);
  });
});

describe('embedAll', () => {
  test('batches by the embedder preference and returns vectors in order', async () => {
    const batches: number[] = [];
    const embedder = wordEmbedder({
      preferredBatchSize: 3,
      onBatch: (b) => batches.push(b.length),
    });
    const vectors = await embedAll(embedder, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(batches).toEqual([3, 3, 1]);
    expect(vectors).toHaveLength(7);
  });

  test('without a preference the texts go in one call', async () => {
    const batches: number[] = [];
    await embedAll(wordEmbedder({ onBatch: (b) => batches.push(b.length) }), ['a', 'b', 'c']);
    expect(batches).toEqual([3]);
  });

  test('an empty input embeds nothing and calls nothing', async () => {
    const batches: number[] = [];
    expect(await embedAll(wordEmbedder({ onBatch: (b) => batches.push(b.length) }), [])).toEqual(
      [],
    );
    expect(batches).toEqual([]);
  });

  test.each([
    ['the wrong number of vectors', async () => [new Float32Array(4)]],
    ['the wrong dimensions', async (t: readonly string[]) => t.map(() => new Float32Array(3))],
    [
      'a non-finite value',
      async (t: readonly string[]) => t.map(() => new Float32Array([1, Number.NaN, 0, 0])),
    ],
  ])('a model returning %s is refused, not stored', async (_name, embed) => {
    const embedder = { ...wordEmbedder({ dimensions: 4 }), embed };
    await expect(embedAll(embedder, ['x', 'y'])).rejects.toBeInstanceOf(EmbedFailedError);
  });

  test('a model failure is wrapped with the cause and the batch that failed', async () => {
    const boom = new (class DriverError extends Error {})('gpu lost');
    const embedder = { ...wordEmbedder(), embed: async () => Promise.reject(boom) };
    const failure = await embedAll(embedder, ['x']).catch((e) => e);
    expect(failure).toBeInstanceOf(EmbedFailedError);
    expect(failure.context).toMatchObject({ batchStart: 0, batchSize: 1 });
    expect(failure.cause).toBeDefined();
  });

  test('a cancelled deadline stops before calling the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const batches: number[] = [];
    await expect(
      embedAll(wordEmbedder({ onBatch: (b) => batches.push(b.length) }), ['x'], {
        deadline: Deadline.of({ signal: controller.signal }),
      }),
    ).rejects.toBeInstanceOf(OperationAbortedError);
    expect(batches).toEqual([]);
  });
});

vectorStoreContract({ describe, test, expect }, 'memory', {
  make: () => new MemoryVectorStore(),
});

describe('top-k selection', () => {
  test('topK equals a full sort, including ties broken by id', () => {
    const random = seeded(3);
    const hits = Array.from({ length: 300 }, (_, i) => ({
      card: { id: `c${String(i).padStart(3, '0')}` } as unknown as Card,
      score: Math.round(random() * 20) / 20,
    }));
    for (const limit of [1, 5, 50, 300, 500]) {
      const expected = [...hits]
        .sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : 1))
        .slice(0, limit);
      expect(topK(hits, limit).map((h) => h.card.id)).toEqual(expected.map((h) => h.card.id));
    }
  });
});

describe('vectors', () => {
  test('normalize produces unit length and refuses a zero vector', () => {
    const unit = normalize(new Float32Array([3, 4]));
    expect(Math.hypot(...unit)).toBeCloseTo(1, 6);
    expect(() => normalize(new Float32Array(3))).toThrow(InvalidArgumentError);
  });
});
