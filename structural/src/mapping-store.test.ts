import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { MappingIntegrityError, MappingInvalidError, MappingLockError } from './errors.ts';
import { MappingStore } from './mapping-store.ts';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'anvesa-mappings-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const kotlin = (over: Record<string, unknown> = {}) => ({
  name: 'kotlin',
  extensions: ['.kt'],
  nodeTypeMap: { function_declaration: 'function', class_declaration: 'class' },
  structuralTags: ['function', 'class'],
  nameExtractors: { function_declaration: 'simple_identifier' },
  ...over,
});

function stores() {
  const project = scratch();
  const home = scratch();
  return { project, home, store: new MappingStore({ projectDir: project, homeDir: home }) };
}

describe('keeping mappings outside the package', () => {
  test('a mapping is validated, written, recorded, and then in effect for its language', async () => {
    const { store, project } = stores();
    const stored = await store.install(kotlin(), { tier: 'project', languages: ['kotlin'] });
    expect(stored).toMatchObject({ tier: 'project', languages: ['kotlin'] });
    expect(existsSync(join(project, '.anvesa', 'mappings', 'kotlin.json'))).toBe(true);
    const lock = JSON.parse(readFileSync(join(project, '.anvesa', 'mappings.lock.json'), 'utf8'));
    expect(lock.mappings.kotlin.sha256).toBe(stored.sha256);

    const registry = await store.registry();
    expect(registry.has('kotlin')).toBe(true);
    expect(registry.has('python')).toBe(true);
    expect((await store.load()).map((entry) => entry.mapping.name)).toEqual(['kotlin']);
  });

  test('nothing is written for a mapping that is not valid', async () => {
    const { store, project } = stores();
    await expect(
      store.install(kotlin({ structuralTags: ['nowhere'] }), { tier: 'project' }),
    ).rejects.toBeInstanceOf(MappingInvalidError);
    await expect(store.install(kotlin({ name: '../evil' }), { tier: 'project' })).rejects.toThrow(
      /letters, digits/,
    );
    expect(existsSync(join(project, '.anvesa'))).toBe(false);
  });

  test('a file that was changed after it was recorded is refused, with what was expected and found', async () => {
    const { store } = stores();
    const stored = await store.install(kotlin(), { tier: 'project' });
    const path = stored.path as string;
    writeFileSync(path, readFileSync(path, 'utf8').replace('"class"', '"struct"'));

    const failure = await store.load().catch((thrown) => thrown);
    expect(failure).toBeInstanceOf(MappingIntegrityError);
    expect(failure.context).toMatchObject({ mapping: 'kotlin', expectedSha256: stored.sha256 });
    expect(failure.context.actualSha256).not.toBe(stored.sha256);
    expect(failure.hint).toContain('anvesa mapping lock');
    await expect(store.registry()).rejects.toBeInstanceOf(MappingIntegrityError);

    expect((await store.verify()).map((check) => [check.name, check.status])).toEqual([
      ['kotlin', 'modified'],
    ]);
  });

  test('a mapping dropped in by hand, and one whose file is gone, are refused', async () => {
    const { store, project } = stores();
    const stored = await store.install(kotlin(), { tier: 'project' });
    writeFileSync(
      join(project, '.anvesa', 'mappings', 'sneaky.json'),
      JSON.stringify(kotlin({ name: 'sneaky' })),
    );
    const unrecorded = await store.load().catch((thrown) => thrown);
    expect(unrecorded).toBeInstanceOf(MappingIntegrityError);
    expect(unrecorded.context).toMatchObject({ mapping: 'sneaky', expectedSha256: undefined });

    rmSync(join(project, '.anvesa', 'mappings', 'sneaky.json'));
    rmSync(stored.path as string);
    const gone = await store.load().catch((thrown) => thrown);
    expect(gone).toBeInstanceOf(MappingIntegrityError);
    expect(gone.context).toMatchObject({ mapping: 'kotlin', actualSha256: undefined });
    expect((await store.verify()).map((check) => check.status)).toEqual(['missing']);
  });

  test('a change that is meant is recorded with lock, and only then used', async () => {
    const { store } = stores();
    const stored = await store.install(kotlin(), { tier: 'project' });
    writeFileSync(
      stored.path as string,
      readFileSync(stored.path as string, 'utf8').replaceAll('"class"', '"interface"'),
    );
    await expect(store.load()).rejects.toBeInstanceOf(MappingIntegrityError);
    const locked = await store.lock('kotlin', 'project');
    expect(locked.sha256).not.toBe(stored.sha256);
    const [entry] = await store.load();
    expect(entry?.mapping.nodeTypeMap.class_declaration).toBe('interface');
    await expect(store.lock('ghost', 'project')).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  test('installing over a file that was edited by hand needs force', async () => {
    const { store } = stores();
    const stored = await store.install(kotlin(), { tier: 'project' });
    writeFileSync(stored.path as string, `${readFileSync(stored.path as string, 'utf8')}\n\n`);
    await expect(store.install(kotlin(), { tier: 'project' })).rejects.toBeInstanceOf(
      MappingIntegrityError,
    );
    await expect(store.install(kotlin(), { tier: 'project', force: true })).resolves.toBeDefined();
    await expect(store.load()).resolves.toHaveLength(1);
  });

  test('the project’s mapping wins over the user’s, and both over the bundled one', async () => {
    const { store } = stores();
    const python = (extra: string) => ({
      name: 'python',
      extensions: ['.py'],
      nodeTypeMap: { function_definition: extra },
      structuralTags: [extra],
      nameExtractors: {},
    });
    let registry = await store.registry();
    expect(registry.require('python').mapping.nodeTypeMap.function_definition).toBe('function');

    await store.install(python('user_fn'), { tier: 'user', languages: ['python'] });
    registry = await store.registry();
    expect(registry.require('python').mapping.nodeTypeMap.function_definition).toBe('user_fn');

    await store.install(python('project_fn'), { tier: 'project', languages: ['python'] });
    registry = await store.registry();
    expect(registry.require('python').mapping.nodeTypeMap.function_definition).toBe('project_fn');
    // The other bundled languages are untouched.
    expect(registry.require('php').mapping.name).toBe('php');
  });

  test('forking a bundled mapping copies it for the same languages, to be edited and re-recorded', async () => {
    const { store } = stores();
    const forked = await store.fork('javascript', { tier: 'project' });
    expect(forked.mapping.name).toBe('typescript');
    expect([...forked.languages].sort()).toEqual(['javascript', 'tsx', 'typescript', 'vue']);
    const registry = await store.registry();
    for (const language of ['typescript', 'javascript', 'tsx', 'vue']) {
      expect(registry.require(language).mapping.name).toBe('typescript');
    }
    await expect(store.fork('klingon', { tier: 'project' })).rejects.toThrow(/klingon/);
    await expect(
      new MappingStore({ homeDir: scratch() }).fork('python', { tier: 'project' }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  test('what is in effect is listed with where each comes from', async () => {
    const { store } = stores();
    await store.install(kotlin(), { tier: 'user', languages: ['kotlin'] });
    const listed = await store.list();
    const summary = Object.fromEntries(listed.map((entry) => [entry.mapping.name, entry.tier]));
    expect(summary).toMatchObject({
      typescript: 'bundled',
      python: 'bundled',
      php: 'bundled',
      kotlin: 'user',
    });
    expect(listed.find((entry) => entry.mapping.name === 'python')?.sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test('removing a mapping drops its file, its golden record and its record', async () => {
    const { store, project } = stores();
    await store.install(kotlin(), { tier: 'project', golden: { samples: [] } });
    expect(await store.golden('kotlin', 'project')).toEqual({ samples: [] });
    expect(await store.remove('kotlin', 'project')).toBe(true);
    expect(await store.remove('kotlin', 'project')).toBe(false);
    expect(await store.load()).toEqual([]);
    expect(existsSync(join(project, '.anvesa', 'mappings', 'kotlin.golden.json'))).toBe(false);
    expect(await store.golden('kotlin', 'project')).toBeUndefined();
  });

  test('a lockfile that cannot be read is an error, not an empty lock', async () => {
    const { store, project } = stores();
    await store.install(kotlin(), { tier: 'project' });
    const lock = join(project, '.anvesa', 'mappings.lock.json');
    writeFileSync(lock, '{not json');
    await expect(store.load()).rejects.toBeInstanceOf(MappingLockError);
    writeFileSync(
      lock,
      JSON.stringify({ lockfileVersion: 1, mappings: { kotlin: { sha256: 'short' } } }),
    );
    await expect(store.load()).rejects.toThrow(/sha256/);
    writeFileSync(lock, JSON.stringify({ lockfileVersion: 9, mappings: {} }));
    await expect(store.load()).rejects.toThrow(/lockfileVersion/);
  });

  test('a mapping file named for one thing and saying another is refused', async () => {
    const { store, project } = stores();
    const stored = await store.install(kotlin(), { tier: 'project' });
    const lied = JSON.stringify({ ...kotlin(), name: 'other' }, null, 2);
    writeFileSync(stored.path as string, lied);
    await store.lock('kotlin', 'project');
    const failure = await store.load().catch((thrown) => thrown);
    expect(failure).toBeInstanceOf(MappingInvalidError);
    expect(failure.message).toContain('named "kotlin"');
    void project;
  });
});
