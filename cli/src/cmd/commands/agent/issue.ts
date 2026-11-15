import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../../../version.ts';
import { defineCommand } from '../../shared/command.ts';
import { root } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'agent:issue',
  words: ['issue'],
  help: {
    section: 'Agents and help',
    rank: 25,
    name: 'issue [title]',
    summary: 'raise an issue on GitHub with sanitized diagnostics',
    details: '  issue [title]             raise an issue on GitHub with sanitized diagnostics',
  },
  run: async (ctx, services) => {
    const title = ctx.parsed.positionals.join(' ').trim() || 'Issue / Feedback';
    const projectRoot = root(ctx);
    const anvesaDir = join(projectRoot, '.anvesa');

    let workspaceStats = 'None (no index found)';
    if (existsSync(anvesaDir)) {
      try {
        const session = await services.openSession(ctx, { embed: false });
        try {
          const status = await session.retriever.status();
          const langs = status.index.byLanguage.map((l) => `${l.language} (${l.files})`).join(', ');
          workspaceStats = `files: ${status.index.files}, symbols: ${status.index.symbols}, languages: ${langs || 'none'}, quarantined: ${status.index.quarantinedFiles}`;
        } finally {
          await session.close();
        }
      } catch (err) {
        workspaceStats = `None (could not read index: ${err instanceof Error ? err.message : String(err)})`;
      }
    }

    const runtime = (process.versions as Record<string, string>).bun
      ? `bun ${(process.versions as Record<string, string>).bun}`
      : `node ${process.version}`;

    const body = [
      '### Description',
      '<!-- Describe the issue, unexpected behavior, or enhancement -->',
      '',
      '### Steps to Reproduce',
      '1. ',
      '',
      '### Expected Behavior',
      '',
      '### Diagnostics (Sanitized)',
      `- **Anvesa Version**: ${VERSION}`,
      `- **Platform**: ${process.platform} (${process.arch})`,
      `- **Runtime**: ${runtime}`,
      `- **Workspace**: ${workspaceStats}`,
      '',
    ].join('\n');

    const repoUrl = 'https://github.com/nimishph/anvesa/issues/new';
    const fullUrl = `${repoUrl}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

    let openedBrowser = false;
    if (!ctx.parsed.values.json && !ctx.environment.env.CI) {
      try {
        if (process.platform === 'win32') {
          Bun.spawn(['cmd', '/c', 'start', '""', fullUrl], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          openedBrowser = true;
        } else if (process.platform === 'darwin') {
          Bun.spawn(['open', fullUrl], { stdout: 'ignore', stderr: 'ignore' });
          openedBrowser = true;
        } else if (process.platform === 'linux') {
          Bun.spawn(['xdg-open', fullUrl], { stdout: 'ignore', stderr: 'ignore' });
          openedBrowser = true;
        }
      } catch {
        openedBrowser = false;
      }
    }

    emit(
      ctx,
      { title, url: fullUrl, body, openedBrowser },
      () => `Issue URL: ${fullUrl}\n${openedBrowser ? '(Opened in your default browser)\n' : ''}`,
    );
  },
});
