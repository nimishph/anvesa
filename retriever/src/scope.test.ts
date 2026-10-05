import { describe, expect, test } from 'bun:test';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { bothScopes, pathScope } from './scope.ts';

describe('pathScope', () => {
  test('holds the path itself and what is under it, by whole segments', () => {
    const inApi = pathScope('src/api') as (path: string) => boolean;
    expect(inApi('src/api')).toBe(true);
    expect(inApi('src/api/users.ts')).toBe(true);
    expect(inApi('src/api/v2/users.ts')).toBe(true);
    expect(inApi('src/apis/users.ts')).toBe(false);
    expect(inApi('src/web/api/users.ts')).toBe(false);
    expect(inApi('other/src/api/users.ts')).toBe(false);
  });

  test('is forgiving about spelling: ./, trailing and doubled /, and \\', () => {
    for (const spelling of ['./src/api', 'src/api/', 'src//api', 'src\\api', './src/./api/']) {
      const inApi = pathScope(spelling) as (path: string) => boolean;
      expect(inApi('src/api/users.ts')).toBe(true);
      expect(inApi('src/apis/users.ts')).toBe(false);
    }
  });

  test('none, or the project itself, is no scope at all', () => {
    expect(pathScope(undefined)).toBeUndefined();
    expect(pathScope('.')).toBeUndefined();
    expect(pathScope('./')).toBeUndefined();
  });

  test('refuses a scope that could never match, rather than finding nothing', () => {
    for (const bad of [
      '',
      '  ',
      '/etc',
      '\\\\server\\share',
      'C:/code',
      'c:src',
      '../x',
      'src/../../x',
      'a\0b',
    ]) {
      expect(() => pathScope(bad, '--scope')).toThrow(InvalidArgumentError);
    }
  });

  test('bothScopes needs both tests to pass', () => {
    const a = pathScope('src') as (path: string) => boolean;
    const b = (path: string) => path.endsWith('.ts');
    const both = bothScopes(a, b) as (path: string) => boolean;
    expect(both('src/a.ts')).toBe(true);
    expect(both('src/a.md')).toBe(false);
    expect(both('lib/a.ts')).toBe(false);
    expect(bothScopes(undefined, b)).toBe(b);
    expect(bothScopes(a, undefined)).toBe(a);
  });
});
