import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DefinitionInvalidError,
  gateFrom,
  parsePolicy,
  type RedTeamGate,
  type RedTeamPolicy,
} from '@sutras/code-lens-dense';
import { provideDependencies } from './channel-module.ts';
import { ChannelModuleError, ProjectConfigError } from './errors.ts';

/** A project's red-team policy: extra rules, what each trust level does about any rule, and sources. */
export const REDTEAM_PATH = '.code-lens/redteam.json';

/** What a policy source hands back: the policy object, now or later. */
type SourceExport = unknown | ((context: { readonly root: string }) => unknown | Promise<unknown>);

/**
 * Every policy in force for a project, in the order they apply: the project's own file first, then
 * each module it lists under `sources` (for rules learned elsewhere, such as Sage's). A source
 * module default-exports a policy object, or a function of `{ root }` that returns one, and is
 * checked exactly as the project file is. Nothing here runs unless the file asks for it.
 */
export async function loadPolicies(root: string): Promise<readonly RedTeamPolicy[]> {
  const path = join(root, REDTEAM_PATH);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (failure) {
    throw new ProjectConfigError(path, 'file', 'it is not JSON', { cause: failure });
  }
  const policies: RedTeamPolicy[] = [parsePolicy(raw, path)];

  const sources = (raw as { sources?: unknown }).sources;
  if (sources === undefined) return policies;
  if (!Array.isArray(sources) || sources.some((entry) => typeof entry !== 'string')) {
    throw new DefinitionInvalidError(
      `red-team policy ${path}`,
      'sources',
      'must be an array of module paths',
    );
  }
  provideDependencies();
  for (const [index, source] of (sources as string[]).entries()) {
    const module = isAbsolute(source) ? source : resolve(root, source);
    let loaded: { default?: SourceExport };
    try {
      loaded = (await import(pathToFileURL(module).href)) as { default?: SourceExport };
    } catch (failure) {
      throw new ChannelModuleError(
        `redteam.sources[${index}]`,
        source,
        `it cannot be loaded from ${module}`,
        {
          cause: failure,
        },
      );
    }
    const exported = loaded.default;
    const value =
      typeof exported === 'function'
        ? await (exported as (c: { root: string }) => unknown)({ root })
        : exported;
    if (value === undefined) {
      throw new ChannelModuleError(
        `redteam.sources[${index}]`,
        source,
        'it has no default export: a policy, or a function returning one',
      );
    }
    policies.push(parsePolicy(value, module));
  }
  return policies;
}

/** The gate for a project: the built-in one when it has no policy, else the one its policies describe. */
export async function gateForProject(root: string): Promise<RedTeamGate> {
  return gateFrom(await loadPolicies(root));
}
