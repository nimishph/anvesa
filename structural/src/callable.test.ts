import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { StructuralIndex } from './corpus.ts';
import type { EncodedFile } from './engine.ts';
import { disposeEngines, makeEngine } from './test-support.ts';
import { matchWql, parseWql } from './wql.ts';

const engine = makeEngine();
afterAll(disposeEngines);

const tsSource = `
export class UserService {
  save(user: string): boolean {
    return true;
  }
}
export function standalone(x: number): number {
  return x * 2;
}
export const helper = () => 42;
`;

const pySource = `
class AccountService:
    def deposit(self, amount: int) -> bool:
        return True

def standalone_py(x: int) -> int:
    return x * 2
`;

let tsFile: EncodedFile;
let pyFile: EncodedFile;

beforeAll(async () => {
  tsFile = await engine.encode(tsSource, { path: 'src/user.ts' });
  pyFile = await engine.encode(pySource, { path: 'src/account.py' });
});

describe('callable & method AST attributes', () => {
  test('TypeScript: sets callable on function, method and arrow; sets isMethod on method', () => {
    const qMethod = parseWql('//method[@name="save"]');
    const matchesMethod = matchWql(qMethod, [tsFile.root]);
    expect(matchesMethod.length).toBe(1);
    expect(matchesMethod[0]?.node.attrs.get('callable')).toBe('true');
    expect(matchesMethod[0]?.node.attrs.get('isMethod')).toBe('true');

    const qFn = parseWql('//function[@name="standalone"]');
    const matchesFn = matchWql(qFn, [tsFile.root]);
    expect(matchesFn.length).toBe(1);
    expect(matchesFn[0]?.node.attrs.get('callable')).toBe('true');
    expect(matchesFn[0]?.node.attrs.get('isMethod')).toBeUndefined();

    const qArrow = parseWql('//arrow');
    const matchesArrow = matchWql(qArrow, [tsFile.root]);
    expect(matchesArrow.length).toBe(1);
    expect(matchesArrow[0]?.node.attrs.get('callable')).toBe('true');
  });

  test('Python: class def gets isMethod=true while top-level def does not', () => {
    const qMethod = parseWql('//class//function[@name="deposit"]');
    const matches = matchWql(qMethod, [pyFile.root]);
    expect(matches.length).toBe(1);
    expect(matches[0]?.node.attrs.get('callable')).toBe('true');
    expect(matches[0]?.node.attrs.get('isMethod')).toBe('true');

    const qTop = parseWql('//function[@name="standalone_py"]');
    const matchesTop = matchWql(qTop, [pyFile.root]);
    expect(matchesTop.length).toBe(1);
    expect(matchesTop[0]?.node.attrs.get('callable')).toBe('true');
    expect(matchesTop[0]?.node.attrs.get('isMethod')).toBeUndefined();
  });
});

describe('WQL //callable and //method virtual matching', () => {
  test('//callable matches functions, methods and arrows across TS and Python', () => {
    const q = parseWql('//callable');
    const tsMatches = matchWql(q, [tsFile.root]);
    // save (method), standalone (function), helper (arrow)
    expect(tsMatches.length).toBe(3);

    const pyMatches = matchWql(q, [pyFile.root]);
    // deposit (method/function), standalone_py (function)
    expect(pyMatches.length).toBe(2);
  });

  test('//fn is an alias for //callable', () => {
    const q = parseWql('//fn');
    const tsMatches = matchWql(q, [tsFile.root]);
    expect(tsMatches.length).toBe(3);
  });

  test('//method matches both TS method and Python method (def in class)', () => {
    const q = parseWql('//method');
    const tsMatches = matchWql(q, [tsFile.root]);
    expect(tsMatches.length).toBe(1);
    expect(tsMatches[0]?.node.attrs.get('baseName')).toBe('save');

    const pyMatches = matchWql(q, [pyFile.root]);
    expect(pyMatches.length).toBe(1);
    expect(pyMatches[0]?.node.attrs.get('baseName')).toBe('deposit');
  });
});

describe('StructuralIndex with //callable and //method', () => {
  test('indexes and retrieves callables across files', () => {
    const index = new StructuralIndex();
    index.set({ path: 'src/user.ts', root: tsFile.root });
    index.set({ path: 'src/account.py', root: pyFile.root });

    const callables = index.query('//callable');
    expect(callables.items.length).toBe(5);

    const methods = index.query('//method');
    expect(methods.items.length).toBe(2);
    const names = methods.items.map((i) => i.name).sort();
    expect(names).toEqual(['AccountService.deposit', 'UserService.save']);
  });
});
