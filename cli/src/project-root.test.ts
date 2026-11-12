import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot, isProjectRoot } from './project-root.ts';

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

  test("the real user's .anvesa is not a project either, whatever HOME a run was given", () => {
    // Its config.json holds preferences (the telemetry choice), not a project. A run with a
    // made-up HOME, as tests use, still sits under the real home on most machines.
    const home = tree('.anvesa/config.json', 'work/src/a.ts');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect(isProjectRoot(home, env)).toBe(false);
      // Any other directory with the same file is a project.
      expect(isProjectRoot(tree('.anvesa/config.json'), env)).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
