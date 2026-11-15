import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ModelCache, Retriever } from '@cntxt-labs/anvesa-retriever';
import {
  COMMANDS_DIRECTORY,
  commandFiles,
  GENERATED_FILE,
  renderCommandIndex,
} from '../../scripts/gen-command-index.ts';
import { CommandRegistryError } from '../errors.ts';
import { parseOptions } from '../options.ts';
import { COMMAND_MODULES } from './commands.generated.ts';
import { buildRegistry, REGISTRY } from './registry.ts';
import { defineCommand, type Services } from './shared/command.ts';
import type { Session } from './shared/context.ts';

describe('command registry', () => {
  test('the generated index matches the commands folder', () => {
    // Adding a command is: add a module, run bun run cli/scripts/gen-command-index.ts.
    const onDisk = readFileSync(GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(renderCommandIndex(commandFiles(COMMANDS_DIRECTORY)));
  });

  test('every module declares one command, by a resource:cmd_name id', () => {
    expect(COMMAND_MODULES).toHaveLength(commandFiles().length);
    for (const command of REGISTRY.commands) expect(command.id).toMatch(/^[a-z]+:[a-z_-]+$/);
    expect(REGISTRY.byWord('callers')?.id).toBe('graph:callers');
    expect(REGISTRY.byWord('model')?.id).toBe('extend:model');
    expect(REGISTRY.byWord('-v')?.id).toBe('agent:version');
    expect(REGISTRY.byId('search:query')?.words).toEqual(['query']);
  });

  test('commands that share a help entry share its line, with every word as a key', () => {
    const line = REGISTRY.help.find((entry) => entry.keys.includes('neighbors'));
    expect([...(line?.keys ?? [])].sort()).toEqual(['callees', 'callers', 'neighbors']);
  });

  test('a malformed id, a duplicate id or a word two commands claim is refused', () => {
    const base = REGISTRY.byId('graph:explain');
    if (!base) throw new CommandRegistryError('graph:explain', 'missing');
    expect(() => defineCommand({ ...base, id: 'explain' })).toThrow(CommandRegistryError);
    expect(() => buildRegistry([...COMMAND_MODULES, base])).toThrow(/declared twice/);
    const thief = { ...base, id: 'graph:other' };
    expect(() => buildRegistry([...COMMAND_MODULES, thief])).toThrow(/already runs graph:explain/);
  });

  test('run takes its services, so a test can pass fakes instead of opening a project', async () => {
    const out: string[] = [];
    const retriever = { explain: async () => ({ languages: ['ts'] }) } as unknown as Retriever;
    const session: Session = { retriever, embedderReason: 'fake', close: async () => undefined };
    const services: Services = {
      openSession: async () => session,
      withProject: async (_ctx, _options, run) => run(session),
      modelCache: () => ({}) as ModelCache,
      prompt: async () => undefined,
      now: () => 0,
    };
    const ctx = {
      environment: {
        cwd: '.',
        env: {},
        stdout: (t: string) => out.push(t),
        stderr: () => undefined,
      },
      parsed: parseOptions(['--json']),
    };
    await REGISTRY.byId('graph:explain')?.run(ctx, services);
    expect(JSON.parse(out.join(''))).toEqual({ languages: ['ts'] });
  });
});
