import { describe, expect, test } from 'bun:test';
import { DocblockAnnotationCorpusAdapter } from '@cntxt-labs/anvesa-structural';
import { MemoryIndexStore } from './store/memory-index-store.ts';

describe('CorpusAdapter & Store', () => {
  const adapter = new DocblockAnnotationCorpusAdapter();

  test('DocblockAnnotationCorpusAdapter claims supported source files', () => {
    expect(adapter.claim({ path: 'src/service.ts', content: '' })).toBe(true);
    expect(adapter.claim({ path: 'src/api.py', content: '' })).toBe(true);
    expect(adapter.claim({ path: 'src/main.go', content: '' })).toBe(true);
    expect(adapter.claim({ path: 'readme.txt', content: '' })).toBe(false);
  });

  test('extracts @owner and @auth tags from source content', () => {
    const content = `
/**
 * @owner platform-team
 * @auth bearer
 */
export class AuthService {}
`;
    const records = adapter.extract({ path: 'src/auth.ts', content });
    expect(records.length).toBe(2);

    const owner = records.find((r) => r.attrs.tag === 'owner');
    expect(owner).toBeDefined();
    expect(owner?.attrs.owner).toBe('platform-team');
    expect(owner?.attrs.value).toBe('platform-team');
    expect(owner?.attrs.line).toBe('3');

    const auth = records.find((r) => r.attrs.tag === 'auth');
    expect(auth).toBeDefined();
    expect(auth?.attrs.auth).toBe('bearer');
    expect(auth?.attrs.line).toBe('4');
  });

  test('MemoryIndexStore stores and queries corpus records', async () => {
    const store = new MemoryIndexStore();
    await store.putCorpusRecords([
      {
        corpus: 'docblock-annotations',
        id: 'src/auth.ts:L3:@owner',
        path: 'src/auth.ts',
        attrs: { tag: 'owner', owner: 'platform-team' },
        text: ' * @owner platform-team',
      },
      {
        corpus: 'docblock-annotations',
        id: 'src/auth.ts:L4:@auth',
        path: 'src/auth.ts',
        attrs: { tag: 'auth', auth: 'bearer' },
        text: ' * @auth bearer',
      },
      {
        corpus: 'custom-routes',
        id: 'src/api.ts:L10',
        path: 'src/api.ts',
        attrs: { method: 'POST', path: '/login' },
      },
    ]);

    const annotations = await store.findCorpusRecords({ corpus: 'docblock-annotations' });
    expect(annotations.items.length).toBe(2);

    const paths = await store.corpusPaths('docblock-annotations');
    expect(paths).toEqual(['src/auth.ts']);

    const routes = await store.findCorpusRecords({ corpus: 'custom-routes' });
    expect(routes.items.length).toBe(1);
    expect(routes.items[0]?.attrs.method).toBe('POST');
  });
});
