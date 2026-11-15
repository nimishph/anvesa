import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { FederatedRetriever } from '@cntxt-labs/anvesa-retriever';
import * as show from '../../../render.ts';
import { defineCommand, type Services } from '../../shared/command.ts';
import type { Context } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

async function federationCommand(ctx: Context, services: Services): Promise<void> {
  const [sub] = ctx.parsed.positionals;
  if (!sub || sub !== 'status') {
    throw new InvalidArgumentError('federation', 'status', sub);
  }
  return services.withProject(ctx, { embed: false }, async ({ retriever }) => {
    const fed = new FederatedRetriever(retriever);
    try {
      const statuses = await fed.status();
      emit(ctx, statuses, () => show.renderFederationStatus(statuses));
    } finally {
      await fed.close();
    }
  });
}

export default defineCommand({
  id: 'search:federation',
  words: ['federation'],
  help: {
    section: 'Index',
    rank: 6,
    name: 'federation <subcommand>',
    summary: 'multi-repository workspace federation status',
    details:
      '  federation status         inspect federated repositories configured in .anvesa/workspace.json',
  },
  run: federationCommand,
});
