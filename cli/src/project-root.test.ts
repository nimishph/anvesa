import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot } from './project-root.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(...files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'anvesa-root-'));
  roots.push(root);
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), '{}');
  }
  return root;
}

describe('findProjectRoot', () => {
  const env = { HOME: '/nonexistent-home' };

  test('walks up to the nearest directory whose .anvesa holds a project file', () => {
    const root = tree('.anvesa/config.json', 'packages/app/src/a.ts');
    expect(findProjectRoot(join(root, 'packages/app/src'), env)).toBe(root);
    expect(findProjectRoot(root, env)).toBe(root);
  });

  test('the nearest project wins over one further up', () => {
    const root = tree(
      '.anvesa/config.json',
      'packages/app/.anvesa/index.db',
      'packages/app/src/a.ts',
    );
    expect(findProjectRoot(join(root, 'packages/app/src'), env)).toBe(join(root, 'packages/app'));
  });

  test('an index or a workspace file marks a project as well as a config does', () => {
    const indexed = tree('.anvesa/index.db', 'src/a.ts');
    expect(findProjectRoot(join(indexed, 'src'), env)).toBe(indexed);
    const workspace = tree('.anvesa/workspace.json', 'src/a.ts');
    expect(findProjectRoot(join(workspace, 'src'), env)).toBe(workspace);
  });

  test('an empty .anvesa, or none at all, leaves the start directory as the root', () => {
    const root = tree('.anvesa/.keep', 'src/a.ts');
    expect(findProjectRoot(join(root, 'src'), env)).toBe(join(root, 'src'));
  });

  test('the per-user .anvesa is not a project', () => {
    const home = tree('.anvesa/config.json', 'work/src/a.ts');
    expect(findProjectRoot(join(home, 'work/src'), { HOME: home })).toBe(join(home, 'work/src'));
    expect(findProjectRoot(join(home, 'work/src'), { ANVESA_HOME: join(home, '.anvesa') })).toBe(
      join(home, 'work/src'),
    );
  });
});
