export type { CloneGroup, CloneOccurrence, CloneOptions, CloneSource } from './clones.ts';
export { findClones } from './clones.ts';
export type { IndexedFile, IndexQueryOptions, IndexQueryResult } from './corpus.ts';
export { StructuralIndex } from './corpus.ts';
export type {
  CorpusAdapter,
  CorpusClaimContext,
  CorpusExtractContext,
  CorpusRecord,
} from './corpus-adapter.ts';
export {
  DocblockAnnotationCorpusAdapter,
  docblockAnnotationAdapter,
  RouteEndpointCorpusAdapter,
  routeEndpointAdapter,
} from './corpus-adapter.ts';
export type {
  ChangeKind,
  StructuralDiff,
  SymbolChange,
  SymbolRef,
} from './diff.ts';
export { diffStructure } from './diff.ts';
export type {
  BodyKind,
  BodyShape,
  EncodeOptions,
  EncodeResult,
  EncodeStats,
  Shape,
} from './encode.ts';
export { classifyBody, encodeTree, shapeOf } from './encode.ts';
export type {
  EncodedFile,
  EncodeSourceOptions,
  QueryDirectOptions,
  QueryDirectResult,
  StructuralEngineOptions,
} from './engine.ts';
export { StructuralEngine } from './engine.ts';
export * from './errors.ts';
export type { WqlHit } from './hits.ts';
export { toHit } from './hits.ts';
export type {
  CallRule,
  CompiledMapping,
  ImportRule,
  LanguageMapping,
  RegisterOptions,
  SymbolKind,
  SymbolRule,
} from './mapping.ts';
export {
  builtinMappings,
  compileMapping,
  MappingRegistry,
  validateMapping,
} from './mapping.ts';
export type {
  MappingCheck,
  MappingStoreOptions,
  MappingTier,
  StoredMapping,
} from './mapping-store.ts';
export { MappingStore, mappingFileText } from './mapping-store.ts';
export type { LineRange, WalkEntry, WNode } from './node.ts';
export {
  ATTR,
  attrOf,
  countNodes,
  DIGEST_HEX_LENGTH,
  KNOWN_ATTRIBUTES,
  lineRange,
  makeNode,
  shortDigest,
  walk,
} from './node.ts';
export * from './pattern/compiler.ts';
export * from './pattern/schema.ts';
export { Wql, WqlConstraint, WqlSpec } from './spec.ts';
export type { OutlineSymbol } from './symbols.ts';
export { outlineSymbols } from './symbols.ts';
export type { FormatOptions } from './text.ts';
export {
  escapeValue,
  formatWExpr,
  parseWExpr,
  serializeWExpr,
  WEXPR_FORMAT_VERSION,
} from './text.ts';
export type {
  Deduction,
  Golden,
  GoldenDifference,
  GoldenSample,
  TagCheck,
  Topology,
  TrainedMapping,
  TrainingIssue,
  TrainingReport,
  TrainingSample,
  TrainOptions,
  TypeStats,
  Verification,
} from './training.ts';
export {
  checkGolden,
  deduceMapping,
  inspectTopology,
  registryWith,
  synthesizeGolden,
  trainMapping,
  verifyMapping,
} from './training.ts';
export type {
  MatchContext,
  WqlMatch,
  WqlOp,
  WqlPredicate,
  WqlQuery,
  WqlStep,
} from './wql.ts';
export {
  isCallableTag,
  isCallableVirtualTag,
  looksLikeWql,
  matchWql,
  nodeMatchesStep,
  parseWql,
} from './wql.ts';
