import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_SCHEMA_URL, PROJECT_CONFIG_PATH } from '@cntxt-labs/anvesa-retriever';
import { agentTargets, applyAgentSection, renderAgentFiles } from '../../../agent-instructions.ts';
import { renderSetup, setupProject } from '../../../init.ts';
import { VERSION } from '../../../version.ts';
import { defineCommand } from '../../shared/command.ts';
import { startDirectory } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

interface ScaffoldFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Put `$schema` first in a config that has none, keeping every other key, value and their order,
 * the file's indentation and line endings. A `$schema` already there, whatever its value, stays.
 */
async function addSchemaToConfig(path: string): Promise<'added' | 'present' | 'invalid'> {
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid';
  if ('$schema' in parsed) return 'present';
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? 2;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = JSON.stringify({ $schema: CONFIG_SCHEMA_URL, ...parsed }, null, indent);
  await writeFile(path, `${next.replace(/\n/g, eol)}${eol}`, 'utf8');
  return 'added';
}

/** `init`'s starter files: valid, minimal, and safe to run `anvesa index` against as-is. */
function scaffoldFiles(): readonly ScaffoldFile[] {
  return [
    {
      path: '.anvesaignore',
      content:
        '# anvesa reads this like .gitignore, at every directory level, alongside .gitignore\n' +
        '# itself. node_modules, .anvesa, .sutra and __pycache__ are already skipped by\n' +
        "# default; add patterns below for anything else this project doesn't want indexed.\n",
    },
    {
      // Hardcoded rather than imported: cli may depend on retriever but not indexer directly
      // (see .dependency-cruiser.cjs), and this is the one file whose schema lives there.
      path: '.anvesa/workspace.json',
      content: `${JSON.stringify(
        {
          version: 1,
          packages: [],
          discover: true,
          exclude: [],
          nestedRepos: 'include',
          followSymlinks: false,
        },
        null,
        2,
      )}\n`,
    },
    {
      path: PROJECT_CONFIG_PATH,
      content: `${JSON.stringify({ $schema: CONFIG_SCHEMA_URL, channels: {} }, null, 2)}\n`,
    },
  ];
}

/**
 * The section `init` keeps in the project's AGENTS.md / CLAUDE.md (see agent-instructions.ts), so a
 * coding agent working in the project reaches for anvesa. Re-running `init` after an upgrade
 * replaces it with the guidance of the new version.
 */
export const AGENT_SECTION = `## Code search: anvesa

This repository is indexed by anvesa (dense + structural code retrieval, fused). Prefer it over
grep when you look for code by what it does or how it is shaped:

- \`anvesa search "<what the code does>"\` finds code by behavior or concept.
- \`anvesa query '//function[@name="foo"]'\` finds definitions by structure (WQL; \`anvesa primer wql\`).
- \`anvesa callers <symbol>\` / \`anvesa callees <symbol>\` trace the call graph.
- \`anvesa dependents <path>\` lists who imports a file: the blast radius before a change.
- \`anvesa map\` gives a ranked overview of the repository's architecture.
- Plain grep/ripgrep is still right for an exact string.

\`anvesa index\` brings the index up to date (incremental; run it after large changes).
\`anvesa primer [topic]\` explains any of this in a few lines. If an \`anvesa\` MCP server is
connected, its tools do the same.`;

export default defineCommand({
  id: 'project:init',
  words: ['init'],
  help: {
    section: 'Get started',
    rank: 0,
    name: 'init',
    summary: 'set up a project: config files, an encoder and parsers',
    details:
      '  init                      scaffold .anvesaignore, .anvesa/workspace.json, .anvesa/config.json\n                            (--force to overwrite files that already exist), then looks at this machine and\n                            project: offers a parser for each language that lacks one and the anvesa skill, then\n                            ends with anvesa model use, the model this machine suits as the default, with a\n                            progress bar per download. Asks on a terminal;\n                            --yes accepts the proposals; --model <id> picks the encoder; --no-download only\n                            reports what it would fetch. Nothing downloads without a yes. Also keeps an\n                            anvesa section in AGENTS.md / CLAUDE.md (created as AGENTS.md if neither\n                            exists; --agents-file <path> names another file, --no-agents-file skips it).\n                            Re-run after an upgrade: kept files stay, the section is refreshed. Offers the\n                            anvesa skill for an agent (--agent claude|opencode|codex; --no-skill skips it).',
  },
  run: async (ctx, services) => {
    const projectRoot = startDirectory(ctx);
    const created: string[] = [];
    const kept: string[] = [];
    for (const file of scaffoldFiles()) {
      const absolute = join(projectRoot, file.path);
      if (existsSync(absolute) && !ctx.parsed.values.force) {
        kept.push(file.path);
        continue;
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, 'utf8');
      created.push(file.path);
    }
    // A config kept from before still gets `$schema`, so editors validate it; nothing else changes.
    const schemaNote = kept.includes(PROJECT_CONFIG_PATH)
      ? await addSchemaToConfig(join(projectRoot, PROJECT_CONFIG_PATH))
      : undefined;
    const updated = schemaNote === 'added' ? [PROJECT_CONFIG_PATH] : [];
    // Always refreshed, --force or not: the user's text is outside the markers and stays.
    const agentFiles =
      ctx.parsed.values['no-agents-file'] === true
        ? []
        : applyAgentSection(
            projectRoot,
            agentTargets(projectRoot, ctx.parsed.values['agents-file']),
            'anvesa',
            VERSION,
            AGENT_SECTION,
          );
    const setup = await setupProject(ctx, projectRoot, services.modelCache(ctx));
    const agentLines = renderAgentFiles('anvesa', agentFiles);
    emit(
      ctx,
      { created, kept, updated, agentFiles, setup },
      () =>
        `${created.map((f) => `created ${f}`).join('\n')}${created.length ? '\n' : ''}${kept.map((f) => `kept ${f} (already exists; use --force to overwrite)`).join('\n')}${kept.length ? '\n' : ''}${updated.map((f) => `updated ${f} (added $schema)\n`).join('')}${schemaNote === 'invalid' ? `note: ${PROJECT_CONFIG_PATH} is not a JSON object; left as it is\n` : ''}${agentLines.map((line) => `${line}\n`).join('')}${renderSetup(setup)}`,
    );
  },
});
