import type { InputFile, InputSource } from '@cntxt-labs/anvesa-dense';
import { inputFile } from '@cntxt-labs/anvesa-dense';
import { readSource, type Workspace, walkSources } from '@cntxt-labs/anvesa-indexer';

/**
 * The source files of a workspace as an `InputSource`, so a channel that reads project files can
 * be brought up to date the same way as one that reads records from somewhere else.
 */
export function workspaceSource(
  workspace: Workspace,
  name = 'workspace',
  /** Also offer files that are not source (docs, notes) when the channel claims them, as `index` does. */
  alsoOffer?: (path: string) => boolean,
): InputSource {
  return {
    name,
    async *files(): AsyncGenerator<InputFile> {
      for await (const entry of walkSources(workspace, alsoOffer ? { alsoOffer } : {})) {
        const content = await readSource(workspace.root, entry.path);
        if (content.kind !== 'text') continue;
        yield inputFile(entry.path, content.content, { language: entry.language });
      }
    },
  };
}
