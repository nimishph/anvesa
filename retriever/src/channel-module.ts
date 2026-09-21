import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as dense from '@sutras/code-lens-dense';
import { defineTransformer, type InputSource, type Transformer } from '@sutras/code-lens-dense';
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

let dependenciesProvided = false;

/**
 * A channel module in a user's project imports `@sutras/code-lens-dense`, and that package is not in the
 * project's `node_modules` (in a compiled binary it is not on disk at all). Serve the copy this
 * process already has, so a module and the retriever share one set of classes and one set of types.
 */
function provideDependencies(): void {
  if (dependenciesProvided) return;
  Bun.plugin({
    name: 'code-lens-channel-dependencies',
    setup(build) {
      build.module('@sutras/code-lens-dense', () => ({ exports: { ...dense }, loader: 'object' }));
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
): Promise<LoadedChannel> {
  const path = isAbsolute(module) ? module : resolve(projectRoot, module);
  let loaded: ModuleShape;
  provideDependencies();
  try {
    loaded = (await import(pathToFileURL(path).href)) as ModuleShape;
  } catch (failure) {
    throw new ChannelModuleError(channel, module, `it cannot be loaded from ${path}`, {
      cause: failure,
    });
  }

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
