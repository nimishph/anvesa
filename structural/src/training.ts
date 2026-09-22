import { createHash } from 'node:crypto';
import type { Deadline } from '@cntxt-labs/code-lens-core';
import type { SyntaxNode, SyntaxRuntime } from '@cntxt-labs/code-lens-syntax';
import { StructuralEngine } from './engine.ts';
import { MappingTrainingError } from './errors.ts';
import { type LanguageMapping, MappingRegistry, validateMapping } from './mapping.ts';
import { ATTR, countNodes, walk } from './node.ts';
import { outlineSymbols } from './symbols.ts';

/** A source file to learn from. */
export interface TrainingSample {
  readonly path: string;
  readonly content: string;
}

// --- what a grammar looks like in real code ------------------------------------------------------

/** How often a kind of syntax node occurred, and what it was made of and found inside. */
export interface TypeStats {
  count: number;
  /** Field name to the types of the children that filled it, with counts. */
  readonly fields: Map<string, Map<string, number>>;
  readonly parents: Map<string, number>;
  /** Types that enclose it at any depth, with the number of occurrences that had one. */
  readonly ancestors: Map<string, number>;
  /** Types of its named children, whatever field they were in. */
  readonly children: Map<string, number>;
}

/** The node types of one grammar, as they occur in a set of samples. Plain data. */
export interface Topology {
  readonly language: string;
  readonly samples: number;
  readonly nodes: number;
  readonly types: ReadonlyMap<string, TypeStats>;
  /** Samples the grammar could not fully parse. What was learned from them may be incomplete. */
  readonly withSyntaxErrors: readonly string[];
}

const bump = <K>(map: Map<K, number>, key: K): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

function statsFor(types: Map<string, TypeStats>, type: string): TypeStats {
  let found = types.get(type);
  if (!found) {
    found = {
      count: 0,
      fields: new Map(),
      parents: new Map(),
      ancestors: new Map(),
      children: new Map(),
    };
    types.set(type, found);
  }
  return found;
}

/**
 * Parse the samples and record, for every kind of named syntax node, which fields it fills, what
 * fills them, and what it sits inside. The mapping is deduced from this, not from the names of
 * the node types alone: a node with a `name` field and a `body` declares something, whatever the
 * grammar calls it.
 */
export async function inspectTopology(
  runtime: SyntaxRuntime,
  language: string,
  samples: readonly TrainingSample[],
  options: { readonly deadline?: Deadline } = {},
): Promise<Topology> {
  const types = new Map<string, TypeStats>();
  const withSyntaxErrors: string[] = [];
  let nodes = 0;

  for (const sample of samples) {
    options.deadline?.throwIfExpired(`learn from ${sample.path}`);
    await runtime.withTree(
      sample.content,
      { language },
      (tree) => {
        if (tree.hasErrors) withSyntaxErrors.push(sample.path);
        // Depth-first with an explicit stack: source can nest deeper than the call stack allows.
        const path: string[] = [];
        const open = new Map<string, number>();
        type Frame = {
          node: SyntaxNode;
          parent: SyntaxNode | undefined;
          field: string | undefined;
          exit: boolean;
        };
        const stack: Frame[] = [
          { node: tree.root, parent: undefined, field: undefined, exit: false },
        ];
        while (stack.length > 0) {
          const frame = stack.pop() as Frame;
          if (frame.exit) {
            const type = path.pop() as string;
            const remaining = (open.get(type) as number) - 1;
            if (remaining === 0) open.delete(type);
            else open.set(type, remaining);
            continue;
          }
          const { node, parent } = frame;
          if (node.isError || node.isMissing) continue;
          nodes += 1;
          const stats = statsFor(types, node.type);
          stats.count += 1;
          if (parent) {
            bump(stats.parents, parent.type);
          }
          for (const ancestor of open.keys()) bump(stats.ancestors, ancestor);

          path.push(node.type);
          open.set(node.type, (open.get(node.type) ?? 0) + 1);
          stack.push({ node, parent, field: undefined, exit: true });

          const children: Frame[] = [];
          for (let index = 0; index < node.childCount; index += 1) {
            const child = node.child(index);
            if (!child?.isNamed) continue;
            const field = node.fieldNameForChild(index) ?? undefined;
            bump(stats.children, child.type);
            if (field !== undefined) {
              let byType = stats.fields.get(field);
              if (!byType) {
                byType = new Map();
                stats.fields.set(field, byType);
              }
              bump(byType, child.type);
            }
            children.push({ node: child, parent: node, field, exit: false });
          }
          for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as Frame);
        }
      },
      { path: sample.path },
    );
  }
  return { language, samples: samples.length, nodes, types, withSyntaxErrors };
}

// --- deducing the mapping ------------------------------------------------------------------------

/** What a node type was taken to be, and the evidence, so a person can judge the mapping. */
export interface Deduction {
  readonly type: string;
  readonly tag: string;
  readonly role: 'declaration' | 'anonymous-callable' | 'call' | 'import' | 'control-flow';
  readonly occurrences: number;
  /** For a declaration or import: the type of the child holding its name, when one was found. */
  readonly nameChild?: string;
  /** Share of occurrences that had a `name` field, for a declaration. */
  readonly nameShare?: number;
}

export interface TrainingIssue {
  readonly code:
    | 'NO_DECLARATIONS'
    | 'FEW_OCCURRENCES'
    | 'UNNAMED_DECLARATIONS'
    | 'SYNTAX_ERRORS'
    | 'ROUND_TRIP'
    | 'NO_SYMBOLS';
  readonly message: string;
}

export interface TrainOptions {
  /** Mapping name. Defaults to the language key. */
  readonly name?: string;
  readonly extensions: readonly string[];
  /**
   * Share of a node type's occurrences that must have the evidence for a role (a `name` field for a
   * declaration) before it is given that role. 0.5 by default; the share is reported for each.
   */
  readonly minShare?: number;
  /** Fewest occurrences for a type to be considered confident; fewer are reported, not dropped. */
  readonly minOccurrences?: number;
}

export interface TrainedMapping {
  readonly mapping: LanguageMapping;
  readonly deductions: readonly Deduction[];
  readonly issues: readonly TrainingIssue[];
}

const DECLARATION_KINDS: readonly (readonly [RegExp, string])[] = [
  [/method/, 'method'],
  [/(^|_)(function|func|fn|procedure|subroutine|constructor)($|_)/, 'function'],
  [/interface|protocol/, 'interface'],
  [/trait/, 'trait'],
  [/enum/, 'enum'],
  [/struct|record|union/, 'struct'],
  [/class|object_declaration|object_definition/, 'class'],
  [/(^|_)(type_alias|type_spec|type_item|type_declaration|type_definition|typedef)($|_)/, 'type'],
  [/(^|_)(namespace|mod|module|package)($|_)/, 'module'],
  [/(^|_)(const|constant)($|_)/, 'constant'],
];

/**
 * A node with a name and a body that still is not a declaration: a struct literal, an enum variant,
 * a parameter. What the type is called says so, because the fields cannot.
 */
const NOT_A_DECLARATION =
  /parameter|argument|(^|_)pair($|_)|property_identifier|(^|_)enumerator$|(^|_)member(_|$)|^preproc_|_(expression|literal|variant|constant|clause)$/;

/** Is this control word being used as a control construct, and not as part of something else? */
function isControlType(type: string, word: string): boolean {
  if (word === 'try') return /_statement$/.test(type);
  return /_(statement|expression|clause)$/.test(type) || type === word;
}

const CALLABLE_EXPRESSION =
  /lambda|arrow|closure|anonymous_function|function_expression|func_literal/;
/** Types whose bodies hold members. A module or namespace holds functions, not methods. */
const MEMBER_HOLDER = /class|struct|impl|trait|interface|object|record|enum/;
const IMPORT = /(^|_)(import|use|include|require|using)($|_)/;
const CONTROL: readonly string[] = [
  'if',
  'for',
  'while',
  'switch',
  'match',
  'try',
  'catch',
  'except',
  'with',
  'return',
  'yield',
  'throw',
  'raise',
  'assert',
];
const IMPORT_SOURCE_FIELDS = ['source', 'path', 'module_name', 'module', 'name', 'argument'];

/** The most frequent key of a count map. Ties go to the first seen, which is deterministic. */
function commonest(counts: ReadonlyMap<string, number> | undefined): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [key, count] of counts ?? []) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

const fieldCount = (stats: TypeStats, field: string): number =>
  [...(stats.fields.get(field)?.values() ?? [])].reduce((sum, n) => sum + n, 0);

const hasField = (stats: TypeStats, pattern: RegExp): boolean =>
  [...stats.fields.keys()].some((field) => pattern.test(field));

function kindOf(type: string): string | undefined {
  return DECLARATION_KINDS.find(([pattern]) => pattern.test(type))?.[1];
}

/**
 * Deduce a mapping from a topology. Roles come from how a node type is built:
 * - a declaration has a `name` field (in at least `minShare` of its occurrences) and a body or a
 *   kind word in its type; a `name` field alone is a parameter or an argument, not a declaration;
 * - a call has an `arguments` field and something being called;
 * - imports and control flow are recognised by the words in their type, since a grammar has no
 *   field for "this is an import".
 * Each decision is returned with its evidence; what could not be decided is an issue.
 */
export function deduceMapping(topology: Topology, options: TrainOptions): TrainedMapping {
  const minShare = options.minShare ?? 0.5;
  const minOccurrences = options.minOccurrences ?? 3;
  const nodeTypeMap: Record<string, string> = {};
  const nameExtractors: Record<string, string> = {};
  const structural = new Set<string>();
  const callable = new Set<string>();
  const deductions: Deduction[] = [];
  const issues: TrainingIssue[] = [];
  const unnamed: string[] = [];

  const importTypes = new Set(
    [...topology.types.keys()].filter((type) => IMPORT.test(type) && !type.startsWith('_')),
  );

  for (const [type, stats] of [...topology.types].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (type.startsWith('_') || type === 'ERROR') continue;
    const nameShare = fieldCount(stats, 'name') / stats.count;
    const named = nameShare >= minShare;
    const hasBody = hasField(
      stats,
      /^(body|block|members|declaration_list|field_declaration_list)$/,
    );
    const hasParameters = hasField(stats, /param/i);
    const kindWord = kindOf(type);

    // A call: arguments plus something being called, and no body of its own. A `name` field is
    // the thing called only when the type says it is a call (a Java annotation has both too).
    if (
      !hasBody &&
      hasField(stats, /^arguments?$/) &&
      (hasField(stats, /^(function|callee|method|receiver|object)$/) ||
        (hasField(stats, /^name$/) && /call|invocation|apply/.test(type)))
    ) {
      nodeTypeMap[type] = 'call';
      deductions.push({ type, tag: 'call', role: 'call', occurrences: stats.count });
      continue;
    }

    // Control flow comes before declarations: a Java `for (T x : xs)` has a name and a body too.
    const word = CONTROL.find((candidate) => new RegExp(`(^|_)${candidate}($|_)`).test(type));
    if (word && isControlType(type, word)) {
      nodeTypeMap[type] = word;
      structural.add(word);
      deductions.push({ type, tag: word, role: 'control-flow', occurrences: stats.count });
      continue;
    }

    // An import: named as one, and not a piece of another (`import_specifier` in `import_clause`).
    if (importTypes.has(type)) {
      const parent = commonest(stats.parents);
      if (parent !== undefined && importTypes.has(parent)) continue;
      const source = IMPORT_SOURCE_FIELDS.map((field) => commonest(stats.fields.get(field))).find(
        (found) => found !== undefined,
      );
      nodeTypeMap[type] = 'import';
      structural.add('import');
      if (source) nameExtractors[type] = source;
      deductions.push({
        type,
        tag: 'import',
        role: 'import',
        occurrences: stats.count,
        ...(source ? { nameChild: source } : {}),
      });
      continue;
    }

    // A declaration: it names itself and has a body (or is plainly one of the declaring kinds).
    if (named && (hasBody || kindWord !== undefined) && !NOT_A_DECLARATION.test(type)) {
      let tag = kindWord ?? type;
      if (tag === 'function') {
        // The same node type is a method when it only ever occurs inside an enclosing type.
        const enclosing = [...stats.ancestors]
          .filter(([ancestor]) => MEMBER_HOLDER.test(ancestor))
          .reduce((most, [, count]) => Math.max(most, count), 0);
        if (enclosing === stats.count) tag = 'method';
      }
      nodeTypeMap[type] = tag;
      structural.add(tag);
      const nameChild = commonest(stats.fields.get('name'));
      if (nameChild) nameExtractors[type] = nameChild;
      if (tag === 'function' || tag === 'method') callable.add(tag);
      deductions.push({
        type,
        tag,
        role: 'declaration',
        occurrences: stats.count,
        nameShare,
        ...(nameChild ? { nameChild } : {}),
      });
      continue;
    }
    if (hasBody && hasParameters && !named && CALLABLE_EXPRESSION.test(type)) {
      const tag = /arrow/.test(type) ? 'arrow' : /closure/.test(type) ? 'closure' : 'lambda';
      nodeTypeMap[type] = tag;
      structural.add(tag);
      callable.add(tag);
      deductions.push({ type, tag, role: 'anonymous-callable', occurrences: stats.count });
      continue;
    }
    if (
      hasBody &&
      !named &&
      kindWord === undefined &&
      !/^(block|body)/.test(type) &&
      /_(declaration|definition|item)$/.test(type) &&
      !CONTROL.some((word) => new RegExp(`(^|_)${word}($|_)`).test(type))
    ) {
      unnamed.push(type);
    }
  }

  for (const deduction of deductions) {
    if (deduction.occurrences < minOccurrences && deduction.role !== 'control-flow') {
      issues.push({
        code: 'FEW_OCCURRENCES',
        message: `${deduction.type} (as ${deduction.tag}) was seen ${deduction.occurrences} time${deduction.occurrences === 1 ? '' : 's'}; more samples would make this sure`,
      });
    }
  }
  if (!deductions.some((d) => d.role === 'declaration')) {
    issues.push({
      code: 'NO_DECLARATIONS',
      message:
        'no node type looked like a declaration (a name field and a body). The samples may hold none, or this grammar names things in a way that is not a field (as C does with declarators)',
    });
  }
  if (unnamed.length > 0) {
    issues.push({
      code: 'UNNAMED_DECLARATIONS',
      message: `these node types have a body but no name field, so they are not mapped as declarations: ${unnamed.join(', ')}`,
    });
  }
  if (topology.withSyntaxErrors.length > 0) {
    issues.push({
      code: 'SYNTAX_ERRORS',
      message: `${topology.withSyntaxErrors.length} of ${topology.samples} samples did not parse cleanly, so what was learned from them may be incomplete: ${topology.withSyntaxErrors.join(', ')}`,
    });
  }

  const mapping = validateMapping(
    {
      name: options.name ?? topology.language,
      version: '1.0.0',
      extensions: options.extensions,
      nodeTypeMap,
      structuralTags: [...structural].sort(),
      nameExtractors,
      ...(callable.size > 0 ? { callableTags: [...callable].sort() } : {}),
    },
    `trained ${topology.language}`,
  );
  return { mapping, deductions, issues };
}

// --- checking a mapping against the code it came from --------------------------------------------

export interface TagCheck {
  readonly tag: string;
  /** Syntax nodes of the types that map to this tag, in the samples. */
  readonly expected: number;
  /** Nodes of this tag in the encoded outlines. */
  readonly found: number;
}

export interface Verification {
  readonly tags: readonly TagCheck[];
  readonly symbols: number;
  readonly issues: readonly TrainingIssue[];
}

/** A registry that serves `mapping` for `language` and nothing that it would clash with. */
export function registryWith(
  mapping: LanguageMapping,
  languages: readonly string[],
): MappingRegistry {
  const registry = new MappingRegistry();
  registry.override(mapping, { languages });
  return registry;
}

/**
 * Encode the samples with the mapping and compare with what the grammar has: every syntax node of
 * a mapped structural type must come out as a node of that tag, and declarations must yield named
 * symbols. A difference means the mapping does not do what the deduction claimed.
 */
export async function verifyMapping(
  runtime: SyntaxRuntime,
  language: string,
  mapping: LanguageMapping,
  samples: readonly TrainingSample[],
  topology: Topology,
  options: { readonly deadline?: Deadline } = {},
): Promise<Verification> {
  const engine = new StructuralEngine({ runtime, mappings: registryWith(mapping, [language]) });
  const structural = new Set(mapping.structuralTags);
  const expected = new Map<string, number>();
  for (const [type, tag] of Object.entries(mapping.nodeTypeMap)) {
    if (!structural.has(tag)) continue;
    expected.set(tag, (expected.get(tag) ?? 0) + (topology.types.get(type)?.count ?? 0));
  }
  const found = new Map<string, number>();
  let symbols = 0;
  for (const sample of samples) {
    options.deadline?.throwIfExpired(`verify ${sample.path}`);
    const encoded = await engine.encode(sample.content, { language }, { path: sample.path });
    for (const { node } of walk(encoded.root)) {
      if (structural.has(node.tag)) found.set(node.tag, (found.get(node.tag) ?? 0) + 1);
    }
    symbols += outlineSymbols(encoded.root).length;
  }
  const tags: TagCheck[] = [...expected].map(([tag, count]) => ({
    tag,
    expected: count,
    found: found.get(tag) ?? 0,
  }));
  const issues: TrainingIssue[] = [];
  for (const check of tags) {
    if (check.expected !== check.found) {
      issues.push({
        code: 'ROUND_TRIP',
        message: `${check.expected} syntax nodes should become "${check.tag}", but ${check.found} did`,
      });
    }
  }
  const declares = Object.values(mapping.nodeTypeMap).some((tag) =>
    [
      'function',
      'method',
      'class',
      'interface',
      'trait',
      'enum',
      'struct',
      'type',
      'module',
    ].includes(tag),
  );
  if (declares && symbols === 0) {
    issues.push({
      code: 'NO_SYMBOLS',
      message: 'the mapping declares things, but the outlines of the samples hold no named symbol',
    });
  }
  return { tags, symbols, issues };
}

export interface TrainingReport extends TrainedMapping {
  readonly topology: Topology;
  readonly verification: Verification;
  readonly golden: Golden;
}

/** Learn a mapping from samples, check it against them, and record what it does to them. */
export async function trainMapping(
  runtime: SyntaxRuntime,
  language: string,
  samples: readonly TrainingSample[],
  options: TrainOptions & { readonly deadline?: Deadline },
): Promise<TrainingReport> {
  if (samples.length === 0) {
    throw new MappingTrainingError(language, 'there are no sample files to learn from');
  }
  const topology = await inspectTopology(runtime, language, samples, options);
  if (topology.nodes === 0) {
    throw new MappingTrainingError(language, 'the samples held no syntax nodes at all');
  }
  const trained = deduceMapping(topology, options);
  const verification = await verifyMapping(
    runtime,
    language,
    trained.mapping,
    samples,
    topology,
    options,
  );
  const golden = await synthesizeGolden(runtime, language, trained.mapping, samples, options);
  return {
    ...trained,
    issues: [...trained.issues, ...verification.issues],
    topology,
    verification,
    golden,
  };
}

// --- golden records ------------------------------------------------------------------------------

/** What a mapping did to one sample: the tags it produced and the symbols it found. */
export interface GoldenSample {
  readonly path: string;
  /** Hash of the sample, so a changed sample is recognised as such and not as a regression. */
  readonly sha256: string;
  readonly nodes: number;
  readonly tags: Readonly<Record<string, number>>;
  readonly symbols: readonly {
    readonly kind: string;
    readonly name: string;
    readonly line: number | undefined;
  }[];
}

export interface Golden {
  readonly language: string;
  readonly mapping: string;
  readonly samples: readonly GoldenSample[];
}

async function describeSample(
  engine: StructuralEngine,
  language: string,
  sample: TrainingSample,
): Promise<GoldenSample> {
  const encoded = await engine.encode(sample.content, { language }, { path: sample.path });
  const tags: Record<string, number> = {};
  for (const { node } of walk(encoded.root)) tags[node.tag] = (tags[node.tag] ?? 0) + 1;
  return {
    path: sample.path,
    sha256: createHash('sha256').update(sample.content).digest('hex'),
    nodes: countNodes(encoded.root),
    tags: Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))),
    symbols: outlineSymbols(encoded.root).map((symbol) => {
      const line = symbol.node.attrs.get(ATTR.line);
      return {
        kind: symbol.kind,
        name: symbol.name,
        line: line === undefined ? undefined : Number(line),
      };
    }),
  };
}

export async function synthesizeGolden(
  runtime: SyntaxRuntime,
  language: string,
  mapping: LanguageMapping,
  samples: readonly TrainingSample[],
  options: { readonly deadline?: Deadline } = {},
): Promise<Golden> {
  const engine = new StructuralEngine({ runtime, mappings: registryWith(mapping, [language]) });
  const described: GoldenSample[] = [];
  for (const sample of samples) {
    options.deadline?.throwIfExpired(`record ${sample.path}`);
    described.push(await describeSample(engine, language, sample));
  }
  return { language, mapping: mapping.name, samples: described };
}

export interface GoldenDifference {
  readonly path: string;
  readonly problem: string;
}

/**
 * Run a mapping over the samples again and say where it now differs from a golden record: a mapping
 * edited by hand, or a grammar updated underneath it. Samples that themselves changed are reported
 * as changed, not as regressions.
 */
export async function checkGolden(
  runtime: SyntaxRuntime,
  mapping: LanguageMapping,
  golden: Golden,
  samples: readonly TrainingSample[],
  options: { readonly deadline?: Deadline } = {},
): Promise<readonly GoldenDifference[]> {
  const engine = new StructuralEngine({
    runtime,
    mappings: registryWith(mapping, [golden.language]),
  });
  const byPath = new Map(samples.map((sample) => [sample.path, sample]));
  const differences: GoldenDifference[] = [];
  for (const recorded of golden.samples) {
    options.deadline?.throwIfExpired(`check ${recorded.path}`);
    const sample = byPath.get(recorded.path);
    if (!sample) {
      differences.push({ path: recorded.path, problem: 'the sample is not here to check' });
      continue;
    }
    const now = await describeSample(engine, golden.language, sample);
    if (now.sha256 !== recorded.sha256) {
      differences.push({
        path: recorded.path,
        problem: 'the sample changed since it was recorded',
      });
    } else if (JSON.stringify(now) !== JSON.stringify(recorded)) {
      differences.push({ path: recorded.path, problem: describeChange(recorded, now) });
    }
  }
  return differences;
}

function describeChange(before: GoldenSample, now: GoldenSample): string {
  const tags = new Set([...Object.keys(before.tags), ...Object.keys(now.tags)]);
  const changed = [...tags]
    .filter((tag) => before.tags[tag] !== now.tags[tag])
    .map((tag) => `${tag} ${before.tags[tag] ?? 0} -> ${now.tags[tag] ?? 0}`);
  const symbolNames = (sample: GoldenSample) =>
    sample.symbols.map((s) => `${s.kind} ${s.name}`).join('|');
  return (
    [
      changed.length > 0 ? `tags differ: ${changed.join(', ')}` : undefined,
      symbolNames(before) !== symbolNames(now)
        ? `symbols differ: ${before.symbols.length} recorded, ${now.symbols.length} now`
        : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; ') || 'the outline differs'
  );
}
