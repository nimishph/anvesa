import { parseArgs } from 'node:util';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';

/** Every option any command takes. A command that does not use one ignores it. */
const OPTIONS = {
  root: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  channel: { type: 'string', multiple: true },
  template: { type: 'string' },
  from: { type: 'string' },
  download: { type: 'boolean' },
  force: { type: 'boolean' },
  'retry-quarantined': { type: 'boolean' },
  depth: { type: 'string' },
  types: { type: 'boolean' },
  'resolved-only': { type: 'boolean' },
  expect: { type: 'string' },
  'no-embed': { type: 'boolean' },
  models: { type: 'string' },
  model: { type: 'string' },
  scope: { type: 'string' },
  user: { type: 'boolean' },
  pooling: { type: 'string' },
  samples: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  weight: { type: 'string', multiple: true },
  tier: { type: 'string' },
  resolution: { type: 'string' },
  labels: { type: 'string' },
  write: { type: 'boolean' },
  name: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'min-share': { type: 'string' },
  'max-tokens': { type: 'string' },
} as const;

export interface Parsed {
  readonly positionals: readonly string[];
  readonly values: {
    readonly root?: string;
    readonly json?: boolean;
    readonly help?: boolean;
    readonly limit?: string;
    readonly cursor?: string;
    readonly channel?: string[];
    readonly template?: string;
    readonly from?: string;
    readonly download?: boolean;
    readonly force?: boolean;
    readonly 'retry-quarantined'?: boolean;
    readonly depth?: string;
    readonly types?: boolean;
    readonly 'resolved-only'?: boolean;
    readonly expect?: string;
    readonly 'no-embed'?: boolean;
    readonly models?: string;
    readonly model?: string;
    readonly scope?: string;
    readonly user?: boolean;
    readonly pooling?: string;
    readonly samples?: string[];
    readonly exclude?: string[];
    readonly weight?: string[];
    readonly tier?: string;
    readonly resolution?: string;
    readonly labels?: string;
    readonly write?: boolean;
    readonly name?: string;
    readonly 'dry-run'?: boolean;
    readonly 'min-share'?: string;
    readonly 'max-tokens'?: string;
  };
}

export function parseOptions(argv: readonly string[]): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    return { values, positionals } as Parsed;
  } catch (failure) {
    throw new InvalidArgumentError(
      'arguments',
      'known options (see: anvesa --help)',
      argv.join(' '),
      {
        cause: failure,
      },
    );
  }
}

/** A whole number option, or `undefined` when absent. */
export function integerOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === 'all' || value === 'Infinity') return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`--${name}`, 'a positive whole number', value);
  }
  return parsed;
}
