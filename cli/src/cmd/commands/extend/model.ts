import { isAbsolute, resolve } from 'node:path';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import {
  doctorModels,
  installModel,
  listModels,
  loadProjectConfig,
  verifyModel,
} from '@cntxt-labs/anvesa-retriever';
import { useModel } from '../../../model-use.ts';
import { integerOption } from '../../../options.ts';
import * as show from '../../../render.ts';
import { defineCommand, type Services } from '../../shared/command.ts';
import { type Context, root } from '../../shared/context.ts';
import { emit, need } from '../../shared/output.ts';

async function modelCommand(ctx: Context, services: Services): Promise<void> {
  const [sub, ...names] = ctx.parsed.positionals;
  const inner: Context = { ...ctx, parsed: { ...ctx.parsed, positionals: names } };
  const cache = services.modelCache(ctx);
  switch (sub) {
    case 'list': {
      const models = await listModels(cache);
      emit(ctx, models, () => show.renderModels(models));
      return;
    }
    case 'use': {
      const used = await useModel(ctx, root(ctx), cache, inner.parsed.positionals[0]);
      emit(
        ctx,
        used,
        () => `${used.note}
`,
      );
      return;
    }
    case 'doctor': {
      const config = await loadProjectConfig(root(ctx));
      const doctor = await doctorModels(cache, config);
      emit(ctx, doctor, () => show.renderDoctor(doctor));
      return;
    }
    case 'install': {
      const id = need(inner, 0, 'model');
      const from = ctx.parsed.values.from
        ? resolve(ctx.environment.cwd, ctx.parsed.values.from)
        : undefined;
      if (from === undefined && !ctx.parsed.values.download) {
        throw new InvalidArgumentError(
          'install',
          'a source: --from <dir> (offline) or --download',
          undefined,
        );
      }
      const pooling = ctx.parsed.values.pooling;
      if (pooling !== undefined && pooling !== 'mean' && pooling !== 'cls') {
        throw new InvalidArgumentError('--pooling', 'mean or cls', pooling);
      }
      const maxTokens = integerOption('max-tokens', ctx.parsed.values['max-tokens']);
      const installed = await installModel(cache, id, {
        ...(from ? { from } : {}),
        ...(ctx.parsed.values.download ? { download: true } : {}),
        ...(pooling ? { pooling } : {}),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(ctx.parsed.values.force ? { replace: true } : {}),
      });
      emit(
        ctx,
        installed,
        () =>
          `installed ${installed.id} in ${isAbsolute(installed.directory) ? installed.directory : resolve(installed.directory)}\n`,
      );
      return;
    }
    case 'verify': {
      const id = need(inner, 0, 'model');
      const verified = await verifyModel(cache, id);
      emit(ctx, verified, () => `${id}: every file matches its recorded checksum\n`);
      return;
    }
    default:
      throw new InvalidArgumentError('model', 'list, use, install, verify or doctor', sub);
  }
}

export default defineCommand({
  id: 'extend:model',
  words: ['model'],
  help: {
    section: 'Extend',
    rank: 20,
    name: 'model <subcommand>',
    summary: 'local embedding models: list them, pick one, install',
    details:
      '  model list|use|install|verify|doctor   local embedding models: anvesa-code, open models such as\n                                         gte-modernbert-base, and your own. use [model] picks the one this\n                                         project uses (asks on a terminal; --download fetches it first).\n                                         install <new-name> --from <dir|file.onnx> brings your own\n                                         (--pooling, --max-tokens, --force)',
  },
  run: modelCommand,
});
