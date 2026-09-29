import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAIN_PACKAGE, PLATFORMS, platformPackage } from './platforms.ts';

const root = resolve(import.meta.dir, '..');
const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    private?: boolean;
    license?: string;
    author?: { name: string };
    bin?: Record<string, string>;
    files?: string[];
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    publishConfig?: { access: string };
  };

const launcher = createRequire(import.meta.url)('../cli/bin/anvesa.cjs') as {
  SUPPORTED: string[];
  platformPackage(platform: string, cpu: string): string | undefined;
  locate(
    platform: string,
    cpu: string,
    resolve: (specifier: string) => string,
  ): { program?: string; problem?: string };
  makeExecutable(program: string): boolean;
  isPermissionFailure(error: unknown): boolean;
};

/** What Node throws when a package is not installed. */
class ModuleNotFound extends Error {
  readonly code = 'MODULE_NOT_FOUND';
}

describe('what is published', () => {
  const cli = manifest('cli');

  test('only the command is public, under the owner named as author, and it is MIT', () => {
    expect(cli.name).toBe(MAIN_PACKAGE);
    expect(cli.private).toBeUndefined();
    expect(cli.publishConfig?.access).toBe('public');
    expect(cli.license).toBe('MIT');
    expect(cli.author?.name).toBe('nimishph');
    expect(cli.bin).toEqual({ anvesa: 'bin/anvesa.cjs' });
    expect(cli.files).toEqual(['bin', 'skills', 'README.md', 'LICENSE']);
    // Everything else is built into the program, so installing it pulls in nothing.
    expect(cli.dependencies).toBeUndefined();

    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.name === 'cli') continue;
      try {
        expect(manifest(folder.name).private).toBe(true);
      } catch (failure) {
        // Folders without a manifest (dist, .github, node_modules) are not packages.
        if ((failure as { code?: string }).code !== 'ENOENT') throw failure;
      }
    }
  });

  test('it installs exactly one program per platform, at its own version', () => {
    expect(Object.keys(cli.optionalDependencies ?? {}).sort()).toEqual(
      PLATFORMS.map(platformPackage).sort(),
    );
    for (const version of Object.values(cli.optionalDependencies ?? {})) {
      expect(version).toBe(cli.version);
    }
  });
});

describe('the launcher', () => {
  test('knows the same platforms the build does', () => {
    expect([...launcher.SUPPORTED].sort()).toEqual(PLATFORMS.map((p) => `${p.os}-${p.cpu}`).sort());
    for (const p of PLATFORMS) {
      expect(launcher.platformPackage(p.os, p.cpu)).toBe(platformPackage(p));
    }
  });

  test('finds the program in the platform package', () => {
    const found = launcher.locate('linux', 'x64', (specifier) => `/modules/${specifier}`);
    expect(found.program).toBe('/modules/@cntxt-labs/anvesa-linux-x64/bin/anvesa');
    const windows = launcher.locate('win32', 'x64', (specifier) => `/modules/${specifier}`);
    expect(windows.program).toBe('/modules/@cntxt-labs/anvesa-win32-x64/bin/anvesa.exe');
  });

  test('says what is wrong on an unsupported platform and when the package is missing', () => {
    const unsupported = launcher.locate('darwin', 'x64', () => '');
    expect(unsupported.problem).toContain('no build for darwin on x64');
    expect(unsupported.problem).toContain('linux-x64');

    const missing = launcher.locate('linux', 'x64', () => {
      throw new ModuleNotFound();
    });
    expect(missing.problem).toContain('@cntxt-labs/anvesa-linux-x64 package is not installed');
    expect(missing.problem).toContain('--no-optional');
  });
});

describe('recovering a program that lost its executable bit', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'anvesa-chmod-'));
  afterAll(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  test('it sets the bit, and says so', () => {
    const program = join(sandbox, 'anvesa');
    writeFileSync(program, '#!/bin/sh\necho hi\n');
    // Start from "not executable", the state a build artifact or a stripping install leaves.
    chmodSync(program, 0o644);
    expect(launcher.makeExecutable(program)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(program).mode & 0o111).not.toBe(0);
    }
  });

  test('it reports failure instead of throwing when the program cannot be reached', () => {
    expect(launcher.makeExecutable(join(sandbox, 'not-here'))).toBe(false);
  });

  test('it only retries on a permission failure, not on any error at all', () => {
    expect(launcher.isPermissionFailure({ code: 'EACCES' })).toBe(true);
    expect(launcher.isPermissionFailure({ code: 'ENOENT' })).toBe(false);
    expect(launcher.isPermissionFailure({ code: 'EPERM' })).toBe(false);
    expect(launcher.isPermissionFailure(undefined)).toBe(false);
    expect(launcher.isPermissionFailure(null)).toBe(false);
  });
});
