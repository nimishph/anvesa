import { MappingConflictError, MappingInvalidError, MappingNotFoundError } from './errors.ts';
import goJson from './mappings/go.json' with { type: 'json' };
import javaJson from './mappings/java.json' with { type: 'json' };
import phpJson from './mappings/php.json' with { type: 'json' };
import pythonJson from './mappings/python.json' with { type: 'json' };
import rubyJson from './mappings/ruby.json' with { type: 'json' };
import rustJson from './mappings/rust.json' with { type: 'json' };
import typescriptJson from './mappings/typescript.json' with { type: 'json' };

/**
 * How one language's syntax-tree node types become W-expression tags.
 *
 * The JSON files under `mappings/` are the canonical data. A legacy `maxDepth` field is accepted
 * and ignored: there is no depth cap, because only structural nodes are kept and nesting depth is a
 * property of the code.
 */
export interface LanguageMapping {
  readonly name: string;
  readonly version?: string;
  readonly extensions: readonly string[];
  /** Syntax node type -> tag. Types not listed keep their own name as the tag. */
  readonly nodeTypeMap: Readonly<Record<string, string>>;
  /** Tags that become W-expression nodes. Everything else is transparent. */
  readonly structuralTags: readonly string[];
  /** Syntax node type -> the type of the child that holds its name. */
  readonly nameExtractors: Readonly<Record<string, string>>;
  /** Tags whose nodes are callable and get signature, hash and shape attributes. */
  readonly callableTags?: readonly string[];
  readonly symbolRules?: Readonly<Record<string, SymbolRule>>;
  readonly callRules?: Readonly<Record<string, CallRule>>;
  readonly importRules?: Readonly<Record<string, ImportRule>>;
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'variable'
  | 'type'
  | 'module'
  | 'enum'
  | 'struct'
  | 'property';

/** Rules the indexer's extractor reads. They are validated here, and interpreted elsewhere. */
export interface SymbolRule {
  readonly kind: SymbolKind;
  readonly nameChild?: string;
  readonly docChild?: string;
  readonly signatureChild?: string;
}
export interface CallRule {
  readonly calleeChild?: string;
}
export interface ImportRule {
  readonly sourceChild?: string;
  readonly specifierChild?: string;
}

/** Tags treated as callable when a mapping does not say otherwise. */
const DEFAULT_CALLABLE_TAGS = ['function', 'method', 'arrow', 'lambda', 'closure', 'constructor'];

const SYMBOL_KINDS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'class',
  'interface',
  'variable',
  'type',
  'module',
  'enum',
  'struct',
  'property',
]);

/** A mapping prepared for fast lookups during encoding. */
export interface CompiledMapping {
  readonly mapping: LanguageMapping;
  tagOf(nodeType: string): string;
  isStructural(tag: string): boolean;
  isCallable(tag: string): boolean;
  /** The child type holding the name for a node type, when the mapping names one. */
  nameChildType(nodeType: string): string | undefined;
}

export function compileMapping(mapping: LanguageMapping): CompiledMapping {
  const structural = new Set(mapping.structuralTags);
  const callable = new Set(mapping.callableTags ?? DEFAULT_CALLABLE_TAGS);
  return {
    mapping,
    tagOf: (nodeType) => mapping.nodeTypeMap[nodeType] ?? nodeType,
    isStructural: (tag) => structural.has(tag),
    isCallable: (tag) => callable.has(tag),
    nameChildType: (nodeType) => mapping.nameExtractors[nodeType],
  };
}

// --- validation ---------------------------------------------------------------------------------

/**
 * Check untrusted JSON and return a typed mapping. Every problem names the field it is in, so a
 * hand-edited or synced mapping fails with something a person can fix.
 */
export function validateMapping(raw: unknown, source = 'mapping'): LanguageMapping {
  const at = (location: string, problem: string): never => {
    throw new MappingInvalidError(nameHint(raw, source), location, problem);
  };
  if (!isRecord(raw)) return at('(root)', 'expected an object');

  const name = requireString(raw.name, 'name', at);
  const extensions = requireStringArray(raw.extensions, 'extensions', at);
  for (const [index, ext] of extensions.entries()) {
    if (!ext.startsWith('.')) at(`extensions[${index}]`, `"${ext}" must start with a dot`);
  }
  const nodeTypeMap = requireStringRecord(raw.nodeTypeMap, 'nodeTypeMap', at);
  const structuralTags = requireStringArray(raw.structuralTags, 'structuralTags', at);
  const nameExtractors = requireStringRecord(raw.nameExtractors, 'nameExtractors', at);

  const known = new Set(Object.values(nodeTypeMap));
  for (const [index, tag] of structuralTags.entries()) {
    if (!known.has(tag)) {
      at(`structuralTags[${index}]`, `"${tag}" is not the target of any nodeTypeMap entry`);
    }
  }

  const callableTags =
    raw.callableTags === undefined
      ? undefined
      : requireStringArray(raw.callableTags, 'callableTags', at);
  if (raw.version !== undefined && typeof raw.version !== 'string') {
    at('version', 'expected a string');
  }
  if (raw.maxDepth !== undefined && typeof raw.maxDepth !== 'number') {
    at('maxDepth', 'expected a number (legacy field, ignored)');
  }

  return {
    name,
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    extensions,
    nodeTypeMap,
    structuralTags,
    nameExtractors,
    ...(callableTags ? { callableTags } : {}),
    ...(raw.symbolRules === undefined
      ? {}
      : { symbolRules: validateRules(raw.symbolRules, 'symbolRules', at, validateSymbolRule) }),
    ...(raw.callRules === undefined
      ? {}
      : { callRules: validateRules(raw.callRules, 'callRules', at, validateCallRule) }),
    ...(raw.importRules === undefined
      ? {}
      : { importRules: validateRules(raw.importRules, 'importRules', at, validateImportRule) }),
  };
}

type Fail = (location: string, problem: string) => never;

function validateRules<T>(
  raw: unknown,
  location: string,
  at: Fail,
  each: (rule: Record<string, unknown>, where: string, at: Fail) => T,
): Readonly<Record<string, T>> {
  if (!isRecord(raw)) return at(location, 'expected an object');
  const out: Record<string, T> = {};
  for (const [type, rule] of Object.entries(raw)) {
    if (!isRecord(rule)) return at(`${location}.${type}`, 'expected an object');
    out[type] = each(rule, `${location}.${type}`, at);
  }
  return out;
}

function optionalString(
  rule: Record<string, unknown>,
  key: string,
  where: string,
  at: Fail,
): string | undefined {
  const value = rule[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return at(`${where}.${key}`, 'expected a string');
  return value;
}

function validateSymbolRule(rule: Record<string, unknown>, where: string, at: Fail): SymbolRule {
  const kind = rule.kind;
  if (typeof kind !== 'string' || !SYMBOL_KINDS.has(kind)) {
    at(`${where}.kind`, `expected one of ${[...SYMBOL_KINDS].join(', ')}`);
  }
  const nameChild = optionalString(rule, 'nameChild', where, at);
  const docChild = optionalString(rule, 'docChild', where, at);
  const signatureChild = optionalString(rule, 'signatureChild', where, at);
  return {
    kind: kind as SymbolKind,
    ...(nameChild === undefined ? {} : { nameChild }),
    ...(docChild === undefined ? {} : { docChild }),
    ...(signatureChild === undefined ? {} : { signatureChild }),
  };
}

function validateCallRule(rule: Record<string, unknown>, where: string, at: Fail): CallRule {
  const calleeChild = optionalString(rule, 'calleeChild', where, at);
  return calleeChild === undefined ? {} : { calleeChild };
}

function validateImportRule(rule: Record<string, unknown>, where: string, at: Fail): ImportRule {
  const sourceChild = optionalString(rule, 'sourceChild', where, at);
  const specifierChild = optionalString(rule, 'specifierChild', where, at);
  return {
    ...(sourceChild === undefined ? {} : { sourceChild }),
    ...(specifierChild === undefined ? {} : { specifierChild }),
  };
}

function nameHint(raw: unknown, source: string): string {
  return isRecord(raw) && typeof raw.name === 'string' ? raw.name : source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, location: string, at: Fail): string {
  if (typeof value !== 'string' || value === '') return at(location, 'expected a non-empty string');
  return value;
}

function requireStringArray(value: unknown, location: string, at: Fail): readonly string[] {
  if (!Array.isArray(value)) return at(location, 'expected an array of strings');
  value.forEach((item, index) => {
    if (typeof item !== 'string') at(`${location}[${index}]`, 'expected a string');
  });
  return value as string[];
}

function requireStringRecord(
  value: unknown,
  location: string,
  at: Fail,
): Readonly<Record<string, string>> {
  if (!isRecord(value)) return at(location, 'expected an object of strings');
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') at(`${location}.${key}`, 'expected a string');
  }
  return value as Record<string, string>;
}

// --- registry -----------------------------------------------------------------------------------

export interface RegisterOptions {
  /** Language keys this mapping serves. Defaults to the mapping's own name. */
  readonly languages?: readonly string[];
}

/**
 * The mappings one engine knows, keyed by language key (the keys `@sutras/code-lens-syntax` uses). One
 * mapping may serve several languages: JavaScript, TSX and Vue all use the TypeScript mapping.
 */
export class MappingRegistry {
  readonly #byLanguage = new Map<string, CompiledMapping>();
  readonly #byName = new Map<string, CompiledMapping>();

  constructor(
    initial: Iterable<{
      mapping: LanguageMapping;
      languages: readonly string[];
    }> = builtinMappings(),
  ) {
    for (const { mapping, languages } of initial) this.register(mapping, { languages });
  }

  /** Register a mapping. A name or language key that is already taken is a conflict. */
  register(mapping: LanguageMapping, options: RegisterOptions = {}): void {
    if (this.#byName.has(mapping.name)) {
      throw new MappingConflictError(`the name "${mapping.name}"`, mapping.name, mapping.name);
    }
    const languages = options.languages ?? [mapping.name];
    for (const language of languages) {
      const owner = this.#byLanguage.get(language);
      if (owner) {
        throw new MappingConflictError(`language "${language}"`, owner.mapping.name, mapping.name);
      }
    }
    const compiled = compileMapping(mapping);
    this.#byName.set(mapping.name, compiled);
    for (const language of languages) this.#byLanguage.set(language, compiled);
  }

  /**
   * Register a mapping in place of any that already has its name or serves one of its languages.
   * This is how a project or user mapping takes over from a bundled one.
   */
  override(mapping: LanguageMapping, options: RegisterOptions = {}): void {
    const languages = options.languages ?? [mapping.name];
    const replaced = new Set<string>([mapping.name]);
    for (const language of languages) {
      const owner = this.#byLanguage.get(language);
      if (owner) replaced.add(owner.mapping.name);
    }
    for (const name of replaced) {
      const existing = this.#byName.get(name);
      if (!existing) continue;
      this.#byName.delete(name);
      for (const [language, owner] of [...this.#byLanguage]) {
        if (owner === existing) this.#byLanguage.delete(language);
      }
    }
    this.register(mapping, { languages });
  }

  /** The mapping that serves a language, without compiling anything new. */
  mappingFor(language: string): LanguageMapping | undefined {
    return this.#byLanguage.get(language)?.mapping;
  }

  /** The language keys a named mapping serves. */
  languagesOf(name: string): readonly string[] {
    const found = this.#byName.get(name);
    return found
      ? [...this.#byLanguage].filter(([, owner]) => owner === found).map(([key]) => key)
      : [];
  }

  has(language: string): boolean {
    return this.#byLanguage.has(language);
  }

  /** The compiled mapping for a language, or `MappingNotFoundError` naming what is known. */
  require(language: string): CompiledMapping {
    const found = this.#byLanguage.get(language);
    if (!found) throw new MappingNotFoundError(language, [...this.#byLanguage.keys()]);
    return found;
  }

  languages(): readonly string[] {
    return [...this.#byLanguage.keys()];
  }
}

/** The mappings that ship with the package, already validated. */
export function builtinMappings(): readonly {
  mapping: LanguageMapping;
  languages: readonly string[];
}[] {
  return [
    {
      mapping: validateMapping(typescriptJson, 'typescript.json'),
      languages: ['typescript', 'javascript', 'tsx', 'vue'],
    },
    { mapping: validateMapping(pythonJson, 'python.json'), languages: ['python'] },
    { mapping: validateMapping(phpJson, 'php.json'), languages: ['php'] },
    // Learned from real code with `mapping train` (see docs on teaching a language) and checked
    // against it: every mapped syntax node comes out as its tag.
    { mapping: validateMapping(goJson, 'go.json'), languages: ['go'] },
    { mapping: validateMapping(rustJson, 'rust.json'), languages: ['rust'] },
    { mapping: validateMapping(javaJson, 'java.json'), languages: ['java'] },
    { mapping: validateMapping(rubyJson, 'ruby.json'), languages: ['ruby'] },
  ];
}
