import type { Deadline, Page } from '@cntxt-labs/anvesa-core';
import type {
  CallFact,
  ExportFact,
  FileFacts,
  ImportBinding,
  ImportFact,
  SymbolFact,
  TypeFact,
} from '../extract/index.ts';
import type { Confidence, EdgeRecord, FileState, IndexStore } from '../store/index.ts';
import { isBuiltin } from './builtins.ts';
import { EDGE } from './edges.ts';
import type { ImportResolver, ResolvedImport } from './resolver.ts';

/** What linking one file produced, counted so gaps in the graph can be explained. */
export interface LinkReport {
  readonly path: string;
  readonly edges: number;
  readonly imports: {
    readonly resolved: number;
    readonly asset: number;
    readonly external: number;
    readonly dangling: number;
  };
  readonly calls: {
    readonly resolved: number;
    /** Matched by name among what the caller can see; a guess, kept apart from the rest. */
    readonly byName: number;
    readonly external: number;
    readonly unresolved: number;
  };
  /** Why calls stayed unresolved: reason -> count. */
  readonly unresolvedReasons: ReadonlyMap<string, number>;
}

export interface LinkSummary {
  readonly files: number;
  readonly edges: number;
  readonly imports: LinkReport['imports'];
  readonly calls: LinkReport['calls'];
  readonly unresolvedReasons: ReadonlyMap<string, number>;
}

export function summarize(reports: Iterable<LinkReport>): LinkSummary {
  const imports = { resolved: 0, asset: 0, external: 0, dangling: 0 };
  const calls = { resolved: 0, byName: 0, external: 0, unresolved: 0 };
  const reasons = new Map<string, number>();
  let files = 0;
  let edges = 0;
  for (const report of reports) {
    files += 1;
    edges += report.edges;
    for (const key of Object.keys(imports) as (keyof typeof imports)[]) {
      imports[key] += report.imports[key];
    }
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] += report.calls[key];
    for (const [reason, count] of report.unresolvedReasons) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    }
  }
  return { files, edges, imports, calls, unresolvedReasons: reasons };
}

/** What the linker decided for one call. Public so a report can say why, and an eval can check. */
export type CallResolution =
  /** Found through scope, imports or the enclosing class; `inferred` when through a declared type. */
  | { readonly kind: 'symbol'; readonly ids: readonly string[]; readonly inferred?: true }
  /** Matched by name among what the caller can see: a guess. */
  | { readonly kind: 'byName'; readonly ids: readonly string[] }
  /** A package outside the workspace, or the runtime. */
  | { readonly kind: 'external'; readonly to: string }
  | { readonly kind: 'unresolved'; readonly reason: string };

export interface LinkOptions {
  readonly deadline?: Deadline;
  /** Told each call's resolution as it is decided. Does not change what is linked. */
  readonly onCall?: (path: string, call: CallFact, resolution: CallResolution) => void;
}

/** What the linker needs to know about a file it links *into*: what it defines and re-exports. */
interface ExportTable {
  /** Top-level symbols other files can import, by name. */
  readonly exported: ReadonlyMap<string, readonly SymbolFact[]>;
  /** Every symbol by qualified name, for member lookups (`Class.method`). */
  readonly byName: ReadonlyMap<string, readonly SymbolFact[]>;
  /** Members (symbols with a parent) that a caller can reach through an importable ancestor. */
  readonly members: ReadonlyMap<string, readonly SymbolFact[]>;
  readonly reexports: readonly ImportFact[];
  /** Every import of the file, for walking the import graph. */
  readonly imports: readonly ImportFact[];
  /** Names exported by a list, by the name they are exported under. */
  readonly listed: ReadonlyMap<string, ExportFact>;
  /** What this file imports, by the local name, so a listed export can be followed on. */
  readonly imported: ReadonlyMap<string, { fact: ImportFact; binding: ImportBinding }>;
  readonly language: string;
  /** The namespace the file declares (PHP), for names written relative to it. */
  readonly namespace: string | undefined;
}

/** What a class name written in a file refers to. */
export type ClassResolution =
  | { readonly kind: 'class'; readonly symbol: SymbolFact; readonly byName: boolean }
  | { readonly kind: 'external'; readonly name: string }
  | { readonly kind: 'unknown' };

/** An import binding, with where it points. */
interface Bound {
  readonly fact: ImportFact;
  readonly binding: ImportBinding;
  readonly target: ResolvedImport;
}

type CallOutcome = CallResolution;

const CONTAINER_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'trait', 'enum']);

/**
 * Turns the facts of files into graph edges: imports resolved to files, and calls resolved to
 * symbols through scope, imports and the enclosing class. What cannot be resolved is kept as an
 * edge of an `unresolved`, `dangling` or `external` kind, never dropped.
 *
 * A linker holds what it has learned about other files, so it is valid for one consistent
 * snapshot of the index. Make a new one after files change.
 */
export class GraphLinker {
  readonly #store: IndexStore;
  readonly #resolver: ImportResolver;
  readonly #tables = new Map<string, Promise<ExportTable | undefined>>();
  readonly #resolved = new Map<string, Promise<ResolvedImport>>();
  readonly #dependencies = new Map<string, Promise<readonly string[]>>();
  readonly #named = new Map<string, Promise<ReadonlySet<string>>>();
  readonly #nearest = new Map<string, Promise<readonly SymbolFact[]>>();
  readonly #typed = new Map<string, Promise<readonly TypeFact[]>>();

  constructor(store: IndexStore, resolver: ImportResolver) {
    this.#store = store;
    this.#resolver = resolver;
  }

  /** Link every indexed file. Returns one report per file, in path order. */
  async linkAll(options: LinkOptions = {}): Promise<LinkReport[]> {
    const reports: LinkReport[] = [];
    let cursor: string | undefined;
    do {
      const page: Page<FileState> = await this.#store.files({
        status: 'indexed',
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const file of page.items) {
        options.deadline?.throwIfExpired(`link ${file.path}`);
        const report = await this.linkFile(file.path, options);
        if (report) reports.push(report);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return reports;
  }

  /** Link one file and store its edges. `undefined` when the file is not indexed. */
  async linkFile(path: string, options: LinkOptions = {}): Promise<LinkReport | undefined> {
    const facts = await this.#store.facts(path);
    if (!facts) return undefined;
    const link = new FileLink(this, facts, options.onCall);
    const edges = await link.run(options);
    await this.#store.replaceEdges(path, edges.list);
    return {
      path,
      edges: edges.list.length,
      imports: link.imports,
      calls: link.calls,
      unresolvedReasons: link.reasons,
    };
  }

  // --- what FileLink asks of the rest of the index ---------------------------------------------

  resolveImport(from: string, fact: ImportFact, language: string): Promise<ResolvedImport> {
    const key = `${from}\u0000${fact.specifier}\u0000${fact.bindings.map((b) => b.imported).join(',')}`;
    let known = this.#resolved.get(key);
    if (!known) {
      known = this.#resolver.resolve(from, fact, language);
      this.#resolved.set(key, known);
    }
    return known;
  }

  async isSource(path: string): Promise<boolean> {
    return (await this.#store.fileState(path)) !== undefined;
  }

  /** The indexed files that `path` imports, by any kind of import. */
  dependencyFiles(path: string): Promise<readonly string[]> {
    let known = this.#dependencies.get(path);
    if (!known) {
      known = this.#loadDependencies(path);
      this.#dependencies.set(path, known);
    }
    return known;
  }

  async #loadDependencies(path: string): Promise<readonly string[]> {
    const table = await this.exportsOf(path);
    if (!table) return [];
    const found = new Set<string>();
    for (const fact of table.imports) {
      const target = await this.resolveImport(path, fact, table.language);
      if (target.resolution.kind === 'file') found.add(target.resolution.path);
      for (const member of target.members.values()) found.add(member);
    }
    return [...found].sort();
  }

  /** The files that define a member (a symbol with a parent) called `name`, anywhere. */
  #filesWithMember(name: string): Promise<ReadonlySet<string>> {
    let known = this.#named.get(name);
    if (!known) {
      known = this.#loadMemberFiles(name);
      this.#named.set(name, known);
    }
    return known;
  }

  async #loadMemberFiles(name: string): Promise<ReadonlySet<string>> {
    const files = new Set<string>();
    let cursor: string | undefined;
    do {
      const page: Page<SymbolFact> = await this.#store.findSymbols({
        baseName: name,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const symbol of page.items) if (symbol.parentId !== undefined) files.add(symbol.path);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return files;
  }

  /**
   * The methods called `name` that are closest to `start` by imports: the nearest import
   * distance at which any file defines one, and every one found at that distance. Nothing is
   * returned when no file the start file can reach defines a method of that name.
   *
   * This is the evidence there is for a call on a value whose type is not written down: the
   * type has to have come from somewhere the file can see, and nearer is likelier.
   */
  nearestMembers(start: string, name: string): Promise<readonly SymbolFact[]> {
    const key = `${start}\u0000${name}`;
    let known = this.#nearest.get(key);
    if (!known) {
      known = this.#searchMembers(start, name);
      this.#nearest.set(key, known);
    }
    return known;
  }

  async #searchMembers(start: string, name: string): Promise<readonly SymbolFact[]> {
    const defining = await this.#filesWithMember(name);
    if (defining.size === 0) return [];
    const seen = new Set<string>([start]);
    let level = [...(await this.dependencyFiles(start))].filter((file) => !seen.has(file));
    for (const file of level) seen.add(file);
    while (level.length > 0) {
      const found: SymbolFact[] = [];
      for (const file of level) {
        if (!defining.has(file)) continue;
        const table = await this.exportsOf(file);
        found.push(...(table?.members.get(name) ?? []));
      }
      if (found.length > 0) return found;
      const next: string[] = [];
      for (const file of level) {
        for (const dependency of await this.dependencyFiles(file)) {
          if (!seen.has(dependency)) {
            seen.add(dependency);
            next.push(dependency);
          }
        }
      }
      level = next;
    }
    return [];
  }

  exportsOf(path: string): Promise<ExportTable | undefined> {
    let known = this.#tables.get(path);
    if (!known) {
      known = this.#buildTable(path);
      this.#tables.set(path, known);
    }
    return known;
  }

  async #buildTable(path: string): Promise<ExportTable | undefined> {
    const facts = await this.#store.facts(path);
    if (!facts) return undefined;
    const byId = new Map(facts.symbols.map((symbol) => [symbol.id, symbol]));
    const exported = new Map<string, SymbolFact[]>();
    const byName = new Map<string, SymbolFact[]>();
    const members = new Map<string, SymbolFact[]>();
    for (const symbol of facts.symbols) {
      push(byName, symbol.name, symbol);
      if (symbol.parentId === undefined) {
        // `false` is an explicit "not exported"; `undefined` is a language with no marker.
        if (symbol.exported !== false) push(exported, symbol.baseName, symbol);
      } else if (topLevelOf(symbol, byId)?.exported !== false) {
        push(members, symbol.baseName, symbol);
      }
    }
    const imported = new Map<string, { fact: ImportFact; binding: ImportBinding }>();
    for (const fact of facts.imports) {
      if (fact.kind === 'reexport') continue;
      for (const binding of fact.bindings) imported.set(binding.local, { fact, binding });
    }
    return {
      exported,
      byName,
      members,
      listed: new Map(facts.exports.map((entry) => [entry.name, entry])),
      imported,
      // In Python a module-level `from x import y` makes `y` an attribute of this module, which is
      // how packages re-export from their `__init__.py`.
      imports: facts.imports,
      reexports: facts.imports.filter(
        (entry) =>
          entry.kind === 'reexport' || (facts.language === 'python' && entry.kind === 'static'),
      ),
      language: facts.language,
      namespace: facts.symbols.find((symbol) => symbol.kind === 'namespace')?.name,
    };
  }

  /** The declared types of a file's names; empty where the language has none. */
  typesOf(path: string): Promise<readonly TypeFact[]> {
    let known = this.#typed.get(path);
    if (!known) {
      known = this.#store.facts(path).then((facts) => facts?.types ?? []);
      this.#typed.set(path, known);
    }
    return known;
  }

  /**
   * The class a type name written in `from` refers to: declared there, imported with `use`, in the
   * file's own namespace, or fully qualified. A name that no file declares but exactly one class in
   * the workspace bears is that class, marked `byName`.
   */
  async resolveClass(typeName: string, from: string): Promise<ClassResolution> {
    const table = await this.exportsOf(from);
    if (!table) return { kind: 'unknown' };
    const written = typeName.replace(/^\\+/, '');
    const segments = written.split('\\');
    const base = segments.at(-1) ?? written;
    const absolute = typeName.startsWith('\\');

    if (segments.length === 1 && !absolute) {
      const local = table.byName.get(base)?.find((symbol) => CONTAINER_KINDS.has(symbol.kind));
      if (local) return { kind: 'class', symbol: local, byName: false };
      const via = table.imported.get(base);
      if (via) {
        const target = await this.resolveImport(from, via.fact, table.language);
        if (target.resolution.kind === 'file') {
          const found = await this.exportedSymbol(target.resolution.path, via.binding.imported);
          if (found && CONTAINER_KINDS.has(found.kind)) {
            return { kind: 'class', symbol: found, byName: false };
          }
        }
        return { kind: 'external', name: via.fact.specifier };
      }
    }

    const candidates = absolute
      ? [written]
      : [
          ...(table.namespace ? [`${table.namespace}\\${written}`] : []),
          ...(segments.length > 1 || !table.namespace ? [written] : []),
        ];
    for (const specifier of candidates) {
      const fact: ImportFact = {
        specifier,
        kind: 'static',
        relative: false,
        typeOnly: false,
        bindings: [{ imported: base, local: base, typeOnly: false }],
        line: 0,
      };
      const target = await this.resolveImport(from, fact, table.language);
      if (target.resolution.kind !== 'file') continue;
      const found = await this.exportedSymbol(target.resolution.path, base);
      if (found && CONTAINER_KINDS.has(found.kind)) {
        return { kind: 'class', symbol: found, byName: false };
      }
    }

    const named: SymbolFact[] = [];
    let cursor: string | undefined;
    do {
      const page: Page<SymbolFact> = await this.#store.findSymbols({
        baseName: base,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const symbol of page.items) {
        if (CONTAINER_KINDS.has(symbol.kind) && symbol.parentId === undefined) named.push(symbol);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && named.length < 2);
    const [only] = named;
    return named.length === 1 && only
      ? { kind: 'class', symbol: only, byName: true }
      : { kind: 'unknown' };
  }

  /**
   * The symbol a file exports under `name`, following re-exports. `seen` stops a cycle of
   * re-exports from looping.
   */
  /** A symbol by id, from whichever file declares it. */
  symbolById(id: string): Promise<SymbolFact | undefined> {
    return this.#store.symbol(id);
  }

  /**
   * Follow `const a = b` to what `b` is, in the file that declares `a`, and on through `b` if it is
   * an alias too. A chain that comes back on itself stops where it closes.
   */
  async resolveAlias(symbol: SymbolFact): Promise<SymbolFact> {
    const seen = new Set<string>([symbol.id]);
    let current = symbol;
    while (current.aliasOf !== undefined) {
      const table = await this.exportsOf(current.path);
      const next = table?.byName.get(current.aliasOf)?.at(-1);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      current = next;
    }
    return current;
  }

  async exportedSymbol(
    path: string,
    name: string,
    seen: Set<string> = new Set(),
  ): Promise<SymbolFact | undefined> {
    const key = `${path}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const table = await this.exportsOf(path);
    if (!table) return undefined;
    const direct = table.exported.get(name);
    if (direct) return direct.at(-1);

    // `export { local as name }`: the local is declared here, or imported and passed on.
    const listed = table.listed.get(name);
    if (listed) {
      const declared = table.byName
        .get(listed.local)
        ?.find((symbol) => symbol.parentId === undefined);
      if (declared) return declared;
      const through = table.imported.get(listed.local);
      if (through && through.binding.imported !== '*') {
        const target = await this.resolveImport(path, through.fact, table.language);
        if (target.resolution.kind === 'file') {
          const found = await this.exportedSymbol(
            target.resolution.path,
            through.binding.imported,
            seen,
          );
          if (found) return found;
        }
      }
    }

    for (const reexport of table.reexports) {
      const named = reexport.bindings.find((b) => b.imported !== '*' && b.local === name);
      const star = reexport.bindings.some((b) => b.imported === '*' && b.local === '*');
      if (!named && !star) continue;
      const target = await this.resolveImport(path, reexport, table.language);
      if (target.resolution.kind !== 'file') continue;
      const found = await this.exportedSymbol(
        target.resolution.path,
        named ? named.imported : name,
        seen,
      );
      if (found) return found;
    }
    return undefined;
  }
}

/**
 * Of several declarations of one name at the same level (tests that each define a helper inside
 * their own callback, a function defined twice), the one a call at `line` sees: the closest
 * that starts above it, or the first if none does.
 */
function nearestBefore(symbols: readonly SymbolFact[], line: number): SymbolFact | undefined {
  let best: SymbolFact | undefined;
  for (const symbol of symbols) {
    if (symbol.startLine <= line && (best === undefined || symbol.startLine >= best.startLine)) {
      best = symbol;
    }
  }
  return best ?? symbols[0];
}

const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

/** The names a parameter list binds: `a, ...rest` and `{a, b}, [c]` alike. */
function parameterNames(params: string): ReadonlySet<string> {
  return new Set(params.match(IDENTIFIER) ?? []);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function topLevelOf(
  symbol: SymbolFact,
  byId: ReadonlyMap<string, SymbolFact>,
): SymbolFact | undefined {
  let current: SymbolFact | undefined = symbol;
  while (current?.parentId !== undefined) current = byId.get(current.parentId);
  return current;
}

/** The linking of one file. Holds the per-file state so the shared linker stays reusable. */
class FileLink {
  readonly list: EdgeRecord[] = [];
  readonly imports = { resolved: 0, asset: 0, external: 0, dangling: 0 };
  readonly calls = { resolved: 0, byName: 0, external: 0, unresolved: 0 };
  readonly reasons = new Map<string, number>();

  readonly #linker: GraphLinker;
  readonly #facts: FileFacts;
  readonly #seen = new Set<string>();
  readonly #byId: ReadonlyMap<string, SymbolFact>;
  readonly #byBaseName = new Map<string, SymbolFact[]>();
  readonly #byQualified = new Map<string, SymbolFact[]>();
  /** Local name -> what it was imported as. */
  readonly #bound = new Map<string, Bound>();
  /** Module specifier -> the import, for `import a.b` where a call reads `a.b.f()`. */
  readonly #modules = new Map<string, Bound>();

  /** Declared types by the symbol they belong to. */
  readonly #types = new Map<string, TypeFact[]>();

  readonly #onCall: LinkOptions['onCall'];

  constructor(linker: GraphLinker, facts: FileFacts, onCall: LinkOptions['onCall']) {
    this.#linker = linker;
    this.#facts = facts;
    this.#onCall = onCall;
    this.#byId = new Map(facts.symbols.map((symbol) => [symbol.id, symbol]));
    for (const entry of facts.types ?? []) push(this.#types, entry.scope, entry);
    for (const symbol of facts.symbols) {
      push(this.#byBaseName, symbol.baseName, symbol);
      push(this.#byQualified, symbol.name, symbol);
    }
  }

  async run(options: LinkOptions): Promise<{ list: EdgeRecord[] }> {
    const { path } = this.#facts;
    for (const fact of this.#facts.imports) await this.#link(fact);
    for (const call of this.#facts.calls) {
      options.deadline?.throwIfExpired(`link calls in ${path}`);
      await this.#linkCall(call);
    }
    return { list: this.list };
  }

  #add(from: string, to: string, kind: string, confidence: Confidence = 'exact'): void {
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.list.push({ from, to, kind, confidence });
  }

  // --- imports ----------------------------------------------------------------------------------

  async #link(fact: ImportFact): Promise<void> {
    const { path, language } = this.#facts;
    const target = await this.#linker.resolveImport(path, fact, language);
    const { resolution } = target;

    if (resolution.kind === 'file') {
      const isSource = await this.#linker.isSource(resolution.path);
      const kind =
        fact.kind === 'reexport'
          ? EDGE.reexports
          : !isSource
            ? EDGE.importsAsset
            : fact.typeOnly
              ? EDGE.importsType
              : EDGE.imports;
      this.#add(path, resolution.path, kind);
      this.imports[isSource ? 'resolved' : 'asset'] += 1;
    } else if (resolution.kind === 'external') {
      this.#add(path, resolution.name, EDGE.importsExternal);
      this.imports.external += 1;
    } else {
      this.#add(path, fact.specifier, EDGE.importsDangling);
      this.imports.dangling += 1;
    }

    if (fact.kind === 'reexport') return;
    const entry = (binding: ImportBinding): Bound => ({ fact, binding, target });
    for (const binding of fact.bindings) {
      if (binding.local === '*') continue;
      // `import a.b` binds `a` (the package), not the module `a.b`; that one is reached through
      // its full dotted name, which `#modules` holds.
      if (
        language === 'python' &&
        fact.specifier.includes('.') &&
        binding.local === fact.specifier.split('.')[0]
      ) {
        continue;
      }
      this.#bound.set(binding.local, entry(binding));
    }
    if (language === 'python' && fact.kind === 'static') {
      this.#modules.set(fact.specifier, {
        fact,
        binding: { imported: '*', local: '*', typeOnly: false },
        target,
      });
    }
  }

  // --- calls ------------------------------------------------------------------------------------

  async #linkCall(call: CallFact): Promise<void> {
    const from = call.from ?? this.#facts.path;
    const outcome = await this.#followAliases(await this.#resolveCall(call));
    this.#onCall?.(this.#facts.path, call, outcome);
    switch (outcome.kind) {
      case 'symbol': {
        const confidence = outcome.inferred ? 'inferred' : 'exact';
        for (const id of outcome.ids) this.#add(from, id, EDGE.calls, confidence);
        if (call.kind === 'new') await this.#linkConstructors(from, outcome.ids, confidence);
        this.calls.resolved += 1;
        return;
      }
      case 'byName':
        for (const id of outcome.ids) this.#add(from, id, EDGE.callsByName, 'guess');
        this.calls.byName += 1;
        return;
      case 'external':
        this.#add(from, outcome.to, EDGE.callsExternal);
        this.calls.external += 1;
        return;
      case 'unresolved':
        this.#add(from, call.name, EDGE.callsUnresolved);
        this.calls.unresolved += 1;
        this.reasons.set(outcome.reason, (this.reasons.get(outcome.reason) ?? 0) + 1);
    }
  }

  /** `new X()` also calls `X.__construct` when the class declares one (PHP). */
  async #linkConstructors(
    from: string,
    ids: readonly string[],
    confidence: Confidence,
  ): Promise<void> {
    for (const id of ids) {
      const symbol = this.#byId.get(id) ?? (await this.#linker.symbolById(id));
      if (!symbol || !CONTAINER_KINDS.has(symbol.kind)) continue;
      const ctor = await this.#member(symbol.path, `${symbol.name}.__construct`);
      if (ctor) this.#add(from, ctor.id, EDGE.calls, confidence);
    }
  }

  /** A call to a name that is only another name is a call to what that name is. */
  async #followAliases(outcome: CallOutcome): Promise<CallOutcome> {
    if (outcome.kind !== 'symbol') return outcome;
    const ids = new Set<string>();
    for (const id of outcome.ids) ids.add(await this.#throughAlias(id));
    return {
      kind: 'symbol',
      ids: [...ids],
      ...(outcome.inferred ? { inferred: true as const } : {}),
    };
  }

  async #throughAlias(id: string): Promise<string> {
    const symbol = this.#byId.get(id) ?? (await this.#linker.symbolById(id));
    if (symbol?.aliasOf === undefined) return id;
    return (await this.#linker.resolveAlias(symbol)).id;
  }

  async #resolveCall(call: CallFact): Promise<CallOutcome> {
    const caller = call.from === undefined ? undefined : this.#byId.get(call.from);
    const { receiver } = call;

    if (receiver === undefined) {
      const local = this.#lexical(call.name, caller, call.line);
      if (local === 'parameter') {
        return { kind: 'unresolved', reason: 'a parameter of the enclosing function' };
      }
      if (local) return { kind: 'symbol', ids: [local.id] };
      const bound = this.#bound.get(call.name);
      if (bound) return this.#viaBinding(bound, call.name, undefined);
      if (isBuiltin(this.#facts.language, call.name)) {
        return { kind: 'external', to: `global#${call.name}` };
      }
      if (call.kind === 'new' && this.#facts.language === 'php') {
        return this.#newInstance(call.name, caller);
      }
      return { kind: 'unresolved', reason: 'not declared here or imported' };
    }

    if (receiver.kind === 'result') return this.#viaReturnType(call, receiver);

    if (receiver.kind === 'complex') {
      return { kind: 'unresolved', reason: 'receiver is an expression' };
    }
    if (receiver.kind === 'self') return this.#viaSelf(call.name, caller);

    if (this.#facts.language === 'php' && receiver.name.startsWith('$')) {
      const typed = await this.#viaDeclaredType(receiver.name, call.name, caller);
      if (typed) return typed;
    }

    // `pkg.util.f()` where `import pkg.util` names the whole module.
    const module = this.#modules.get(receiver.name);
    if (module) return this.#viaBinding(module, call.name, []);

    const [first = '', ...rest] = receiver.name.split('.');
    const bound = this.#bound.get(first);
    if (bound) return this.#viaBinding(bound, call.name, rest);

    if (isBuiltin(this.#facts.language, first)) {
      return { kind: 'external', to: `global#${receiver.name}.${call.name}` };
    }

    const isLocalClass = this.#byQualified
      .get(receiver.name)
      ?.some((symbol) => CONTAINER_KINDS.has(symbol.kind));
    const own = isLocalClass ? this.#byQualified.get(`${receiver.name}.${call.name}`) : undefined;
    if (own?.length) return { kind: 'symbol', ids: [(own.at(-1) as SymbolFact).id] };
    // `this.cache.get()` is a call on a property, so the method it reaches is not the caller's own.
    const property = first === 'this' || first === 'self' || first === 'cls';
    if (this.#facts.language === 'php' && !first.startsWith('$') && !receiver.name.includes('.')) {
      // `Foo::bar()` where `Foo` is in the file's own namespace, so no `use` names it.
      const named = await this.#linker.resolveClass(receiver.name, this.#facts.path);
      if (named.kind !== 'unknown') return this.#inClass(named, receiver.name, call.name);
    }
    return this.#byNameAmongVisible(call.name, property ? this.#classOf(caller)?.id : undefined);
  }

  // --- declared types (PHP) ----------------------------------------------------------------------

  /** `new X()` where nothing declares or imports `X`: the class of that name in the namespace. */
  async #newInstance(name: string, caller: SymbolFact | undefined): Promise<CallOutcome> {
    if (name === 'self' || name === 'static') {
      const own = this.#classOf(caller);
      if (own) return { kind: 'symbol', ids: [own.id] };
      return { kind: 'unresolved', reason: 'self used outside a class' };
    }
    const found = await this.#linker.resolveClass(name, this.#facts.path);
    if (found.kind === 'class') {
      return found.byName
        ? { kind: 'byName', ids: [found.symbol.id] }
        : { kind: 'symbol', ids: [found.symbol.id], inferred: true };
    }
    if (found.kind === 'external') return { kind: 'external', to: `${found.name}#${name}` };
    return { kind: 'unresolved', reason: 'not declared here or imported' };
  }

  /** The one class a variable was declared or assigned as, in the caller or what encloses it. */
  #variableType(variable: string, caller: SymbolFact | undefined): string | undefined {
    for (let scope = caller; scope !== undefined; scope = this.#parentOf(scope)) {
      const types = new Set(
        (this.#types.get(scope.id) ?? [])
          .filter((entry) => entry.name === variable && entry.origin !== 'return')
          .map((entry) => entry.type),
      );
      if (types.size === 1) return [...types][0];
      if (types.size > 1) return undefined;
    }
    return undefined;
  }

  /** The class a written type is, with `self` and `static` meaning the class around `context`. */
  async #classOfType(
    type: string,
    from: string,
    context: SymbolFact | undefined,
  ): Promise<ClassResolution> {
    if (type === 'self' || type === 'static') {
      let scope = context;
      while (scope !== undefined && !CONTAINER_KINDS.has(scope.kind)) {
        scope =
          scope.parentId === undefined
            ? undefined
            : (this.#byId.get(scope.parentId) ?? (await this.#linker.symbolById(scope.parentId)));
      }
      return scope ? { kind: 'class', symbol: scope, byName: false } : { kind: 'unknown' };
    }
    return this.#linker.resolveClass(type, from);
  }

  /**
   * `$var->f()` and `$this->prop->f()`: the class comes from what the source declares for the
   * variable or property. `undefined` when nothing is declared, so the caller can fall back.
   */
  async #viaDeclaredType(
    receiver: string,
    name: string,
    caller: SymbolFact | undefined,
  ): Promise<CallOutcome | undefined> {
    const [head = '', ...hops] = receiver.split('.');
    let current: ClassResolution;
    if (head === '$this') {
      const own = this.#classOf(caller);
      if (!own) return undefined;
      current = { kind: 'class', symbol: own, byName: false };
    } else {
      const type = this.#variableType(head, caller);
      if (type === undefined) return undefined;
      current = await this.#classOfType(type, this.#facts.path, caller);
    }
    for (const property of hops) {
      if (current.kind !== 'class') break;
      const declared = await this.#propertyType(current.symbol, `$${property}`);
      if (declared === undefined) return undefined;
      current = await this.#classOfType(declared, current.symbol.path, current.symbol);
    }
    return this.#inClass(current, receiver, name);
  }

  /** The declared type of a property of `owner`: a typed property or a promoted parameter. */
  async #propertyType(owner: SymbolFact, property: string): Promise<string | undefined> {
    const types = new Set(
      (await this.#linker.typesOf(owner.path))
        .filter(
          (entry) =>
            entry.name === property &&
            ((entry.origin === 'property' && entry.scope === owner.id) ||
              (entry.origin === 'promoted' && entry.scope === `${owner.id}.__construct`)),
        )
        .map((entry) => entry.type),
    );
    return types.size === 1 ? [...types][0] : undefined;
  }

  /** `A::get($id)->run()`: `run` in the class that `A::get` is declared to return. */
  async #viaReturnType(
    call: CallFact,
    receiver: Extract<NonNullable<CallFact['receiver']>, { kind: 'result' }>,
  ): Promise<CallOutcome> {
    const opaque: CallOutcome = { kind: 'unresolved', reason: 'receiver is an expression' };
    const inner = await this.#resolveCall({
      ...call,
      name: receiver.name,
      receiver: receiver.receiver,
      kind: 'call',
    });
    if (inner.kind !== 'symbol' || inner.ids.length !== 1) return opaque;
    const callee =
      this.#byId.get(inner.ids[0] as string) ??
      (await this.#linker.symbolById(inner.ids[0] as string));
    if (!callee) return opaque;
    const returned = (await this.#linker.typesOf(callee.path)).filter(
      (entry) => entry.origin === 'return' && entry.scope === callee.id,
    );
    const [declared] = returned;
    if (returned.length !== 1 || !declared) return opaque;
    const owner = await this.#classOfType(declared.type, callee.path, callee);
    return this.#inClass(owner, `${receiver.name}()`, call.name);
  }

  /** A method called on a value whose class is known (or known to be outside the workspace). */
  async #inClass(owner: ClassResolution, receiver: string, name: string): Promise<CallOutcome> {
    if (owner.kind === 'external') {
      return { kind: 'external', to: `${owner.name}#${name}` };
    }
    if (owner.kind === 'unknown') {
      return {
        kind: 'unresolved',
        reason: `the declared class of ${receiver} is not in the workspace`,
      };
    }
    const member = await this.#member(owner.symbol.path, `${owner.symbol.name}.${name}`);
    if (!member) {
      return {
        kind: 'unresolved',
        reason: 'not a member of the declared class (inherited or dynamic)',
      };
    }
    return owner.byName
      ? { kind: 'byName', ids: [member.id] }
      : { kind: 'symbol', ids: [member.id], inferred: true };
  }

  /**
   * A bare name: what the nearest enclosing function declares under it, else the top level. A
   * class body is not a scope a method can see into by bare name.
   */
  #lexical(
    name: string,
    caller: SymbolFact | undefined,
    line: number,
  ): SymbolFact | 'parameter' | undefined {
    // Only a declaration can be named bare. A method is reached through its object.
    const candidates = (this.#byBaseName.get(name) ?? []).filter(
      (symbol) => symbol.kind !== 'method',
    );
    for (let scope = caller; scope !== undefined; scope = this.#parentOf(scope)) {
      if (CONTAINER_KINDS.has(scope.kind)) continue;
      const inside = candidates.filter((symbol) => symbol.parentId === scope.id);
      if (inside.length > 0) return nearestBefore(inside, line);
      // A parameter hides every declaration outside the function that takes it.
      if (scope.params !== undefined && parameterNames(scope.params).has(name)) return 'parameter';
    }
    return nearestBefore(
      candidates.filter((symbol) => symbol.parentId === undefined),
      line,
    );
  }

  /** The class a symbol belongs to, if any. */
  #classOf(symbol: SymbolFact | undefined): SymbolFact | undefined {
    let scope = symbol;
    while (scope !== undefined && !CONTAINER_KINDS.has(scope.kind)) scope = this.#parentOf(scope);
    return scope;
  }

  #parentOf(symbol: SymbolFact): SymbolFact | undefined {
    return symbol.parentId === undefined ? undefined : this.#byId.get(symbol.parentId);
  }

  /** `this.f()`: `f` in the class the caller belongs to. */
  #viaSelf(name: string, caller: SymbolFact | undefined): CallOutcome {
    let scope = caller;
    while (scope !== undefined && !CONTAINER_KINDS.has(scope.kind)) scope = this.#parentOf(scope);
    if (!scope) return { kind: 'unresolved', reason: 'self used outside a class' };
    const member = this.#byQualified.get(`${scope.name}.${name}`)?.at(-1);
    if (member) return { kind: 'symbol', ids: [member.id] };
    return { kind: 'unresolved', reason: 'not a member of the class (inherited or dynamic)' };
  }

  /**
   * A call through an imported name. `rest` is what sits between the imported name and the called
   * name in the receiver (`ns.Class.f()` has rest `['Class']`); `undefined` is a bare call of the
   * imported name itself.
   */
  async #viaBinding(
    bound: Bound,
    name: string,
    rest: readonly string[] | undefined,
  ): Promise<CallOutcome> {
    const { resolution, members } = bound.target;
    const { imported, local } = bound.binding;

    if (resolution.kind === 'external') {
      const parts =
        rest === undefined ? [imported] : [...(imported === '*' ? [] : [imported]), ...rest, name];
      return { kind: 'external', to: `${resolution.name}#${parts.join('.')}` };
    }
    if (resolution.kind === 'dangling') {
      return { kind: 'unresolved', reason: 'the import does not resolve' };
    }

    if (rest === undefined) {
      if (imported === '*') return { kind: 'unresolved', reason: 'a module is not callable' };
      const target = await this.#importedSymbol(resolution.path, imported, local);
      return target
        ? { kind: 'symbol', ids: [target.id] }
        : { kind: 'unresolved', reason: 'the imported name is not defined in the module' };
    }

    if (imported === '*') return this.#inFile(resolution.path, rest, name);

    const target = await this.#importedSymbol(resolution.path, imported, local);
    if (!target) {
      const submodule = members.get(imported);
      if (submodule) return this.#inFile(submodule, rest, name);
      return { kind: 'unresolved', reason: 'the imported name is not defined in the module' };
    }
    if (CONTAINER_KINDS.has(target.kind)) {
      const member = await this.#member(target.path, [target.name, ...rest, name].join('.'));
      if (member) return { kind: 'symbol', ids: [member.id] };
      return {
        kind: 'unresolved',
        reason: 'not a member of the imported class (inherited or dynamic)',
      };
    }
    // An imported value (an instance, a client): what it is has to be guessed from the methods
    // the caller can see.
    return this.#byNameAmongVisible(name, undefined);
  }

  /** `name` in a module, optionally through a class or nested name (`Class.name`). */
  async #inFile(file: string, rest: readonly string[], name: string): Promise<CallOutcome> {
    if (rest.length === 0) {
      const found = await this.#linker.exportedSymbol(file, name);
      return found
        ? { kind: 'symbol', ids: [found.id] }
        : { kind: 'unresolved', reason: 'not exported by the imported module' };
    }
    const [head = '', ...tail] = rest;
    const owner = await this.#linker.exportedSymbol(file, head);
    if (!owner) return { kind: 'unresolved', reason: 'not exported by the imported module' };
    const member = await this.#member(owner.path, [owner.name, ...tail, name].join('.'));
    return member
      ? { kind: 'symbol', ids: [member.id] }
      : {
          kind: 'unresolved',
          reason: 'not a member of the imported class (inherited or dynamic)',
        };
  }

  /** What an import binding brings in, from the module it points at. */
  async #importedSymbol(
    file: string,
    imported: string,
    local: string,
  ): Promise<SymbolFact | undefined> {
    if (imported !== 'default') return this.#linker.exportedSymbol(file, imported);
    // A default export has no name of its own here; take the one the importer calls it, or the
    // only thing the file exports.
    const byLocal = await this.#linker.exportedSymbol(file, local);
    if (byLocal) return byLocal;
    const table = await this.#linker.exportsOf(file);
    const all = table ? [...table.exported.values()].flat() : [];
    return all.length === 1 ? all[0] : undefined;
  }

  async #member(file: string, qualified: string): Promise<SymbolFact | undefined> {
    const table = await this.#linker.exportsOf(file);
    return table?.byName.get(qualified)?.at(-1);
  }

  /**
   * The receiver's type is not written down, so this looks for methods of that name: first in
   * this file, then in the files it imports, then in the files those import, taking the nearest
   * that has any. It is a guess and is recorded as one.
   */
  async #byNameAmongVisible(name: string, excludedClass: string | undefined): Promise<CallOutcome> {
    const own = (this.#byBaseName.get(name) ?? []).filter(
      (symbol) => symbol.parentId !== undefined && symbol.parentId !== excludedClass,
    );
    if (own.length > 0) return { kind: 'byName', ids: own.map((symbol) => symbol.id) };

    const nearest = await this.#linker.nearestMembers(this.#facts.path, name);
    const ids = nearest.filter((symbol) => symbol.parentId !== excludedClass).map((s) => s.id);
    if (ids.length === 0) {
      return {
        kind: 'unresolved',
        reason: 'receiver type unknown, no method of that name reachable by imports',
      };
    }
    return { kind: 'byName', ids };
  }
}
