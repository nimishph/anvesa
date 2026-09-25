import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as dense from '@cntxt-labs/anvesa-dense';
import { defineTransformer, type InputSource, type Transformer } from '@cntxt-labs/anvesa-dense';
import { loadProjectConfig, writeProjectConfig } from './config.ts';
import { ChannelModuleError } from './errors.ts';

/** What a channel module gives: its transformer, and where non-file records come from, if any. */
export interface LoadedChannel {
  readonly transformer: Transformer;
  readonly source: InputSource | undefined;
}

interface ModuleShape {
  readonly default?: unknown;
  readonly source?: unknown;
}

/** How a module is checked before it runs. */
export interface ModulePin {
  /** The SHA-256 (hex) the module file must have. */
  readonly sha256?: string | undefined;
  /** Refuse a module that has no `sha256`. */
  readonly required?: boolean;
}

/** SHA-256 (hex) of a channel module file. Only that file: what it imports is not covered. */
export async function moduleChecksum(projectRoot: string, module: string): Promise<string> {
  const path = isAbsolute(module) ? module : resolve(projectRoot, module);
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function verifyChecksum(
  channel: string,
  module: string,
  path: string,
  expected: string,
): Promise<void> {
  let actual: string;
  try {
    actual = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (failure) {
    throw new ChannelModuleError(channel, module, `it cannot be read from ${path}`, {
      cause: failure,
    });
  }
  if (actual !== expected) {
    throw new ChannelModuleError(channel, module, 'its checksum does not match the pinned one', {
      hint: `Review the change, then re-pin it: anvesa channel pin ${channel}`,
      context: { expected, actual },
    });
  }
}

let dependenciesProvided = false;

/**
 * A channel module in a user's project imports `@cntxt-labs/anvesa-dense`, and that package is not in the
 * project's `node_modules` (in a compiled binary it is not on disk at all). Serve the copy this
 * process already has, so a module and the retriever share one set of classes and one set of types.
 */
export function provideDependencies(): void {
  if (dependenciesProvided) return;
  Bun.plugin({
    name: 'anvesa-channel-dependencies',
    setup(build) {
      build.module('@cntxt-labs/anvesa-dense', () => ({
        exports: { ...dense },
        loader: 'object',
      }));
    },
  });
  dependenciesProvided = true;
}

/**
 * Load a channel from a module: `export default` a transformer, and optionally
 * `export const source` (an `InputSource`, or a function of `{ root }`, the project root, returning
 * one) for records that are not files. A module that is missing, throws on load, or exports something else says which.
 */
export async function loadChannelModule(
  channel: string,
  module: string,
  projectRoot: string,
  pin: ModulePin = {},
): Promise<LoadedChannel> {
  const path = isAbsolute(module) ? module : resolve(projectRoot, module);
  if (pin.sha256 === undefined && pin.required === true) {
    throw new ChannelModuleError(
      channel,
      module,
      'it is not pinned, and this project requires it',
      {
        hint: `Review the module, then run: anvesa channel pin ${channel}`,
      },
    );
  }
  if (pin.sha256 !== undefined) await verifyChecksum(channel, module, path, pin.sha256);
  let loaded: ModuleShape;
  provideDependencies();
  try {
    loaded = (await import(pathToFileURL(path).href)) as ModuleShape;
  } catch (failure) {
    throw new ChannelModuleError(channel, module, `it cannot be loaded from ${path}`, {
      cause: failure,
    });
  }
  // The file is read again by the import above; a change between the two is caught here.
  if (pin.sha256 !== undefined) await verifyChecksum(channel, module, path, pin.sha256);

  const candidate = loaded.default;
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') {
    throw new ChannelModuleError(channel, module, 'it has no default export that is a transformer');
  }
  const transformer = defineTransformer(candidate as Transformer);
  if (transformer.channel !== channel) {
    throw new ChannelModuleError(
      channel,
      module,
      `its transformer feeds channel "${transformer.channel}", not "${channel}"`,
    );
  }

  const declared = loaded.source;
  let source: InputSource | undefined;
  if (typeof declared === 'function') {
    source = (declared as (context: { readonly root: string }) => InputSource)({
      root: projectRoot,
    });
  } else if (declared !== undefined) source = declared as InputSource;
  if (source !== undefined && typeof source.files !== 'function') {
    throw new ChannelModuleError(channel, module, 'its `source` has no `files()`');
  }
  return { transformer, source };
}

/**
 * Hold a channel's module to its current bytes: record their checksum in the project config.
 * Pinning is the act of having reviewed the module, so it does not load it, and it works on a
 * module whose earlier pin no longer matches.
 */
export async function pinChannelModule(
  projectRoot: string,
  channel: string,
): Promise<{ readonly module: string; readonly sha256: string }> {
  const config = await loadProjectConfig(projectRoot);
  const settings = config.channels[channel];
  if (settings?.module === undefined) {
    throw new ChannelModuleError(channel, '(none)', 'it has no module to pin');
  }
  const sha256 = await moduleChecksum(projectRoot, settings.module);
  await writeProjectConfig(projectRoot, {
    ...config,
    channels: { ...config.channels, [channel]: { ...settings, sha256 } },
  });
  return { module: settings.module, sha256 };
}
