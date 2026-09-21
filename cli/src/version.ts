import manifest from '../package.json' with { type: 'json' };

/** The version of the program, from its package manifest. */
export const VERSION: string = manifest.version;
