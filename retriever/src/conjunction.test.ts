import { describe, expect, test } from 'bun:test';
import type { Card } from '@cntxt-labs/anvesa-dense';
import type { WNode, WqlHit } from '@cntxt-labs/anvesa-structural';
import { buildWqlMatcher, findMatchingCard, splitConjunction } from './conjunction.ts';

describe('splitConjunction', () => {
  test('explicit options take precedence', () => {
    expect(splitConjunction('search query', '//function', undefined)).toEqual({
      semantic: 'search query',
      wql: '//function',
    });
    expect(splitConjunction('//function', undefined, 'semantic intent')).toEqual({
      semantic: 'semantic intent',
      wql: '//function',
    });
  });

  test('inline && splits semantic and WQL both ways', () => {
    expect(splitConjunction('payment processing && //class//method')).toEqual({
      semantic: 'payment processing',
      wql: '//class//method',
    });
    expect(splitConjunction('//function[@declaration] && parse auth tokens')).toEqual({
      semantic: 'parse auth tokens',
      wql: '//function[@declaration]',
    });
  });

  test('inline where // splits semantic and WQL', () => {
    expect(splitConjunction('handle webhook errors where //class//method')).toEqual({
      semantic: 'handle webhook errors',
      wql: '//class//method',
    });
  });

  test('inline AND splits semantic and WQL', () => {
    expect(splitConjunction('//function AND handle errors')).toEqual({
      semantic: 'handle errors',
      wql: '//function',
    });
    expect(splitConjunction('handle errors AND //function')).toEqual({
      semantic: 'handle errors',
      wql: '//function',
    });
  });

  test('pure semantic query with words "where" or "and" is not mistakenly split', () => {
    expect(splitConjunction('where do we store user tokens')).toEqual({
      semantic: 'where do we store user tokens',
    });
    expect(splitConjunction('cats and dogs in code')).toEqual({
      semantic: 'cats and dogs in code',
    });
  });

  test('pure WQL query is recognized', () => {
    expect(splitConjunction('//class[@name="Server"]//method')).toEqual({
      wql: '//class[@name="Server"]//method',
    });
  });
});

describe('buildWqlMatcher and findMatchingCard', () => {
  const dummyNode: WNode = { tag: 'function', attrs: new Map(), children: [] };
  const mockWqlHits: WqlHit[] = [
    {
      path: 'src/auth.ts',
      tag: 'function',
      name: 'validateToken',
      startLine: 10,
      endLine: 25,
      params: undefined,
      returns: undefined,
      signature: undefined,
      hash: undefined,
      shape: undefined,
      node: dummyNode,
    },
    {
      path: 'src/user.ts',
      tag: 'class',
      name: 'UserService',
      startLine: 1,
      endLine: 100,
      params: undefined,
      returns: undefined,
      signature: undefined,
      hash: undefined,
      shape: undefined,
      node: dummyNode,
    },
  ];

  const matcher = buildWqlMatcher(mockWqlHits);

  test('matches card by exact symbol name in matching file', () => {
    const card = {
      id: 'c1',
      channel: 'symbols',
      source: { path: 'src/auth.ts', contentHash: 'h' },
      provenance: { transformer: 't', transformerVersion: '1', trust: 'first-party' },
      categoryLabel: 'function',
      attrs: { symbol: 'validateToken' },
      text: 'validateToken()',
    } as unknown as Card;

    const matched = matcher(card);
    expect(matched).toBeDefined();
    expect(matched?.name).toBe('validateToken');
  });

  test('matches card by line span containment inside WQL hit', () => {
    const card = {
      id: 'c2',
      channel: 'symbols',
      source: {
        path: 'src/user.ts',
        span: { startLine: 15, endLine: 30 },
        contentHash: 'h',
      },
      provenance: { transformer: 't', transformerVersion: '1', trust: 'first-party' },
      categoryLabel: 'method',
      attrs: { symbol: 'save' },
      text: 'save()',
    } as unknown as Card;

    const matched = matcher(card);
    expect(matched).toBeDefined();
    expect(matched?.name).toBe('UserService');
  });

  test('rejects card with mismatched path', () => {
    const card = {
      id: 'c3',
      channel: 'symbols',
      source: { path: 'src/other.ts', contentHash: 'h' },
      provenance: { transformer: 't', transformerVersion: '1', trust: 'first-party' },
      categoryLabel: 'function',
      attrs: { symbol: 'validateToken' },
      text: 'validateToken()',
    } as unknown as Card;

    expect(matcher(card)).toBeUndefined();
  });

  test('findMatchingCard connects a WQL hit to the corresponding dense item', () => {
    const card = {
      id: 'c1',
      channel: 'symbols',
      source: { path: 'src/auth.ts', span: { startLine: 10, endLine: 25 }, contentHash: 'h' },
      attrs: { symbol: 'validateToken' },
    } as unknown as Card;

    const denseHits = [{ card, score: 0.95 }];
    const firstHit = mockWqlHits[0];
    expect(firstHit).toBeDefined();
    if (!firstHit) return;
    const match = findMatchingCard(firstHit, denseHits);
    expect(match).toBeDefined();
    expect(match?.score).toBe(0.95);
  });
});
