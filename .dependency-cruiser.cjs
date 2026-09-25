// Boundaries for the medha packages. The graph is one-way:
// cli -> retriever -> indexer -> dense -> structural -> syntax -> core. Cross-package imports must go through a
// package's public entry point (src/index.ts), never into its internals.

/** package -> the only workspace packages it may import. */
const ALLOWED = {
  core: [],
  syntax: ['core'],
  structural: ['core', 'syntax'],
  dense: ['core', 'syntax', 'structural'],
  indexer: ['core', 'syntax', 'structural', 'dense'],
  // Implements dense's Embedder with a local model. Nothing in the pipeline depends on it but
  // the interfaces above.
  embedder: ['core', 'dense'],
  retriever: ['core', 'syntax', 'structural', 'dense', 'indexer', 'embedder'],
  cli: ['core', 'retriever'],
  // Measures the others; nothing may depend on it.
  eval: ['core', 'syntax', 'structural', 'dense', 'indexer', 'retriever'],
};

const names = Object.keys(ALLOWED);

const dependencyRules = names.map((pkg) => ({
  name: `${pkg}-allowed-deps`,
  severity: 'error',
  comment: `${pkg} may only depend on: ${ALLOWED[pkg].join(', ') || '(nothing)'}`,
  from: { path: `^${pkg}/src` },
  to: {
    path: `^(${names.filter((n) => n !== pkg && !ALLOWED[pkg].includes(n)).join('|')})/src`,
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...dependencyRules,
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'public-entry-only',
      severity: 'error',
      comment: 'Import another package through its index.ts, not its internals.',
      from: { path: `^(${names.join('|')})/src` },
      to: {
        path: String.raw`^(${names.join('|')})/src/(?!index\.ts$)`,
        pathNot: ['^$1/src'],
      },
    },
    {
      name: 'no-import-from-host-repo',
      severity: 'error',
      comment: 'packages/ must stay extractable: nothing may reach above this directory.',
      from: { path: '^[^/]+/src' },
      to: { path: String.raw`^\.\./` },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
