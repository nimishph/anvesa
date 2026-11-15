import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as show from '../../../render.ts';
import { defineCommand } from '../../shared/command.ts';
import { root } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'project:status',
  words: ['status'],
  help: {
    section: 'Get started',
    rank: 1,
    name: 'status',
    summary: 'what is indexed, and by which channels and model',
    details: '  status                    what is indexed, and by which channels and model',
  },
  run: async (ctx, services) => {
    const projectRoot = root(ctx);
    const anvesaDir = join(projectRoot, '.anvesa');
    if (!existsSync(anvesaDir)) {
      const unindexedStatus = {
        root: projectRoot,
        indexed: false,
        index: {
          files: 0,
          quarantinedFiles: 0,
          symbols: 0,
          calls: 0,
          imports: 0,
          edges: 0,
          byLanguage: [],
        },
        interrupted: false,
        embedder: undefined,
        indexedModels: [],
        structural: { files: 0, missing: [] },
        channels: [],
      };
      emit(ctx, unindexedStatus, () => `project ${projectRoot}\nnot indexed (run: anvesa index)`);
      return;
    }

    await services.withProject(ctx, { embed: true }, async ({ retriever }) => {
      const status = await retriever.status();
      emit(ctx, status, () => show.renderStatus(status));
    });
  },
});
