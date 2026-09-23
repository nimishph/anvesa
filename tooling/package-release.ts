#!/usr/bin/env bun
/**
 * Build the distributable for this machine's platform: the compiled program and the `runtime`
 * folder that holds the ONNX runtime beside it.
 *
 *   bun run tooling/package-release.ts [--out dist]
 *
 * The result is `<out>/code-lens-<version>-<platform>-<arch>/` and an archive of it. The runtime
 * is a folder rather than part of the program because the native addon must sit next to its shared
 * library, and a compiled program cannot carry both in a place the loader will look.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@cntxt-labs/code-lens-core';
import { PLATFORMS, platformPackage } from './platforms.ts';

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(root, values.out ?? 'dist');
const version = (
  JSON.parse(readFileSync(join(root, 'cli', 'package.json'), 'utf8')) as { version: string }
).version;
const target = `${process.platform}-${process.arch}`;
const name = `code-lens-${version}-${target}`;
const folder = join(out, name);

/** The folder of a package, found the way its own dependent would find it. */
const packageDirectory = (specifier: string, from: string): string =>
  // The package's manifest is always resolvable, whatever its `exports` say.
  dirname(createRequire(join(from, 'package.json')).resolve(`${specifier}/package.json`));

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn({ cmd: [...command], cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) {
    throw new InvalidArgumentError('build', `${command.join(' ')} to succeed`, `exit code ${code}`);
  }
}

rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });

const program = process.platform === 'win32' ? 'code-lens.exe' : 'code-lens';
await run(
  [
    'bun',
    'build',
    '--compile',
    './src/binary.ts',
    '--external',
    'onnxruntime-node',
    '--outfile',
    join(folder, program),
  ],
  join(root, 'cli'),
);

const modules = join(folder, 'runtime', 'node_modules');
const nodePackage = packageDirectory('onnxruntime-node', join(root, 'embedder'));
for (const specifier of ['onnxruntime-node', 'onnxruntime-common']) {
  const source =
    specifier === 'onnxruntime-node' ? nodePackage : packageDirectory(specifier, nodePackage);
  const destination = join(modules, specifier);
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, 'package.json'), join(destination, 'package.json'));
  for (const part of ['dist', 'lib']) {
    if (existsSync(join(source, part)))
      cpSync(join(source, part), join(destination, part), { recursive: true });
  }
  if (specifier === 'onnxruntime-node') {
    // A compiled program does not look up bare package names at run time, so the two packages
    // are joined by relative paths.
    let joined = 0;
    for (const file of ['index.js', 'binding.js', 'backend.js']) {
      const path = join(destination, 'dist', file);
      const text = readFileSync(path, 'utf8');
      const rewritten = text.replaceAll(
        'require("onnxruntime-common")',
        'require("../../onnxruntime-common/dist/cjs/index.js")',
      );
      if (rewritten !== text) joined += 1;
      writeFileSync(path, rewritten);
    }
    if (joined === 0) {
      throw new InvalidArgumentError(
        'onnxruntime-node',
        'requires of onnxruntime-common to join',
        'none found',
      );
    }
    const native = join('bin', 'napi-v6', process.platform, process.arch);
    if (!existsSync(join(source, native))) {
      throw new InvalidArgumentError('platform', 'one onnxruntime-node ships a binary for', target);
    }
    cpSync(join(source, native), join(destination, native), { recursive: true });
  }
}

for (const file of ['README.md', 'LICENSE']) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(folder, file));
}
const skills = join(root, 'cli', 'skills');
if (existsSync(skills)) cpSync(skills, join(folder, 'skills'), { recursive: true });
writeFileSync(join(folder, 'VERSION'), `${version}\n`);

// The same program as an npm package for this platform, which `@cntxt-labs/code-lens` depends on
// optionally. The launcher in that package finds `bin/code-lens` and the runtime beside it.
const here = PLATFORMS.find(
  (platform) => platform.os === process.platform && platform.cpu === process.arch,
);
if (!here) {
  throw new InvalidArgumentError('platform', PLATFORMS.map(platformPackage).join(', '), target);
}
const npmName = platformPackage(here);
const npmFolder = join(out, 'npm', npmName.split('/')[1] as string);
rmSync(npmFolder, { recursive: true, force: true });
mkdirSync(join(npmFolder, 'bin'), { recursive: true });
cpSync(join(folder, program), join(npmFolder, 'bin', program));
cpSync(join(folder, 'runtime'), join(npmFolder, 'bin', 'runtime'), { recursive: true });
for (const file of ['LICENSE']) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(npmFolder, file));
}
const cliManifest = JSON.parse(readFileSync(join(root, 'cli', 'package.json'), 'utf8')) as {
  author: unknown;
  license: string;
  homepage: string;
  repository: unknown;
  bugs: unknown;
};
writeFileSync(
  join(npmFolder, 'package.json'),
  `${JSON.stringify(
    {
      name: npmName,
      version,
      description: `The code-lens program for ${process.platform} on ${process.arch}. Install @cntxt-labs/code-lens instead.`,
      license: cliManifest.license,
      author: cliManifest.author,
      homepage: cliManifest.homepage,
      repository: cliManifest.repository,
      bugs: cliManifest.bugs,
      os: [process.platform],
      cpu: [process.arch],
      ...(process.platform === 'linux' ? { libc: ['glibc'] } : {}),
      files: ['bin', 'LICENSE'],
      publishConfig: { access: 'public' },
    },
    null,
    2,
  )}
`,
);

const archive = process.platform === 'win32' ? `${name}.zip` : `${name}.tar.gz`;
rmSync(join(out, archive), { force: true });
await run(
  process.platform === 'win32'
    ? ['tar', '-a', '-c', '-f', archive, name]
    : ['tar', '-czf', archive, name],
  out,
);
process.stdout.write(`${join(out, archive)}\n`);
