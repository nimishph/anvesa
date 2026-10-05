import { createHash } from 'node:crypto';
import type { Deadline } from '@cntxt-labs/anvesa-core';
import { loadRustSyntax, type SyntaxNode, type SyntaxRuntime } from '@cntxt-labs/anvesa-syntax';
import { StructuralEngine } from './engine.ts';
import { MappingTrainingError } from './errors.ts';
import { type LanguageMapping, MappingRegistry, validateMapping } from './mapping.ts';
import { isNativeLanguage } from './native.ts';
import { ATTR, countNodes, walk } from './node.ts';
import { outlineSymbols } from './symbols.ts';
import { parseTagsQuery, type TagRule } from './tags.ts';

/** A source file to learn from. */
export interface TrainingSample {
  readonly path: string;
  readonly content: string;
}

// --- what a grammar looks like in real code ------------------------------------------------------

/** How often a kind of syntax node occurred, and what it was made of and found inside. */
export interface TypeStats {
  count: number;
  /** Samples it occurred in at least once: evidence spread, not just volume. */
  files: number;
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
      files: 0,
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
  options: { readonly deadline?: Deadline; readonly native?: boolean } = {},
): Promise<Topology> {
  if (options.native !== false && isNativeLanguage(language)) {
    options.deadline?.throwIfExpired(`learn from ${samples.length} samples`);
    const native = inspectTopologyNative(language, samples);
    if (native) return native;
  }
  const types = new Map<string, TypeStats>();
  const withSyntaxErrors: string[] = [];
  let nodes = 0;

  for (const sample of samples) {
    options.deadline?.throwIfExpired(`learn from ${sample.path}`);
    const seen = new Set<string>();
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
          if (!seen.has(node.type)) {
            seen.add(node.type);
            stats.files += 1;
          }
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

type Pairs<V> = readonly (readonly [string, V])[];

interface RawTopology {
  readonly language: string;
  readonly samples: number;
  readonly nodes: number;
  readonly types: Pairs<{
    readonly count: number;
    readonly files: number;
    readonly fields: Pairs<Pairs<number>>;
    readonly parents: Pairs<number>;
    readonly ancestors: Pairs<number>;
    readonly children: Pairs<number>;
  }>;
  readonly withSyntaxErrors: readonly string[];
}

/** Node-type statistics of samples, gathered natively; `undefined` without the grammar or addon. */
function inspectTopologyNative(
  language: string,
  samples: readonly { readonly path: string; readonly content: string }[],
): Topology | undefined {
  const inspect = loadRustSyntax()?.inspectTopologyNative;
  if (!inspect) return undefined;
  const json = inspect(
    language,
    samples.map((sample) => ({ path: sample.path, language, source: sample.content })),
  );
  if (json === null) return undefined;
  const raw = JSON.parse(json) as RawTopology;
  const types = new Map<string, TypeStats>();
  for (const [type, stats] of raw.types) {
    types.set(type, {
      count: stats.count,
      files: stats.files,
      fields: new Map(stats.fields.map(([field, counts]) => [field, new Map(counts)])),
      parents: new Map(stats.parents),
      ancestors: new Map(stats.ancestors),
      children: new Map(stats.children),
    });
  }
  return {
    language: raw.language,
    samples: raw.samples,
    nodes: raw.nodes,
    types,
    withSyntaxErrors: raw.withSyntaxErrors,
  };
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
    | 'NO_SYMBOLS'
    | 'TOO_FEW_SAMPLES';
  readonly message: string;
}

export interface TrainOptions {
  /** Mapping name. Defaults to the base mapping's name, or the language key. */
  readonly name?: string;
  readonly extensions: readonly string[];
  /**
   * Share of a node type's occurrences that must have the evidence for a role (a `name` field for a
   * declaration) before it is given that role. 0.5 by default; the share is reported for each.
   */
  readonly minShare?: number;
  /**
   * Fewest occurrences for a type to be considered confident. Without a base they are reported,
   * not dropped; extending a base, a type seen fewer times is not added.
   */
  readonly minOccurrences?: number;
  /**
   * The mapping to extend. What it maps stays as it is; what is learned can only add node types it
   * does not map, so a few samples cannot unlearn what the base knows.
   */
  readonly base?: LanguageMapping;
  /** Extending a base: fewest distinct samples a node type must occur in to be added. 1 by default. */
  readonly minFiles?: number;
  /** Fewest samples to learn from before what is learned is trusted. No floor by default. */
  readonly minSamples?: number;
  /**
   * Asked about the node types that heuristics and the base left undecided. It sees statistics
   * only, never source text, and every answer is checked against the samples before it is used.
   */
  readonly assist?: Assistant;
  /**
   * The grammar's `queries/tags.scm`. Its definitions and calls are what the grammar's authors say,
   * so they take the place of what the heuristics deduce; a base mapping still has the last word.
   */
  readonly tags?: string;
}

/** What a tags query added, and which of its rules could not be used and why. */
export interface TagsOutcome {
  readonly rules: number;
  readonly applied: readonly Deduction[];
  readonly skipped: readonly {
    readonly type: string;
    readonly tag: string;
    readonly reason: string;
  }[];
}

/** Something that suggests tags for node types; in practice a language model. */
export type Assistant = (
  candidates: readonly AssistCandidate[],
) => Promise<{ readonly model: string; readonly suggestions: readonly AssistSuggestion[] }>;

/** A node type left undecided, described by how it occurs in the samples and nothing more. */
export interface AssistCandidate {
  readonly type: string;
  readonly occurrences: number;
  readonly files: number;
  /** Field names it fills, with the child types seen in each. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** Its commonest parents and named children, most frequent first. */
  readonly parents: readonly string[];
  readonly children: readonly string[];
}

export interface AssistSuggestion {
  readonly type: string;
  /** One of {@link ASSIST_TAGS}, or `none` to leave the type transparent. */
  readonly tag: string;
  /** For a declaration: the child type that holds its name. */
  readonly nameChild?: string;
}

/** What was asked, what came back, and what of it held up against the samples. */
export interface AssistOutcome {
  readonly model: string;
  readonly asked: number;
  readonly accepted: readonly Deduction[];
  /** Answers that were not used, and why: the record of what the assistant got wrong. */
  readonly rejected: readonly {
    readonly type: string;
    readonly tag: string;
    readonly reason: string;
  }[];
  /** Node types it chose to leave transparent. */
  readonly declined: number;
}

const ASSIST_DECLARATIONS: readonly string[] = [
  'function',
  'method',
  'class',
  'interface',
  'struct',
  'enum',
  'trait',
  'type',
  'module',
  'constant',
];
const ASSIST_ANONYMOUS = ['lambda', 'closure', 'arrow'];
/** The only tags an assistant may give; anything else is rejected, not trusted. */
export const ASSIST_TAGS: readonly string[] = [
  ...ASSIST_DECLARATIONS,
  ...ASSIST_ANONYMOUS,
  'import',
  'call',
  ...['if', 'for', 'while', 'switch', 'match', 'try', 'catch', 'except', 'with'],
  ...['return', 'yield', 'throw', 'raise', 'assert'],
];

/** What extending a base mapping added to it, and what it chose not to add and why. */
export interface Extension {
  readonly base: string;
  readonly added: readonly Deduction[];
  readonly skipped: readonly {
    readonly type: string;
    readonly tag: string;
    readonly reason: string;
  }[];
}

export interface TrainedMapping {
  readonly mapping: LanguageMapping;
  readonly deductions: readonly Deduction[];
  readonly issues: readonly TrainingIssue[];
  /** Present when a base mapping was extended rather than replaced. */
  readonly extension?: Extension;
  /** Present when an assistant was asked about what was left undecided. */
  readonly assist?: AssistOutcome;
  /** Present when the grammar's tags query was read. */
  readonly tags?: TagsOutcome;
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

  // A clause that sits in a construct with the same tag (Python's `with_clause` in its
  // `with_statement`) would put every such construct in the outline twice.
  for (let index = deductions.length - 1; index >= 0; index -= 1) {
    const deduction = deductions[index] as Deduction;
    if (deduction.role !== 'control-flow') continue;
    const parent = commonest(topology.types.get(deduction.type)?.parents);
    if (parent !== undefined && nodeTypeMap[parent] === deduction.tag) {
      Reflect.deleteProperty(nodeTypeMap, deduction.type);
      deductions.splice(index, 1);
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

/**
 * Lay what was learned over a base mapping. Every node type the base maps keeps the base's tag and
 * name extractor. A learned type is added only when
 * - its usual parent is not something the base maps: the base already decided how that construct
 *   reads (Python's comprehension clauses, the clause of a `with`), and a learned tag inside it would
 *   change what a query for that tag finds;
 * - it was seen often enough, in enough distinct samples, that one odd file cannot teach it.
 */
export function extendMapping(
  base: LanguageMapping,
  trained: TrainedMapping,
  topology: Topology,
  options: TrainOptions,
): TrainedMapping {
  const minOccurrences = options.minOccurrences ?? 3;
  const minFiles = options.minFiles ?? 1;
  const nodeTypeMap: Record<string, string> = { ...base.nodeTypeMap };
  const nameExtractors: Record<string, string> = { ...base.nameExtractors };
  const structural = [...base.structuralTags];
  const callable = base.callableTags ? [...base.callableTags] : undefined;
  const learnedStructural = new Set(trained.mapping.structuralTags);
  const learnedCallable = new Set(trained.mapping.callableTags ?? []);
  const added: Deduction[] = [];
  const skipped: { type: string; tag: string; reason: string }[] = [];

  for (const deduction of trained.deductions) {
    const { type, tag } = deduction;
    if (base.nodeTypeMap[type] !== undefined) continue;
    const stats = topology.types.get(type);
    const parent = commonest(stats?.parents);
    const parentTag = parent === undefined ? undefined : base.nodeTypeMap[parent];
    if (parentTag !== undefined) {
      skipped.push({
        type,
        tag,
        reason: `it sits in ${parent}, which ${base.name} already maps as ${parentTag}`,
      });
      continue;
    }
    const files = stats?.files ?? 0;
    if (deduction.occurrences < minOccurrences || files < minFiles) {
      skipped.push({
        type,
        tag,
        reason: `seen ${deduction.occurrences} times in ${files} files; adding needs ${minOccurrences} in ${minFiles}`,
      });
      continue;
    }
    nodeTypeMap[type] = tag;
    if (learnedStructural.has(tag) && !structural.includes(tag)) structural.push(tag);
    if (callable && learnedCallable.has(tag) && !callable.includes(tag)) callable.push(tag);
    const nameChild = trained.mapping.nameExtractors[type];
    if (nameChild !== undefined && nameExtractors[type] === undefined) {
      nameExtractors[type] = nameChild;
    }
    added.push(deduction);
  }

  const mapping = validateMapping(
    {
      ...base,
      name: options.name ?? base.name,
      extensions: [...new Set([...base.extensions, ...options.extensions])],
      nodeTypeMap,
      structuralTags: structural,
      nameExtractors,
      ...(callable ? { callableTags: callable } : {}),
    },
    `${base.name} extended`,
  );
  // The base declares things and judged its own types; what is left is about the samples.
  const issues = trained.issues.filter(
    (issue) => issue.code !== 'NO_DECLARATIONS' && issue.code !== 'FEW_OCCURRENCES',
  );
  return {
    ...trained,
    mapping,
    issues,
    extension: { base: base.name, added, skipped },
  };
}

// --- what the grammar's own tags query says -------------------------------------------------------

/**
 * Lay a tags query's rules over what the heuristics deduced. A rule is used when its node type
 * occurs in the samples, maps to an outline tag, and (for a declaration) names a direct child that
 * the samples show it having. A name captured deeper than that (C's declarators) cannot be followed
 * by a mapping and is reported, not guessed at.
 */
export function applyTagRules(
  deduced: TrainedMapping,
  topology: Topology,
  rules: readonly TagRule[],
): TrainedMapping {
  const nodeTypeMap: Record<string, string> = { ...deduced.mapping.nodeTypeMap };
  const nameExtractors: Record<string, string> = { ...deduced.mapping.nameExtractors };
  const structural = new Set(deduced.mapping.structuralTags);
  const callable = deduced.mapping.callableTags ? new Set(deduced.mapping.callableTags) : undefined;
  const applied: Deduction[] = [];
  const skipped: { type: string; tag: string; reason: string }[] = [];

  for (const rule of rules) {
    const { type } = rule;
    const tag = rule.tag || `definition.${rule.kind}`;
    const skip = (reason: string) => skipped.push({ type, tag, reason });
    if (rule.tag === '') {
      skip(`@definition.${rule.kind} has no outline tag`);
      continue;
    }
    if (rule.within !== undefined) {
      skip(`the query means it only inside ${rule.within}, and a mapping tags it everywhere`);
      continue;
    }
    const stats = topology.types.get(type);
    if (!stats) {
      skip('it does not occur in the samples, so it cannot be checked');
      continue;
    }
    if (rule.role === 'declaration') {
      if (rule.nestedName) {
        skip('its name is captured below a direct child, which a mapping cannot follow');
        continue;
      }
      if (rule.nameChild === undefined) {
        skip('the query captures no @name for it');
        continue;
      }
      if (!stats.children.has(rule.nameChild)) {
        skip(`the samples never show it with a ${rule.nameChild} child`);
        continue;
      }
      nameExtractors[type] = rule.nameChild;
    }
    nodeTypeMap[type] = rule.tag;
    if (rule.role !== 'call') structural.add(rule.tag);
    if (callable && (rule.tag === 'function' || rule.tag === 'method')) callable.add(rule.tag);
    applied.push({
      type,
      tag: rule.tag,
      role: rule.role,
      occurrences: stats.count,
      ...(rule.nameChild !== undefined ? { nameChild: rule.nameChild } : {}),
    });
  }

  const mapping = validateMapping(
    {
      ...deduced.mapping,
      nodeTypeMap,
      structuralTags: [...structural].sort(),
      nameExtractors,
      ...(callable ? { callableTags: [...callable].sort() } : {}),
    },
    `${deduced.mapping.name} with tags`,
  );
  const fromTags = new Set(applied.map((deduction) => deduction.type));
  const declares = applied.some((deduction) => deduction.role === 'declaration');
  return {
    ...deduced,
    mapping,
    deductions: [
      ...deduced.deductions.filter((deduction) => !fromTags.has(deduction.type)),
      ...applied,
    ],
    // The grammar's authors vouch for what the query names; few occurrences is a heuristic worry.
    issues: deduced.issues.filter(
      (issue) =>
        !(declares && issue.code === 'NO_DECLARATIONS') &&
        !(issue.code === 'FEW_OCCURRENCES' && fromTags.has(issue.message.split(' ')[0] ?? '')),
    ),
    tags: { rules: rules.length, applied, skipped },
  };
}

// --- asking for help with what is left ----------------------------------------------------------

/**
 * The node types worth asking about: seen often enough in enough files, not mapped, not a leaf,
 * and not inside a construct the mapping already describes (it would be read as part of that
 * construct). Most frequent first, at most `limit`.
 */
export function assistCandidates(
  mapping: LanguageMapping,
  topology: Topology,
  options: {
    readonly minOccurrences?: number;
    readonly minFiles?: number;
    readonly limit?: number;
  } = {},
): AssistCandidate[] {
  const minOccurrences = options.minOccurrences ?? 3;
  const minFiles = options.minFiles ?? 1;
  const ranked = (counts: ReadonlyMap<string, number>, top: number): string[] =>
    [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([key]) => key);
  const candidates: AssistCandidate[] = [];
  for (const [type, stats] of topology.types) {
    if (type.startsWith('_') || type === 'ERROR') continue;
    if (mapping.nodeTypeMap[type] !== undefined) continue;
    if (stats.count < minOccurrences || stats.files < minFiles) continue;
    if (stats.children.size === 0 && stats.fields.size === 0) continue;
    const parent = commonest(stats.parents);
    if (parent !== undefined && mapping.nodeTypeMap[parent] !== undefined) continue;
    candidates.push({
      type,
      occurrences: stats.count,
      files: stats.files,
      fields: Object.fromEntries(
        [...stats.fields]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([field, types]) => [field, ranked(types, 3)]),
      ),
      parents: ranked(stats.parents, 3),
      children: ranked(stats.children, 5),
    });
  }
  return candidates
    .sort((a, b) => b.occurrences - a.occurrences || a.type.localeCompare(b.type))
    .slice(0, options.limit ?? 60);
}

/**
 * Check an assistant's answers against the samples and add the ones that hold up. An answer is
 * rejected when it is about a type that was not asked about, gives a tag outside
 * {@link ASSIST_TAGS}, answers a type twice, repeats the tag of something it always sits in, or
 * makes something a declaration with a name the samples never show. What is accepted only adds:
 * nothing already mapped changes.
 */
export function applySuggestions(
  mapping: LanguageMapping,
  topology: Topology,
  candidates: readonly AssistCandidate[],
  suggestions: readonly AssistSuggestion[],
  model: string,
): { readonly mapping: LanguageMapping; readonly outcome: AssistOutcome } {
  const asked = new Set(candidates.map((candidate) => candidate.type));
  const nodeTypeMap: Record<string, string> = { ...mapping.nodeTypeMap };
  const nameExtractors: Record<string, string> = { ...mapping.nameExtractors };
  const structural = [...mapping.structuralTags];
  const callable = mapping.callableTags ? [...mapping.callableTags] : undefined;
  const accepted: Deduction[] = [];
  const rejected: { type: string; tag: string; reason: string }[] = [];
  const answered = new Set<string>();
  let declined = 0;

  for (const suggestion of suggestions) {
    const type = String(suggestion.type ?? '');
    const tag = String(suggestion.tag ?? '');
    const reject = (reason: string) => rejected.push({ type, tag, reason });
    if (!asked.has(type)) {
      reject('it was not asked about: no such undecided node type in the samples');
      continue;
    }
    if (answered.has(type)) {
      reject('answered twice; the first answer stands');
      continue;
    }
    answered.add(type);
    if (tag === 'none') {
      declined += 1;
      continue;
    }
    if (!ASSIST_TAGS.includes(tag)) {
      reject(`"${tag}" is not one of the tags an assistant may give`);
      continue;
    }
    const stats = topology.types.get(type) as TypeStats;
    // Always inside something with the same tag (a `with_item` in its `with_statement`): tagging
    // it too would put every such construct in the outline twice.
    const repeats = [...stats.ancestors].find(
      ([ancestor, count]) => count === stats.count && nodeTypeMap[ancestor] === tag,
    );
    if (repeats && tag !== 'call') {
      reject(`it always sits in ${repeats[0]}, already tagged ${tag}, so it would count twice`);
      continue;
    }
    let nameChild: string | undefined;
    if (ASSIST_DECLARATIONS.includes(tag)) {
      const seen = new Set([...(stats.fields.get('name')?.keys() ?? []), ...stats.children.keys()]);
      nameChild = suggestion.nameChild ?? commonest(stats.fields.get('name'));
      if (nameChild === undefined) {
        reject('a declaration needs a name, and the samples show none for it');
        continue;
      }
      if (!seen.has(nameChild)) {
        reject(`its name is said to be in a ${nameChild}, which it never has in the samples`);
        continue;
      }
    }
    nodeTypeMap[type] = tag;
    if (tag !== 'call' && !structural.includes(tag)) structural.push(tag);
    const isCallable = tag === 'function' || tag === 'method' || ASSIST_ANONYMOUS.includes(tag);
    if (callable && isCallable && !callable.includes(tag)) callable.push(tag);
    if (nameChild !== undefined && nameExtractors[type] === undefined) {
      nameExtractors[type] = nameChild;
    }
    const role: Deduction['role'] =
      tag === 'call'
        ? 'call'
        : tag === 'import'
          ? 'import'
          : nameChild !== undefined
            ? 'declaration'
            : ASSIST_ANONYMOUS.includes(tag)
              ? 'anonymous-callable'
              : 'control-flow';
    accepted.push({
      type,
      tag,
      role,
      occurrences: stats.count,
      ...(nameChild !== undefined ? { nameChild } : {}),
    });
  }
  const assistedMapping = validateMapping(
    {
      ...mapping,
      nodeTypeMap,
      structuralTags: structural,
      nameExtractors,
      ...(callable ? { callableTags: callable } : {}),
    },
    `${mapping.name} assisted`,
  );
  return {
    mapping: assistedMapping,
    outcome: { model, asked: candidates.length, accepted, rejected, declined },
  };
}

async function assisted(
  trained: TrainedMapping,
  topology: Topology,
  assistant: Assistant,
  options: TrainOptions,
): Promise<TrainedMapping> {
  const candidates = assistCandidates(trained.mapping, topology, {
    ...(options.minOccurrences === undefined ? {} : { minOccurrences: options.minOccurrences }),
    ...(options.minFiles === undefined ? {} : { minFiles: options.minFiles }),
  });
  if (candidates.length === 0) {
    return {
      ...trained,
      assist: { model: '', asked: 0, accepted: [], rejected: [], declined: 0 },
    };
  }
  const answer = await assistant(candidates);
  const applied = applySuggestions(
    trained.mapping,
    topology,
    candidates,
    answer.suggestions,
    answer.model,
  );
  return { ...trained, mapping: applied.mapping, assist: applied.outcome };
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
  const heuristic = deduceMapping(topology, options);
  const deduced =
    options.tags === undefined
      ? heuristic
      : applyTagRules(heuristic, topology, parseTagsQuery(options.tags));
  const extended = options.base ? extendMapping(options.base, deduced, topology, options) : deduced;
  const trained = options.assist
    ? await assisted(extended, topology, options.assist, options)
    : extended;
  const verification = await verifyMapping(
    runtime,
    language,
    trained.mapping,
    samples,
    topology,
    options,
  );
  const golden = await synthesizeGolden(runtime, language, trained.mapping, samples, options);
  const sampling: TrainingIssue[] =
    options.minSamples !== undefined && samples.length < options.minSamples
      ? [
          {
            code: 'TOO_FEW_SAMPLES',
            message: `${samples.length} sample file${samples.length === 1 ? '' : 's'} is too few to trust what was learned; at least ${options.minSamples} are needed (point --samples at more of the project, or lower --min-samples)`,
          },
        ]
      : [];
  return {
    ...trained,
    issues: [...sampling, ...trained.issues, ...verification.issues],
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
