import { InvalidArgumentError, toCodeLensError } from '@cntxt-labs/anvesa-core';
import { loadProjectConfig, type ProjectConfig } from '@cntxt-labs/anvesa-retriever';
import { CommandFailedError } from '../../../errors.ts';
import {
  readTelemetryChoice,
  reminderQuieted,
  telemetryQueueState,
  telemetryStatus,
  userConfigFile,
  writeTelemetryChoice,
} from '../../../telemetry.ts';
import { defineCommand } from '../../shared/command.ts';
import { root } from '../../shared/context.ts';
import { emit } from '../../shared/output.ts';

export default defineCommand({
  id: 'agent:telemetry',
  words: ['telemetry'],
  help: {
    section: 'Agents and help',
    rank: 23,
    name: 'telemetry [status|on|off|quiet|notice]',
    summary: 'anonymous usage telemetry: what it is doing, and turning it on or off',
    details:
      '  telemetry [status|on|off]  anonymous usage telemetry (see README.md#telemetry): status says whether\n                             this run would send and why; on and off are kept in ~/.anvesa/config.json\n  telemetry quiet|notice     hide, or show again, the line index, search and query print while it is on',
  },
  run: async (ctx) => {
    const env = ctx.environment.env;
    const sub = ctx.parsed.positionals[0] ?? 'status';
    const kept = readTelemetryChoice(env);
    const change =
      sub === 'on' || sub === 'off'
        ? // Either answer is the person's own, so the notice is owed no more.
          { ...kept, enabled: sub === 'on', notice_shown: true }
        : sub === 'quiet'
          ? { ...kept, show_notice: false }
          : sub === 'notice'
            ? { ...kept, show_notice: true }
            : undefined;
    if (change) {
      const problem = writeTelemetryChoice(env, change);
      if (problem !== undefined) throw new CommandFailedError(`telemetry ${sub}`, problem);
    } else if (sub !== 'status') {
      throw new InvalidArgumentError('telemetry', 'status, on, off, quiet or notice', sub);
    }
    let config: ProjectConfig | undefined;
    try {
      config = await loadProjectConfig(root(ctx));
    } catch (failure) {
      // A project whose config does not load can still be asked about telemetry; say why its
      // own setting is not counted.
      ctx.environment.stderr(
        `note: ${toCodeLensError(failure, 'read .anvesa/config.json').message}; its telemetry setting is not counted\n`,
      );
    }
    const status = telemetryStatus({
      ...(config ? { config } : {}),
      noNetwork: ctx.parsed.values['no-network'] === true,
      env,
    });
    const file = userConfigFile(env);
    const quiet = reminderQuieted(env, config);
    const queue = status.queueFile ? telemetryQueueState(status.queueFile) : undefined;
    const value = {
      active: status.active,
      reason: status.reason,
      choice: readTelemetryChoice(env),
      showNotice: !quiet,
      ...(status.endpoint ? { endpoint: status.endpoint } : {}),
      ...(status.logFile ? { logFile: status.logFile } : {}),
      ...(file ? { configFile: file } : {}),
      ...(status.queueFile && queue
        ? {
            queueFile: status.queueFile,
            waiting: queue.waiting,
            nextSendAt: new Date(queue.nextSendAt).toISOString(),
          }
        : {}),
    };
    emit(ctx, value, () =>
      [
        `telemetry: ${status.active ? 'on' : status.needsNotice ? 'on, once the notice has been shown in a terminal' : 'off'}${status.active || status.needsNotice ? '' : ` (${status.reason})`}`,
        ...(status.endpoint ? [`sends to:  ${status.endpoint} (at most one batch a day)`] : []),
        ...(status.queueFile && queue
          ? [
              `waiting:   ${queue.waiting} event(s) in ${status.queueFile}`,
              `next send: ${
                queue.nextSendAt <= Date.now()
                  ? `with the next run${queue.waiting === 0 ? ' that records events' : ''}`
                  : `not before ${new Date(queue.nextSendAt).toLocaleString()}`
              }`,
            ]
          : []),
        ...(status.logFile ? [`writes to: ${status.logFile}`] : []),
        `notice:    ${quiet ? 'hidden (show it again: anvesa telemetry notice)' : 'one line on each index, search and query (hide it: anvesa telemetry quiet)'}`,
        ...(file ? [`kept in:   ${file} (preferences.telemetry)`] : []),
        'what is sent: README.md#telemetry; turn off: anvesa telemetry off, or DO_NOT_TRACK=1',
        '',
      ].join('\n'),
    );
  },
});
