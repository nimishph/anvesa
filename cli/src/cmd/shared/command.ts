/**
 * What a command is: an id of the form `resource:cmd_name`, the words a person types to run it, its
 * help, and `run`, which receives the command line and the services it may use. A test can hand
 * `run` fake services without building an `Environment`.
 */

import type { ModelCache } from '@cntxt-labs/anvesa-retriever';
import { CommandRegistryError } from '../../errors.ts';
import type { Context, Session, SessionOptions } from './context.ts';

export const SECTIONS = [
  'Get started',
  'Index',
  'Search',
  'Code graph',
  'Extend',
  'Safety',
  'Agents and help',
] as const;

export type Section = (typeof SECTIONS)[number];

/** A command's entry in the help. Commands that share one entry share one line in the overview. */
export interface HelpEntry {
  readonly section: Section;
  /** Where it stands in the overview: lower first, across every section. */
  readonly rank: number;
  /** As the overview names it: `search <question>`, `channel <subcommand>`. */
  readonly name: string;
  readonly summary: string;
  /** Everything about it: what `anvesa <command> --help` prints. */
  readonly details: string;
}

/** What `run` may use besides the command line. */
export interface Services {
  openSession(ctx: Context, options: SessionOptions): Promise<Session>;
  /** Run against an open project, and close it whatever happens. */
  withProject<T>(
    ctx: Context,
    options: SessionOptions,
    run: (session: Session) => Promise<T>,
  ): Promise<T>;
  modelCache(ctx: Context): ModelCache;
  /** Ask the person, or `undefined` when nobody is there to answer. */
  prompt(ctx: Context, question: string): Promise<string | undefined>;
  /** Milliseconds, for timing a run. */
  now(): number;
}

export interface Command {
  /** `resource:cmd_name`: `graph:callers`, `extend:model`. Stable; what the registry keys on. */
  readonly id: string;
  /** The first words on the command line that run it. */
  readonly words: readonly string[];
  readonly help: HelpEntry;
  /**
   * A command that keeps running (a server) counts its own run through `ctx.onServing`, once it is
   * serving, instead of being counted when `run` returns.
   */
  readonly countsItself?: boolean;
  run(ctx: Context, services: Services): Promise<void>;
}

const ID = /^[a-z]+:[a-z_-]+$/;

/** Declare a command. The id is checked here, so a malformed one fails on load, not on use. */
export function defineCommand(command: Command): Command {
  if (!ID.test(command.id))
    throw new CommandRegistryError(command.id, 'its id is not resource:cmd_name');
  if (command.words.length === 0) throw new CommandRegistryError(command.id, 'it has no words');
  return command;
}
