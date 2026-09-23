export type { Embedder, InputFile, InputSource } from '@cntxt-labs/code-lens-dense';
export { inputFile } from '@cntxt-labs/code-lens-dense';
export type {
  DriftReport,
  FragmentManifest,
  IndexEvent,
  IndexReport,
  RunOptions,
} from '@cntxt-labs/code-lens-indexer';
export type {
  Golden,
  GoldenDifference,
  MappingCheck,
  StoredMapping,
  TrainingIssue,
  TrainingReport,
} from '@cntxt-labs/code-lens-structural';
export { npmPackageSource, SyntaxRuntime } from '@cntxt-labs/code-lens-syntax';
export { type LoadedChannel, loadChannelModule } from './channel-module.ts';
export * from './config.ts';
export * from './errors.ts';
export type { Contribution, Fused, Lane } from './fuse.ts';
export { DEFAULT_RRF_K, fuse } from './fuse.ts';
export * from './grammars.ts';
export * from './insight.ts';
export * from './mappings.ts';
export * from './models.ts';
export * from './pattern-runner.ts';
export * from './redteam.ts';
export { fenceUntrusted } from './render.ts';
export * from './retriever.ts';
export { type StructuralCoverage, StructuralLane } from './structural-lane.ts';
export { workspaceSource } from './workspace-source.ts';
