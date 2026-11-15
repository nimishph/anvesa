import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { loadProjectConfig, PROJECT_CONFIG_PATH } from '@cntxt-labs/anvesa-retriever';
import { isProjectRoot } from '../../../project-root.ts';
import { defineCommand } from '../../shared/command.ts';
import { root } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'project:where',
  words: ['where'],
  help: {
    section: 'Get started',
    rank: 3,
    name: 'where [root|config|index|models]',
    summary: 'the project in use, and its config, index and models paths',
    details:
      '  where [root|config|index|models]   the project in use, how it was found, and its config, index and\n                            models paths; name one to print just that path (for scripts)',
  },
  run: async (ctx, services) => {
    const projectRoot = root(ctx);
    const cwd = resolve(ctx.environment.cwd);
    const foundBy =
      ctx.parsed.values.root !== undefined
        ? 'named by --root'
        : projectRoot !== cwd
          ? `nearest project above ${cwd}`
          : isProjectRoot(projectRoot, ctx.environment.env)
            ? 'current directory'
            : 'no project here or above; current directory';
    const configPath = join(projectRoot, PROJECT_CONFIG_PATH);
    let sharded = false;
    let configProblem: string | undefined;
    try {
      sharded = (await loadProjectConfig(projectRoot)).fragments;
    } catch (failure) {
      configProblem = failure instanceof Error ? failure.message : String(failure);
    }
    const paths = {
      root: projectRoot,
      foundBy,
      config: configPath,
      configExists: existsSync(configPath),
      ...(configProblem ? { configProblem } : {}),
      index: join(projectRoot, '.anvesa', sharded ? 'shards' : 'index.db'),
      sharded,
      models: services.modelCache(ctx).root,
    };
    const only = ctx.parsed.positionals[0];
    if (only !== undefined) {
      const picked = {
        root: paths.root,
        config: paths.config,
        index: paths.index,
        models: paths.models,
      }[only];
      if (picked === undefined) {
        throw new InvalidArgumentError('where', 'root, config, index or models', only);
      }
      emit(ctx, { [only]: picked }, () => `${picked}\n`);
      return;
    }
    emit(ctx, paths, () =>
      [
        `root    ${paths.root} (${paths.foundBy})`,
        `config  ${paths.config}${paths.configExists ? '' : ' (not created; defaults in use)'}${configProblem ? ` (invalid: ${configProblem})` : ''}`,
        `index   ${paths.index}${existsSync(paths.index) ? '' : ' (not built yet)'}`,
        `models  ${paths.models}`,
        '',
      ].join('\n'),
    );
  },

  // The embedder is opened so `status` names the model in use; without it every project read as "none".
});
