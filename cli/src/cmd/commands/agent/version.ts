import { VERSION } from '../../../version.ts';
import { defineCommand } from '../../shared/command.ts';

/** Answered before the command line is parsed, so `anvesa --version` needs nothing else. */
export default defineCommand({
  id: 'agent:version',
  words: ['--version', 'version', '-v'],
  help: {
    section: 'Agents and help',
    rank: 27,
    name: '--version',
    summary: 'print the version',
    details: '  --version                 print the version',
  },
  run: async (ctx) => {
    ctx.environment.stdout(`anvesa ${VERSION}\n`);
  },
});
