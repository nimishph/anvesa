import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * The section `init` keeps in a project's agent instruction file (AGENTS.md, CLAUDE.md, or a file
 * the user names), so a coding agent working in the project knows the tool is there and how to use
 * it. The section sits between two HTML comment markers that carry the tool's name and the version
 * that wrote it: everything outside the markers belongs to the user and is never touched, and
 * everything inside is replaced when `init` runs again — which is how a newer version delivers
 * newer guidance. The markers are the same shape in medha and anvesa, so both sections can live in
 * one file side by side.
 */

/** What happened to one instruction file. */
export type AgentFileState = 'created' | 'inserted' | 'updated' | 'current';

export interface AgentFileResult {
  /** Relative to the project root when inside it, else absolute. */
  readonly path: string;
  readonly state: AgentFileState;
  /** The version that wrote the section being replaced, when there was one. */
  readonly previousVersion: string | null;
}

/** The files `init` looks for when no file is named; the first is created when none exists. */
export const DEFAULT_AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function beginMarker(tool: string, version: string): string {
  return `<!-- ${tool}:begin v${version} — managed by \`${tool} init\`; edits between these markers are replaced on the next init -->`;
}

const endMarker = (tool: string): string => `<!-- ${tool}:end -->`;

/** Matches a whole managed section of `tool`, any version, capturing the version. */
function sectionPattern(tool: string): RegExp {
  return new RegExp(
    `<!-- ${escapeRegExp(tool)}:begin v([^\\s]+)[^\\n]*?-->[\\s\\S]*?<!-- ${escapeRegExp(tool)}:end -->`,
  );
}

/** The section as written into a file, markers included, without a trailing newline. */
export function renderSection(tool: string, version: string, body: string): string {
  return `${beginMarker(tool, version)}\n${body.trim()}\n${endMarker(tool)}`;
}

/**
 * Put the section into `text`: replace an existing one in place, or append one after a blank line.
 * Returns the new text and the version of the section it replaced (null when there was none).
 */
export function upsertSection(
  text: string,
  tool: string,
  version: string,
  body: string,
): { readonly text: string; readonly previousVersion: string | null } {
  const crlf = text.includes('\r\n');
  const section = renderSection(tool, version, body);
  const normalized = crlf ? text.replace(/\r\n/g, '\n') : text;
  const found = sectionPattern(tool).exec(normalized);
  let next: string;
  if (found !== null) {
    next =
      normalized.slice(0, found.index) + section + normalized.slice(found.index + found[0].length);
  } else if (normalized.trim() === '') {
    next = `${section}\n`;
  } else {
    next = `${normalized.replace(/\s*$/, '')}\n\n${section}\n`;
  }
  return { text: crlf ? next.replace(/\n/g, '\r\n') : next, previousVersion: found?.[1] ?? null };
}

/**
 * Which files to write. A named file is used as given (relative to the project root) and created
 * if missing. Otherwise every default file that exists is used — except CLAUDE.md when it only
 * pulls in AGENTS.md (`@AGENTS.md`) or is the same file, so the section is not read twice — and
 * AGENTS.md is created when neither exists.
 */
export function agentTargets(projectRoot: string, named?: string): readonly string[] {
  if (named !== undefined) return [isAbsolute(named) ? named : resolve(projectRoot, named)];
  const existing = DEFAULT_AGENT_FILES.map((name) => join(projectRoot, name)).filter((path) =>
    existsSync(path),
  );
  if (existing.length === 0) return [join(projectRoot, DEFAULT_AGENT_FILES[0])];
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const path of existing) {
    const real = realpathSync(path);
    if (seen.has(real)) continue;
    seen.add(real);
    if (path.endsWith('CLAUDE.md') && targets.length > 0 && importsAgentsFile(path)) continue;
    targets.push(path);
  }
  return targets;
}

function importsAgentsFile(path: string): boolean {
  return /^\s*@\.?\/?AGENTS\.md\s*$/m.test(readFileSync(path, 'utf8'));
}

/** Write the section into each target and say what happened to each. */
export function applyAgentSection(
  projectRoot: string,
  targets: readonly string[],
  tool: string,
  version: string,
  body: string,
): readonly AgentFileResult[] {
  return targets.map((path) => {
    const exists = existsSync(path);
    const before = exists ? readFileSync(path, 'utf8') : '';
    const { text, previousVersion } = upsertSection(before, tool, version, body);
    const state: AgentFileState = !exists
      ? 'created'
      : text === before
        ? 'current'
        : previousVersion === null
          ? 'inserted'
          : 'updated';
    if (state !== 'current') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    }
    const inside = relative(projectRoot, path);
    return {
      path: inside.startsWith('..') || isAbsolute(inside) ? path : inside,
      state,
      previousVersion,
    };
  });
}

/** One line per file, for the text output of `init`. */
export function renderAgentFiles(tool: string, results: readonly AgentFileResult[]): string[] {
  return results.map((result) => {
    if (result.state === 'created') return `created ${result.path} with the ${tool} section`;
    if (result.state === 'inserted') return `added the ${tool} section to ${result.path}`;
    if (result.state === 'updated') {
      return `updated the ${tool} section in ${result.path} (was v${result.previousVersion})`;
    }
    return `${result.path}: ${tool} section is current`;
  });
}
