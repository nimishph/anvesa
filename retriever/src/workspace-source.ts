import type { InputFile, InputSource } from '@sutras/code-lens-dense';
import { inputFile } from '@sutras/code-lens-dense';
import { readSource, type Workspace, walkSources } from '@sutras/code-lens-indexer';

/**
 * The source files of a workspace as an `InputSource`, so a channel that reads project files can
 * be brought up to date the same way as one that reads records from somewhere else.
 */
export function workspaceSource(workspace: Workspace, name = 'workspace'): InputSource {
  return {
    name,
    async *files(): AsyncGenerator<InputFile> {
      for await (const entry of walkSources(workspace)) {
        const content = await readSource(workspace.root, entry.path);
        if (content.kind !== 'text') continue;
        yield inputFile(entry.path, content.content, { language: entry.language });
      }
    },
  };
}
