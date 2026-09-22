import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AggregateFailureError,
  type CodeLensError,
  type Deadline,
  decodeCursor,
  encodeCursor,
  InvalidArgumentError,
  type Page,
  type PageRequest,
  resolveLimit,
  toCodeLensError,
} from '@cntxt-labs/code-lens-core';
import {
  budgetFor,
  budgetSourceOf,
  type Card,
  ChannelRegistry,
  createTransformServices,
  docsTransformer,
  type Embedder,
  Ingester,
  type InputFile,
  type InputSource,
  inputFile,
  type Preview,
  previewCards,
  type RedTeamGate,
  retrieve as retrieveDense,
  type ScaffoldTemplate,
  type SearchHit,
  type SyncReport,
  scaffoldChannel,
  symbolsTransformer,
  type VectorStore,
} from '@cntxt-labs/code-lens-dense';
import {
  type DriftReport,
  FactExtractor,
  type FactExtractor as FactExtractorType,
  type FragmentManifest,
  GraphQueries,
  IMPORT_EDGE_KINDS,
  Indexer,
  type IndexReport,
  type IndexStats,
  type IndexStore,
  loadManifest,
  proposeClustered,
  proposePathPrior,
  type RunOptions,
  ShardSet,
  SqliteIndexStore,
  SqliteVectorStore,
  type SymbolFact,
  saveManifest,
  Workspace,
} from '@cntxt-labs/code-lens-indexer';
import {
  KNOWN_ATTRIBUTES,
  looksLikeWql,
  type MappingRegistry,
  parseWql,
  StructuralEngine,
  type WqlHit,
  WqlUnknownNameError,
} from '@cntxt-labs/code-lens-structural';
import type { SyntaxRuntime } from '@cntxt-labs/code-lens-syntax';
import { loadChannelModule } from './channel-module.ts';
import {
  type ChannelConfig,
  loadProjectConfig,
  PROJECT_CONFIG_PATH,
  type ProjectConfig,
} from './config.ts';
import {
  EmbedderUnavailableError,
  NotIndexedError,
  ProjectConfigError,
  TargetError,
} from './errors.ts';
import { type Contribution, DEFAULT_RRF_K, fuse } from './fuse.ts';
import { createRuntime, type GrammarHost } from './grammars.ts';
import {
  type ChannelInfo,
  type Diagnosis,
  diagnoseMiss,
  type Explanation,
  explainProject,
  type Status,
  statusOf,
} from './insight.ts';
import { mappingStoreFor } from './mappings.ts';
import { gateForProject, loadPolicies } from './redteam.ts';
import { type StructuralCoverage, StructuralLane } from './structural-lane.ts';
import { workspaceSource } from './workspace-source.ts';

/** One rule in force, with what each trust level does about it. */
export interface RedTeamRuleInfo {
  readonly id: string;
  readonly category: string;
  readonly severity: string;
  readonly description: string;
  /** `built in`, or the file or module the rule came from. */
  readonly source: string;
  readonly actions: Readonly<Record<'first-party' | 'third-party' | 'untrusted', string>>;
}

export interface RedTeamScan {
  readonly files: number;
  readonly cards: number;
  readonly byRule: readonly {
    readonly rule: string;
    readonly flagged: number;
    readonly sanitized: number;
    readonly quarantined: number;
  }[];
  /** Every card the gate would refuse to index. */
  readonly quarantined: readonly {
    readonly path: string;
    readonly channel: string;
    readonly rules: readonly string[];
  }[];
}

/** How an index is spread over fragments. */
export interface FragmentStatus {
  readonly enabled: boolean;
  readonly algorithm: { readonly id: string; readonly version: number } | undefined;
  readonly drift: DriftReport | undefined;
}

export interface RetrieverOptions {
  readonly root: string;
  /** Dense retrieval needs one. Without it only structural queries and graph queries work. */
  readonly embedder?: Embedder;
  /** Reads `.code-lens/config.json` when unset. */
  readonly config?: ProjectConfig;
  /** Where grammars come from. Defaults to the standard layout for this project. */
  readonly runtime?: SyntaxRuntime;
  /** Where grammars come from when no `runtime` is given. */
  readonly grammars?: GrammarHost;
  /** The mappings that decide what an outline holds. Defaults to the bundled ones with the project's and user's over them. */
  readonly mappings?: MappingRegistry;
  /** Defaults to `<root>/.code-lens/index.db`. */
  readonly databasePath?: string;
  /** Index only these languages. */
  readonly only?: readonly string[];
}

/** One found thing, whichever lane found it. */
export interface SearchResult {
  /** Same thing across lanes: `path:line` for anything with a place, else the card id. */
  readonly key: string;
  readonly path: string;
  readonly line: number | undefined;
  readonly endLine: number | undefined;
  /** A name a reader recognises: the symbol, the section, the tag and name of a node. */
  readonly title: string;
  readonly kind: string | undefined;
  /** The card that matched, when a dense lane did. Its text is untrusted. */
  readonly card: Card | undefined;
  /**
   * Rank-fusion position across lanes, not similarity. Only meaningful to compare items within
   * this same result page — a great match and a query with no good matches at all can come out
   * with the same top `score`, since it reflects "beat the others here," not "is relevant." Use
   * `bestScore` to judge relevance.
   */
  readonly score: number;
  /**
   * The strongest real similarity any lane reported (e.g. a dense channel's cosine score), or
   * `undefined` when only lanes with no such score (structural) found it. This is what answers
   * "is this actually a good match" — `score` cannot.
   */
  readonly bestScore: number | undefined;
  readonly foundBy: readonly Contribution[];
}

export interface SearchOptions extends PageRequest {
  /** Only these dense channels. Default: every enabled one. */
  readonly channels?: readonly string[];
  /** Leave these lanes out (a channel name, or `structural`). */
  readonly exclude?: readonly string[];
  /**
   * How much each lane counts in this search, over what the project config says (a channel name,
   * or `structural`). A lane that is not named keeps its configured weight; 0 leaves it out. Use it
   * to ask for code without documentation, or the reverse, for one question.
   */
  readonly weights?: Readonly<Record<string, number>>;
  readonly deadline?: Deadline;
}

export interface SearchPage extends Page<SearchResult> {
  /** Lanes that ran, and how many hits each returned. */
  readonly lanes: readonly { readonly name: string; readonly hits: number }[];
  /** Lanes that failed. The search carried on without them. */
  readonly degraded: readonly { readonly lane: string; readonly error: CodeLensError }[];
  /** How deep each lane was read to build this page. */
  readonly depth: number;
}

export type { ChannelInfo };

const BUILTIN_CHANNELS = ['symbols', 'docs'] as const;

/**
 * A project opened for retrieval: its index, its channels, and what can be asked of them.
 *
 * Retrieval is dense (a channel of embedded cards each) and structural (WQL over outlines), and
 * `search` fuses them by rank. Lexical and grep lanes do not exist here, and an exact name is a
 * WQL query (`//function[@name="parse"]`), so there is no separate symbol lookup.
 */
export class Retriever {
  readonly root: string;
  readonly workspace: Workspace;
  readonly store: IndexStore;
  readonly vectors: VectorStore;
  readonly registry: ChannelRegistry;
  readonly embedder: Embedder | undefined;
  readonly config: ProjectConfig;
  readonly engine: StructuralEngine;
  readonly #runtime: SyntaxRuntime;
  readonly #ownsRuntime: boolean;
  readonly #extractor: FactExtractorType;
  readonly #ingester: Ingester | undefined;
  readonly #sources = new Map<string, InputSource>();
  readonly #modules = new Map<string, string>();
  readonly #structure: StructuralLane;
  readonly #graph: GraphQueries;
  readonly #only: readonly string[] | undefined;
  readonly #shards: ShardSet | undefined;
  readonly #gate: RedTeamGate;

  private constructor(parts: {
    root: string;
    workspace: Workspace;
    store: IndexStore;
    vectors: VectorStore;
    shards: ShardSet | undefined;
    gate: RedTeamGate;
    registry: ChannelRegistry;
    embedder: Embedder | undefined;
    config: ProjectConfig;
    engine: StructuralEngine;
    runtime: SyntaxRuntime;
    ownsRuntime: boolean;
    only: readonly string[] | undefined;
  }) {
    this.root = parts.root;
    this.workspace = parts.workspace;
    this.store = parts.store;
    this.vectors = parts.vectors;
    this.registry = parts.registry;
    this.embedder = parts.embedder;
    this.config = parts.config;
    this.engine = parts.engine;
    this.#runtime = parts.runtime;
    this.#ownsRuntime = parts.ownsRuntime;
    this.#only = parts.only;
    this.#shards = parts.shards;
    this.#gate = parts.gate;
    this.#extractor = new FactExtractor(parts.engine);
    this.#structure = new StructuralLane(parts.store);
    this.#graph = new GraphQueries(parts.store, (path) => parts.workspace.packageOf(path));
    this.#ingester = parts.embedder
      ? new Ingester({
          registry: parts.registry,
          embedder: parts.embedder,
          store: parts.vectors,
          gate: parts.gate,
          services: createTransformServices(parts.engine),
        })
      : undefined;
  }

  static async open(options: RetrieverOptions): Promise<Retriever> {
    const config = options.config ?? (await loadProjectConfig(options.root));
    // Mappings first: a mapping that is not what was recorded stops the open before anything is held.
    const mappings =
      options.mappings ?? (await mappingStoreFor(options.root, options.grammars).registry());
    // The red-team policy too: a rule file that does not check out stops the open before anything is held.
    const gate = await gateForProject(options.root);
    const workspace = await Workspace.open({ root: options.root });
    const databasePath = options.databasePath ?? join(options.root, '.code-lens', 'index.db');
    // One database, or one per fragment when the project asks for that (and has said what they are).
    let shards: ShardSet | undefined;
    let store: IndexStore;
    let vectors: VectorStore;
    if (config.fragments) {
      const manifest = await loadManifest(options.root);
      if (!manifest) {
        throw new ProjectConfigError(
          join(options.root, PROJECT_CONFIG_PATH),
          'indexing.fragments',
          'is "on" but there is no .code-lens/fragments.json',
          { hint: 'Run `code-lens fragments enable`, which proposes one and turns this on.' },
        );
      }
      shards = await ShardSet.open({ directory: join(dirname(databasePath), 'shards'), manifest });
      store = shards.index;
      vectors = shards.vectors;
    } else {
      const single = SqliteIndexStore.open(databasePath);
      store = single;
      vectors = new SqliteVectorStore(single.database);
    }
    const ownsRuntime = options.runtime === undefined;
    const runtime =
      options.runtime ??
      (await createRuntime(options.root, { npmFrom: import.meta.filename, ...options.grammars }));
    const engine = new StructuralEngine({ runtime, mappings });

    const registry = new ChannelRegistry();
    const retriever = new Retriever({
      root: options.root,
      workspace,
      store,
      vectors,
      shards,
      gate,
      registry,
      embedder: options.embedder,
      config,
      engine,
      runtime,
      ownsRuntime,
      only: options.only,
    });
    try {
      await retriever.#registerChannels();
    } catch (failure) {
      await retriever.close();
      throw failure;
    }
    return retriever;
  }

  async #registerChannels(): Promise<void> {
    for (const [name, transformer] of [
      ['symbols', symbolsTransformer],
      ['docs', docsTransformer],
    ] as const) {
      if (this.config.channels[name]?.enabled === false) continue;
      this.registry.register(transformer());
    }
    for (const [name, channel] of Object.entries(this.config.channels)) {
      if (!channel.enabled || channel.module === undefined) continue;
      const loaded = await loadChannelModule(name, channel.module, this.root);
      this.registry.register(loaded.transformer);
      this.#modules.set(name, channel.module);
      if (loaded.source) this.#sources.set(name, loaded.source);
    }
  }

  async close(): Promise<void> {
    if (this.#shards) await this.#shards.close();
    else await this.store.close();
    if (this.#ownsRuntime) await this.#runtime.dispose();
  }

  // --- indexing ---------------------------------------------------------------------------------

  /**
   * Bring the index up to date: files, graph and dense cards for changed files (see `Indexer`),
   * then every channel that reads from a source of its own.
   */
  async index(
    options: RunOptions = {},
  ): Promise<{ readonly report: IndexReport; readonly synced: readonly SyncReport[] }> {
    await this.#settleShards();
    const indexer = new Indexer({
      workspace: this.workspace,
      store: this.store,
      extractor: this.#extractor,
      ...(this.#ingester ? { ingester: this.#ingester } : {}),
      ...(this.#only ? { only: this.#only } : {}),
    });
    const report = await indexer.index(options);
    const synced: SyncReport[] = [];
    if (this.#ingester) {
      for (const [name, source] of this.#sources) {
        synced.push(
          await this.#ingester.syncChannel(name, source, {
            ...(options.deadline ? { deadline: options.deadline } : {}),
            ...(options.force ? { force: true } : {}),
          }),
        );
      }
    }
    await this.#structure.refresh();
    return { report, synced };
  }

  /** Bring one channel up to date from its own source, or from the project's files. */
  async indexChannel(
    channel: string,
    options: { readonly force?: boolean; readonly deadline?: Deadline } = {},
  ): Promise<SyncReport> {
    const ingester = this.#requireIngester();
    this.registry.require(channel);
    const source = this.#sources.get(channel) ?? workspaceSource(this.workspace, channel);
    return ingester.syncChannel(channel, source, {
      ...(options.force ? { force: true } : {}),
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });
  }

  // --- retrieval --------------------------------------------------------------------------------

  /**
   * One dense channel, best card first. Card text in the result is untrusted content: render it
   * with `fenceUntrusted`.
   */
  async retrieve(
    channel: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<Page<SearchHit>> {
    this.registry.require(channel);
    return retrieveDense({
      channel,
      query,
      embedder: this.#requireEmbedder(),
      store: this.vectors,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });
  }

  /** Structural retrieval: a WQL query over the outlines of every indexed file. */
  async query(
    wql: string,
    options: SearchOptions = {},
  ): Promise<Page<WqlHit> & { readonly coverage: StructuralCoverage }> {
    await this.#requireIndexed();
    const coverage = await this.#structure.refresh();
    const parsed = parseWql(wql);
    const knownTags = this.engine.mappings.knownTags();
    for (const step of parsed.steps) {
      if (step.tag !== '*' && !knownTags.has(step.tag)) {
        throw new WqlUnknownNameError(wql, 'tag', step.tag, [...knownTags]);
      }
      for (const predicate of step.predicates) {
        if (!KNOWN_ATTRIBUTES.has(predicate.attr)) {
          throw new WqlUnknownNameError(wql, 'attribute', predicate.attr, [...KNOWN_ATTRIBUTES]);
        }
      }
    }
    const result = this.#structure.query(parsed, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.deadline ? { deadline: options.deadline } : {}),
    });
    return { ...result, coverage };
  }

  /**
   * Every enabled dense channel and, when the query is WQL, the structural lane, fused by rank
   * with each channel's weight. A lane that fails is reported and left out; the search fails only
   * if no lane could run at all.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchPage> {
    await this.#requireIndexed();
    const { value: limit, source } = resolveLimit('limit', options.limit);
    const offset = options.cursor === undefined ? 0 : decodeCursor(options.cursor);
    const depth = offset + limit + 1;
    const wanted = options.channels ?? this.registry.channels();
    const laneNames = new Set([...this.registry.channels(), 'structural']);
    for (const [option, names] of [
      ['exclude', options.exclude ?? []],
      ['weights', Object.keys(options.weights ?? {})],
    ] as const) {
      for (const name of names) {
        if (!laneNames.has(name)) {
          throw new InvalidArgumentError(option, `lanes among ${[...laneNames].join(', ')}`, name);
        }
      }
    }
    for (const [name, weight] of Object.entries(options.weights ?? {})) {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new InvalidArgumentError(`weights.${name}`, 'a number of at least 0', weight);
      }
    }
    const weightOf = (lane: string, configured: number): number =>
      options.weights?.[lane] ?? configured;
    const left = (lane: string, configured: number): boolean =>
      !(options.exclude ?? []).includes(lane) && weightOf(lane, configured) > 0;

    const runs: { name: string; weight: number; run: () => Promise<LaneHit[]> }[] = [];
    if (this.embedder) {
      for (const channel of wanted) {
        if (!this.registry.has(channel)) continue;
        const configured = this.config.channels[channel]?.weight ?? 1;
        if (!left(channel, configured)) continue;
        runs.push({
          name: channel,
          weight: weightOf(channel, configured),
          run: async () =>
            (
              await retrieveDense({
                channel,
                query,
                embedder: this.embedder as Embedder,
                store: this.vectors,
                limit: depth,
                ...(options.deadline ? { deadline: options.deadline } : {}),
              })
            ).items.map(cardHit),
        });
      }
    }
    if (looksLikeWql(query) && left('structural', 1)) {
      runs.push({
        name: 'structural',
        weight: weightOf('structural', 1),
        run: async () => {
          await this.#structure.refresh();
          return this.#structure
            .query(query, {
              limit: depth,
              ...(options.deadline ? { deadline: options.deadline } : {}),
            })
            .items.map(wqlHit);
        },
      });
    }
    if (runs.length === 0 && (options.exclude?.length || options.weights)) {
      throw new InvalidArgumentError(
        'exclude/weights',
        'a search that keeps at least one lane',
        [...(options.exclude ?? []), ...Object.keys(options.weights ?? {})].join(', '),
      );
    }
    if (runs.length === 0) {
      throw new EmbedderUnavailableError(
        'the query is not structural (WQL) and there is no embedder for dense channels',
      );
    }

    const settled = await Promise.allSettled(runs.map((lane) => lane.run()));
    const lanes: { name: string; weight: number; hits: LaneHit[] }[] = [];
    const degraded: { lane: string; error: CodeLensError }[] = [];
    settled.forEach((outcome, index) => {
      const lane = runs[index] as (typeof runs)[number];
      if (outcome.status === 'fulfilled') {
        lanes.push({ name: lane.name, weight: lane.weight, hits: outcome.value });
      } else {
        options.deadline?.throwIfExpired(`search for "${query}"`);
        degraded.push({
          lane: lane.name,
          error: toCodeLensError(outcome.reason, `search ${lane.name}`),
        });
      }
    });
    if (lanes.length === 0) {
      throw new AggregateFailureError(
        `search for "${query}"`,
        degraded.map((entry) => entry.error),
      );
    }

    const fused = fuse(
      lanes.map((lane) => ({
        name: lane.name,
        weight: lane.weight,
        hits: lane.hits.map((hit) => ({
          key: hit.key,
          item: hit,
          ...(hit.score === undefined ? {} : { score: hit.score }),
        })),
      })),
      this.config.fusionK ?? DEFAULT_RRF_K,
    );
    const items = fused.map(
      (entry): SearchResult => ({
        ...entry.item.result,
        score: entry.score,
        bestScore: entry.bestScore,
        foundBy: entry.foundBy,
      }),
    );
    const more = items.length > offset + limit;
    return {
      items: items.slice(offset, offset + limit),
      total: more ? null : items.length,
      nextCursor: more ? encodeCursor(offset + limit) : null,
      limit: { name: 'limit', applied: limit, source, reached: more },
      lanes: lanes.map((lane) => ({ name: lane.name, hits: lane.hits.length })),
      degraded,
      depth,
    };
  }

  // --- the graph --------------------------------------------------------------------------------

  /**
   * The symbol a target names. A target is a symbol id (`src/a.ts#Store.get`), a place
   * (`src/a.ts:42`, the innermost symbol on that line), or a name (`Store.get`, or `get` when only
   * one symbol has it). Several matches are an error that lists them: guessing would answer a
   * question nobody asked.
   */
  async resolveTarget(target: string): Promise<SymbolFact> {
    await this.#requireIndexed();
    const exact = await this.store.symbol(target);
    if (exact) return exact;

    const place = /^(.+):(\d+)$/.exec(target);
    if (place?.[1] && place[2]) {
      const line = Number.parseInt(place[2], 10);
      const inFile = (await this.store.findSymbols({ path: place[1] })).items.filter(
        (symbol) => symbol.startLine <= line && line <= symbol.endLine,
      );
      const innermost = inFile.sort(
        (a, b) => b.startLine - a.startLine || a.endLine - b.endLine,
      )[0];
      if (innermost) return innermost;
      throw new TargetError(target, 'is not inside any indexed symbol', []);
    }

    for (const query of [{ name: target }, { baseName: target }]) {
      const found = (await this.store.findSymbols(query)).items;
      if (found.length === 1) return found[0] as SymbolFact;
      if (found.length > 1) {
        throw new TargetError(
          target,
          `names ${found.length} symbols`,
          found.map((s) => s.id),
        );
      }
    }
    throw new TargetError(target, 'names no indexed symbol', []);
  }

  async callers(target: string, request: PageRequest & { readonly resolvedOnly?: boolean } = {}) {
    const symbol = await this.resolveTarget(target);
    return { symbol, callers: await this.#graph.callers(symbol.id, request) };
  }

  async callees(target: string, request: PageRequest = {}) {
    const symbol = await this.resolveTarget(target);
    return { symbol, callees: await this.#graph.callees(symbol.id, request) };
  }

  async neighbors(target: string, request: PageRequest = {}) {
    const symbol = await this.resolveTarget(target);
    return { symbol, ...(await this.#graph.neighbors(symbol.id, request)) };
  }

  async dependents(
    path: string,
    options: { readonly depth?: number; readonly includeTypeOnly?: boolean } = {},
  ) {
    await this.#requireIndexed();
    return this.#graph.dependents(path, options);
  }

  async dependencies(path: string, request: PageRequest = {}) {
    await this.#requireIndexed();
    return this.#graph.dependencies(path, request);
  }

  get graph(): GraphQueries {
    return this.#graph;
  }

  get structure(): StructuralLane {
    return this.#structure;
  }

  // --- channels ---------------------------------------------------------------------------------

  async channels(): Promise<readonly ChannelInfo[]> {
    const names = new Set([...this.registry.channels(), ...Object.keys(this.config.channels)]);
    const info: ChannelInfo[] = [];
    for (const name of [...names].sort()) {
      const settings: ChannelConfig | undefined = this.config.channels[name];
      const transformers = this.registry.has(name) ? this.registry.require(name) : [];
      const first = transformers[0];
      const stats = await this.vectors.stats(name);
      info.push({
        name,
        builtin: (BUILTIN_CHANNELS as readonly string[]).includes(name),
        module: this.#modules.get(name) ?? settings?.module,
        enabled: settings?.enabled ?? this.registry.has(name),
        weight: settings?.weight ?? 1,
        transformers: transformers.map((t) => ({ name: t.name, version: t.version })),
        trust: first?.trust ?? 'n/a',
        categoryId: first?.categoryId ?? 'n/a',
        hasSource: this.#sources.has(name),
        cards: stats.cards,
        sources: stats.sources,
        quarantined: stats.quarantined,
      });
    }
    return info;
  }

  /**
   * Run a channel's transformer on one file and screen the cards, changing nothing: what
   * `channel test` shows before a channel is indexed for real.
   */
  async testChannel(channel: string, file: InputFile, deadline?: Deadline): Promise<Preview[]> {
    const embedder = this.#requireEmbedder();
    const previews: Preview[] = [];
    for (const transformer of this.registry.require(channel)) {
      if (!transformer.claim(file)) continue;
      previews.push(
        await previewCards(transformer, file, {
          budget: budgetFor(budgetSourceOf(embedder)),
          services: createTransformServices(this.engine),
          gate: this.#gate,
          ...(deadline ? { deadline } : {}),
        }),
      );
    }
    return previews;
  }

  /**
   * Create a channel: scaffold its transformer under `.code-lens/channels/<name>/` if there is none
   * yet, and register it in the project config. `module` registers one that already exists.
   */
  async addChannel(
    name: string,
    options: { readonly template?: ScaffoldTemplate; readonly module?: string } = {},
  ): Promise<{
    readonly scaffolded: readonly string[];
    readonly module: string;
    readonly nextSteps: readonly string[];
  }> {
    const scaffolded: string[] = [];
    let module = options.module;
    let nextSteps: readonly string[] = [];
    if (module === undefined) {
      const scaffold = scaffoldChannel(name, options.template ?? 'file');
      const directory = join('.code-lens', 'channels', name);
      for (const file of scaffold.files) {
        const target = join(this.root, directory, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: 'wx' }).catch(async (failure: unknown) => {
          if ((failure as { code?: unknown } | null)?.code !== 'EEXIST') throw failure;
        });
        scaffolded.push(join(directory, file.path).replaceAll('\\', '/'));
      }
      module = `./${directory.replaceAll('\\', '/')}/transformer.ts`;
      nextSteps = scaffold.nextSteps;
    }
    await this.#saveChannel(name, { enabled: true, weight: 1, module });
    return { scaffolded, module, nextSteps };
  }

  /** Remove a channel: its cards, and its entry in the project config. */
  async removeChannel(name: string): Promise<{ readonly removedSources: number }> {
    let removedSources = 0;
    for (const path of await this.vectors.sourcePaths(name)) {
      if (await this.vectors.removeSource(name, path)) removedSources += 1;
    }
    this.registry.unregister(name);
    this.#sources.delete(name);
    const { [name]: _removed, ...rest } = this.config.channels;
    await this.#writeConfig({ ...this.config, channels: rest });
    return { removedSources };
  }

  async #saveChannel(name: string, channel: ChannelConfig): Promise<void> {
    await this.#writeConfig({
      ...this.config,
      channels: { ...this.config.channels, [name]: channel },
    });
  }

  async #writeConfig(config: ProjectConfig): Promise<void> {
    const path = join(this.root, PROJECT_CONFIG_PATH);
    await mkdir(dirname(path), { recursive: true });
    const raw = {
      ...(config.model === undefined ? {} : { model: config.model }),
      channels: Object.fromEntries(
        Object.entries(config.channels).map(([name, channel]) => [
          name,
          {
            ...(channel.enabled ? {} : { enabled: false }),
            ...(channel.weight === 1 ? {} : { weight: channel.weight }),
            ...(channel.module === undefined ? {} : { module: channel.module }),
          },
        ]),
      ),
      ...(config.fusionK === undefined ? {} : { fusion: { k: config.fusionK } }),
      ...(config.fragments ? { indexing: { fragments: 'on' } } : {}),
    };
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
  }

  // --- red team ----------------------------------------------------------------------------------

  /** The rules in force, and what each trust level does about each. */
  async redTeamRules(): Promise<readonly RedTeamRuleInfo[]> {
    const policies = await loadPolicies(this.root);
    const custom = new Map<string, string>();
    for (const policy of policies)
      for (const rule of policy.rules) custom.set(rule.id, policy.source);
    return this.#gate.rules.map((rule) => ({
      id: rule.id,
      category: rule.category,
      severity: rule.severity,
      description: rule.description,
      source: custom.get(rule.id) ?? 'built in',
      actions: Object.fromEntries(
        (['first-party', 'third-party', 'untrusted'] as const).map((trust) => {
          const profile = this.#gate.profileFor(trust);
          return [trust, profile.rules[rule.id] ?? profile.fallback[rule.severity]];
        }),
      ) as RedTeamRuleInfo['actions'],
    }));
  }

  /**
   * Run every channel's transformers over the indexed files and report what the gate would flag,
   * sanitize or quarantine, by rule. It writes nothing. Run after adding a rule: a rule that
   * quarantines the project's own code is a false positive worth knowing about before an index run.
   */
  async redTeamScan(options: { readonly deadline?: Deadline } = {}): Promise<RedTeamScan> {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.files({ status: 'indexed', ...(cursor ? { cursor } : {}) });
      paths.push(...page.items.map((file) => file.path));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const byRule = new Map<string, { flagged: number; sanitized: number; quarantined: number }>();
    const quarantined: { path: string; channel: string; rules: string[] }[] = [];
    let cards = 0;
    for (const path of paths) {
      options.deadline?.throwIfExpired(`scan ${path}`);
      const content = await readFile(join(this.root, path), 'utf8');
      const file = inputFile(path, content);
      for (const channel of this.registry.channels()) {
        for (const preview of await this.testChannel(channel, file, options.deadline)) {
          cards += preview.cards.length;
          for (const finding of preview.screened.findings) {
            const entry = byRule.get(finding.ruleId) ?? {
              flagged: 0,
              sanitized: 0,
              quarantined: 0,
            };
            if (finding.action === 'quarantine') entry.quarantined += 1;
            else if (finding.action === 'sanitize') entry.sanitized += 1;
            else entry.flagged += 1;
            byRule.set(finding.ruleId, entry);
          }
          for (const held of preview.screened.quarantined) {
            quarantined.push({
              path,
              channel,
              rules: [...new Set(held.findings.map((finding) => finding.ruleId))],
            });
          }
        }
      }
    }
    return {
      files: paths.length,
      cards,
      byRule: [...byRule]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([rule, counts]) => ({ rule, ...counts })),
      quarantined,
    };
  }

  // --- fragments ---------------------------------------------------------------------------------

  /**
   * When the manifest changed since the shards were last settled, forget what sits in the wrong
   * shard first, so this run indexes it where it now belongs. A first run only records the manifest.
   */
  async #settleShards(): Promise<void> {
    if (!this.#shards) return;
    if (await this.#shards.needsSettling()) await this.#shards.settle(this.registry.channels());
    else await this.#shards.recordManifest();
  }

  /** How the index is spread over fragments, and what is out of place. */
  async fragmentStatus(): Promise<FragmentStatus> {
    if (!this.#shards) return { enabled: false, drift: undefined, algorithm: undefined };
    return {
      enabled: true,
      drift: await this.#shards.drift(this.registry.channels()),
      algorithm: this.#shards.assigner.manifest.algorithm,
    };
  }

  /** Move what sits in the wrong shard, without indexing. */
  async settleFragments(): Promise<
    | {
        readonly movedFiles: number;
        readonly movedSources: number;
        readonly removedShards: readonly string[];
      }
    | undefined
  > {
    return this.#shards?.settle(this.registry.channels());
  }

  /**
   * A manifest proposed from what is indexed: `path` follows the layout (free, and where a small
   * repository should stop), `clusters` follows the imports. Nothing is written; the caller decides.
   */
  async proposeFragments(options: {
    readonly tier: 'path' | 'clusters';
    readonly resolution?: number;
    readonly labels?: Readonly<Record<string, string>>;
  }): Promise<FragmentManifest> {
    await this.#requireIndexed();
    const files: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.files({ status: 'indexed', ...(cursor ? { cursor } : {}) });
      files.push(...page.items.map((file) => file.path));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const packageRoots = this.workspace.packages().map((pkg) => pkg.root);
    if (options.tier === 'path') return proposePathPrior({ files, packageRoots });

    const known = new Set(files);
    const imports: [string, string][] = [];
    let after: string | undefined;
    do {
      const page = await this.store.findEdges({
        kinds: IMPORT_EDGE_KINDS,
        ...(after ? { cursor: after } : {}),
      });
      for (const edge of page.items)
        if (known.has(edge.from) && known.has(edge.to)) imports.push([edge.from, edge.to]);
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    return proposeClustered({
      files,
      packageRoots,
      imports,
      ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
      ...(options.labels ? { labels: options.labels } : {}),
    });
  }

  /** Save a manifest to `.code-lens/fragments.json`. */
  saveFragments(manifest: FragmentManifest): Promise<string> {
    return saveManifest(this.root, manifest);
  }

  /** Turn sharded indexing on or off in the project config. Takes effect the next time it is opened. */
  async setFragments(on: boolean): Promise<void> {
    await this.#writeConfig({ ...this.config, fragments: on });
  }

  // --- internals --------------------------------------------------------------------------------

  #requireEmbedder(): Embedder {
    if (!this.embedder) throw new EmbedderUnavailableError('this project was opened without one');
    return this.embedder;
  }

  #requireIngester(): Ingester {
    this.#requireEmbedder();
    return this.#ingester as Ingester;
  }

  async #requireIndexed(): Promise<void> {
    const stats: IndexStats = await this.store.stats();
    if (stats.files === 0) throw new NotIndexedError(this.root);
  }

  status(): Promise<Status> {
    return statusOf(this);
  }

  explain(options: { readonly limit?: number } = {}): Promise<Explanation> {
    return explainProject(this, options);
  }

  diagnose(input: {
    readonly query: string;
    readonly path: string;
    readonly depth?: number;
  }): Promise<Diagnosis> {
    return diagnoseMiss(this, input);
  }
}

interface LaneHit {
  readonly key: string;
  readonly score: number | undefined;
  readonly result: Omit<SearchResult, 'score' | 'bestScore' | 'foundBy'>;
}

function cardHit(hit: SearchHit): LaneHit {
  const { card } = hit;
  const line = card.source.span?.startLine;
  // The symbol is what a structural hit names too, so the two lanes agree on what is the same.
  const key = card.attrs.symbol
    ? `${card.source.path}#${card.attrs.symbol}`
    : `${card.channel}:${card.id}`;
  return {
    key,
    score: hit.score,
    result: {
      key,
      path: card.source.path,
      line,
      endLine: card.source.span?.endLine,
      title: card.attrs.symbol ?? card.attrs.section ?? card.attrs.title ?? card.id,
      kind: card.attrs.kind ?? card.categoryLabel,
      card,
    },
  };
}

function wqlHit(hit: WqlHit): LaneHit {
  const path = hit.path ?? '';
  const key = hit.name ? `${path}#${hit.name}` : `${path}:${hit.tag}:${hit.startLine ?? ''}`;
  return {
    key,
    score: undefined,
    result: {
      key,
      path,
      line: hit.startLine,
      endLine: hit.endLine,
      title: hit.name ?? hit.tag,
      kind: hit.tag,
      card: undefined,
    },
  };
}
