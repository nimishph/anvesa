/**
 * Copies the two markdown files that already ship publicly (README.md, SKILL.md) into the site as
 * pages, so the site never becomes a second, drifting copy of them.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const out = new URL('../', import.meta.url);

function rewriteLinks(markdown) {
  return markdown
    .replace(/\]\(SKILL\.md\)/g, '](/agent-skill)')
    .replace(/\]\(README\.md\)/g, '](/overview)');
}

function frontmatter({ title, description, body }) {
  const own = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const carried = own === null
    ? []
    : own[1]
        .split(/\r?\n/)
        .filter((line) => /^[A-Za-z_][\w-]*:/.test(line))
        .filter((line) => !/^(title|description|headmatter|outline|editLink):/.test(line));
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    'outline: [2, 3]',
    'editLink: false',
    ...(carried.length === 0 ? [] : ['', ...carried]),
    '---',
    '',
    body.replace(own?.[0] ?? '', '').trim(),
    '',
  ].join('\n');
}

await mkdir(out, { recursive: true });

// Sync README.md -> overview.md
const readme = await readFile(new URL('README.md', root), 'utf8');
await writeFile(
  new URL('overview.md', out),
  frontmatter({
    title: 'Anvesa Architecture & Overview',
    description: 'Find code by meaning and by structure. Hybrid dense + structural code intelligence.',
    body: rewriteLinks(readme),
  }),
);

// Sync SKILL.md -> agent-skill.md if exists
const skillPath = new URL('skills/anvesa/SKILL.md', root);
if (existsSync(skillPath)) {
  const skill = await readFile(skillPath, 'utf8');
  await writeFile(
    new URL('agent-skill.md', out),
    frontmatter({
      title: 'Anvesa Agent Skill',
      description: 'Comprehensive cheatsheet and guidance for AI agents integrating with Anvesa.',
      body: rewriteLinks(skill),
    }),
  );
}

console.log('✓ Successfully synced overview.md and agent-skill.md for VitePress docs.');
