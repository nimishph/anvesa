import { CodeLensError, type Page } from '@cntxt-labs/anvesa-core';
import {
  type AuditReport,
  type ChannelInfo,
  type Diagnosis,
  type Explanation,
  type FragmentManifest,
  type FragmentStatus,
  fenceUntrusted,
  type Golden,
  type GoldenDifference,
  type GrammarRow,
  type IndexReport,
  type MappingCheck,
  type ModelDoctor,
  type ModelRow,
  type PatternInventory,
  type PatternRunResult,
  type RedTeamRuleInfo,
  type RedTeamScan,
  type RefineResult,
  type RepoMapResult,
  type RepoMapTreeNode,
  type RouteInfo,
  type SearchPage,
  type SearchResult,
  type Status,
  type StoredMapping,
  type TrainedResult,
} from '@cntxt-labs/anvesa-retriever';

/** JSON for machines: maps become objects, errors keep their code and context, trees are left out. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (key, item: unknown) => {
      if (key === 'node') return undefined;
      if (item instanceof Map) return Object.fromEntries(item);
      if (item instanceof Set) return [...item];
      if (item instanceof CodeLensError) return item.toJSON();
      if (item instanceof Float32Array) return undefined;
      if (item === Number.POSITIVE_INFINITY) return 'Infinity';
      return item;
    },
    2,
  )}\n`;
}

const lines = (...parts: (string | undefined)[]): string =>
  `${parts.filter((part): part is string => part !== undefined).join('\n')}\n`;

function pageFooter(page: Page<unknown>, label = 'results'): string {
  const shown = page.items.length;
  const of = page.total === null ? '' : ` of ${page.total}`;
  const limit = `limit ${page.limit.applied} (${page.limit.source})`;
  const next = page.nextCursor === null ? '' : `\nmore: --cursor ${page.nextCursor}`;
  return `${shown}${of} ${label}, ${limit}${next}`;
}

function place(result: {
  path: string;
  line?: number | undefined;
  endLine?: number | undefined;
}): string {
  if (result.line === undefined) return result.path;
  return result.endLine !== undefined && result.endLine !== result.line
    ? `${result.path}:${result.line}-${result.endLine}`
    : `${result.path}:${result.line}`;
}

function renderResult(result: SearchResult, index: number): string {
  const found = result.foundBy.map((c) => `${c.lane}#${c.rank}`).join(' ');
  const signature = result.card?.attrs.signature;
  const best = result.bestScore === undefined ? '' : `  best ${result.bestScore.toFixed(3)}`;
  const head = `${String(index + 1).padStart(2)}. ${result.title}${result.kind ? ` (${result.kind})` : ''}  ${place(result)}${signature ? `  ${signature}` : ''}  [${found}]${best}`;
  if (!result.card) return head;
  const fenced = fenceUntrusted(result.card.text, {
    source: result.card.source.path,
    channel: result.card.channel,
    trust: result.card.provenance.trust,
  });
  return `${head}\n${fenced.replace(/^/gm, '      ')}`;
}

export function renderSearch(page: SearchPage): string {
  const conjunctionHead = page.conjunction
    ? `conjunction: semantic "${page.conjunction.semantic}" && wql "${page.conjunction.wql}"`
    : undefined;
  return lines(
    conjunctionHead,
    ...page.items.map(renderResult),
    pageFooter(page),
    `lanes: ${page.lanes.map((l) => `${l.name} ${l.hits}`).join(', ')}`,
    ...page.degraded.map((d) => `degraded: ${d.lane} — ${d.error.message}`),
  );
}

export function renderRetrieved(
  page: Page<{ card: SearchResult['card'] & object; score: number }> & {
    screen?: { withheld: number; sanitized: number } | undefined;
  },
): string {
  const rows = page.items.map((hit, index) => {
    const { card } = hit;
    const at = place({
      path: card.source.path,
      line: card.source.span?.startLine,
      endLine: card.source.span?.endLine,
    });
    const signature = card.attrs.signature;
    const fenced = fenceUntrusted(card.text, {
      source: card.source.path,
      channel: card.channel,
      trust: card.provenance.trust,
    });
    return `${String(index + 1).padStart(2)}. ${card.attrs.symbol ?? card.attrs.section ?? card.id}  ${at}${signature ? `  ${signature}` : ''}  score ${hit.score.toFixed(3)}\n${fenced.replace(/^/gm, '      ')}`;
  });
  const screen = page.screen;
  const note =
    screen && (screen.withheld > 0 || screen.sanitized > 0)
      ? `red-team screen at retrieval: ${screen.withheld} card(s) withheld, ${screen.sanitized} cleaned`
      : undefined;
  return lines(...rows, ...(note ? [note] : []), pageFooter(page, 'cards'));
}

export function renderStructural(
  page: Page<{
    path: string | undefined;
    tag: string;
    name: string | undefined;
    startLine: number | undefined;
    endLine: number | undefined;
    signature: string | undefined;
    score?: number | undefined;
  }> & {
    coverage: { files: number; missing: readonly string[] };
    conjunction?: { semantic: string; wql: string } | undefined;
  },
): string {
  const rows = page.items.map((hit) => {
    const at = place({ path: hit.path ?? '', line: hit.startLine, endLine: hit.endLine });
    const scoreStr = hit.score !== undefined ? `  score ${hit.score.toFixed(3)}` : '';
    return `${hit.tag} ${hit.name ?? ''}  ${at}${hit.signature ? `  ${hit.signature}` : ''}${scoreStr}`;
  });
  const conjunctionHead = page.conjunction
    ? `conjunction: semantic "${page.conjunction.semantic}" && wql "${page.conjunction.wql}"`
    : undefined;
  const missing =
    page.coverage.missing.length > 0
      ? `${page.coverage.missing.length} indexed files have no cached outline and were not searched (run: anvesa index --force)`
      : undefined;
  return lines(
    conjunctionHead,
    ...rows,
    pageFooter(page, 'matches'),
    `searched ${page.coverage.files} files`,
    missing,
  );
}

interface Brief {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string | undefined;
}

/** `name  path:12-20  signature`: what a reader needs to know which symbol this is. */
function describeSymbol(path: string, brief: Brief | undefined, fallback: string): string {
  // A call made outside any symbol has no symbol to describe: the file is the caller.
  if (!brief) return fallback === path ? `${path}  (file level)` : `${fallback}  ${path}`;
  return `${brief.name}  ${place({ path, line: brief.startLine, endLine: brief.endLine })}${brief.signature ? `  ${brief.signature}` : ''}`;
}

/** Where the call is made: `calls at :24, :31`. Nothing when the lines are not known. */
function callSites(lines: readonly number[]): string {
  return lines.length > 0 ? `  calls at ${lines.map((line) => `:${line}`).join(', ')}` : '';
}

export function renderCallers(
  symbol: { id: string; path?: string } & Partial<Brief>,
  page: Page<{
    from: string;
    path: string;
    evidence: string;
    confidence?: string;
    package: string | undefined;
    crossPackage: boolean;
    symbol: Brief | undefined;
    callLines: readonly number[];
  }>,
): string {
  const rows = page.items.map((c) =>
    `${describeSymbol(c.path, c.symbol, c.from)}${callSites(c.callLines)}${c.evidence === 'name' ? '  (guess by name)' : c.confidence === 'inferred' ? '  (inferred from declared type)' : ''}${c.crossPackage ? `  (from ${c.package ?? 'another package'})` : ''}`.trimEnd(),
  );
  return lines(`callers of ${symbolHeading(symbol)}`, ...rows, pageFooter(page, 'callers'));
}

export function renderCallees(
  symbol: { id: string; path?: string } & Partial<Brief>,
  page: Page<{
    to: string;
    kind: string;
    symbol: (Brief & { path?: string }) | undefined;
    callLines: readonly number[];
  }>,
): string {
  return lines(
    `callees of ${symbolHeading(symbol)}`,
    ...page.items.map((c) => {
      const named = c.symbol ? describeSymbol(pathOfSymbolId(c.to), c.symbol, c.to) : c.to;
      return `${named}  (${c.kind})${callSites(c.callLines)}`;
    }),
    pageFooter(page, 'callees'),
  );
}

function symbolHeading(symbol: { id: string; path?: string } & Partial<Brief>): string {
  if (symbol.startLine === undefined || symbol.endLine === undefined) return symbol.id;
  const path = symbol.path ?? pathOfSymbolId(symbol.id);
  return `${symbol.id}  ${place({ path, line: symbol.startLine, endLine: symbol.endLine })}${symbol.signature ? `  ${symbol.signature}` : ''}`;
}

/** A symbol id is `<path>#<name>`. */
function pathOfSymbolId(id: string): string {
  const at = id.indexOf('#');
  return at === -1 ? id : id.slice(0, at);
}

export function renderStatus(status: Status): string {
  const { index } = status;
  return lines(
    `project ${status.root}`,
    `files ${index.files}, quarantined ${index.quarantinedFiles}, symbols ${index.symbols}, calls ${index.calls}, imports ${index.imports}, edges ${index.edges}`,
    `languages: ${index.byLanguage.map((l) => `${l.language} ${l.files}`).join(', ') || 'none'}`,
    status.interrupted ? 'the last index run did not finish; run: anvesa index' : undefined,
    `embedder: ${status.embedder ? `${status.embedder.id} (${status.embedder.dimensions} dims)` : 'none (structural queries only)'}`,
    `structural: ${status.structural.files} files${status.structural.missing.length ? `, ${status.structural.missing.length} not searchable` : ''}`,
    'channels:',
    ...status.channels.map(renderChannelLine),
  );
}

function renderChannelLine(channel: ChannelInfo): string {
  const flags = [
    channel.builtin ? 'built-in' : 'custom',
    channel.enabled ? undefined : 'disabled',
    channel.hasSource ? 'own source' : undefined,
    !channel.builtin && !channel.pinned ? 'module not pinned' : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  return `  ${channel.name}  ${channel.cards} cards from ${channel.sources} sources${channel.quarantined ? `, ${channel.quarantined} quarantined` : ''}  weight ${channel.weight}  trust ${channel.trust}  (${flags})`;
}

export function renderChannels(channels: readonly ChannelInfo[]): string {
  return lines(...channels.map(renderChannelLine));
}

export function renderChannel(channel: ChannelInfo): string {
  return lines(
    renderChannelLine(channel),
    `  category ${channel.categoryId}`,
    channel.module ? `  module ${channel.module}` : undefined,
    `  transformers: ${channel.transformers.map((t) => `${t.name}@${t.version}`).join(', ') || 'none'}`,
  );
}

export function renderIndex(result: {
  report: IndexReport;
  synced: readonly { channel: string; reports: readonly unknown[]; removed: readonly string[] }[];
}): string {
  const { report } = result;
  const f = report.files;

  const missingGrammars = new Map<string, number>();
  for (const q of report.quarantined) {
    const match = q.message.match(/No grammar available for "([^"]+)"/i);
    if (match?.[1]) {
      missingGrammars.set(match[1], (missingGrammars.get(match[1]) ?? 0) + 1);
    }
  }
  const grammarAdvice = [...missingGrammars.entries()].map(
    ([lang, count]) =>
      `advice: ${count} file${count === 1 ? '' : 's'} quarantined because '${lang}' grammar is missing. Run: anvesa grammar install ${lang} --download`,
  );
  return lines(
    `indexed in ${(report.elapsedMs / 1000).toFixed(2)} s${report.resumedAfterInterruption ? ' (after an interrupted run)' : ''}${report.reextracted ? ' (extraction changed: every file read again)' : ''}`,
    `files: ${f.added} added, ${f.modified} modified, ${f.unchanged} unchanged, ${f.touched} re-stamped, ${f.removed} removed, ${f.quarantined + f.stillQuarantined} quarantined`,
    f.unsupported.size > 0
      ? `not source: ${[...f.unsupported].map(([ext, n]) => `${ext || '(none)'} ${n}`).join(', ')}`
      : undefined,
    report.link
      ? `linked ${report.relinked} files: ${report.link.calls.resolved} calls resolved, ${report.link.imports.dangling} imports dangling`
      : undefined,
    report.dense
      ? `dense: ${report.dense.ingested} files embedded (${report.dense.cards} cards), ${report.dense.current} current, ${report.dense.quarantinedCards} cards quarantined, ${report.dense.failed.length} failed`
      : undefined,
    ...report.quarantined.map((q) => `quarantined ${q.path} (${q.reason}): ${q.message}`),
    ...grammarAdvice,
    ...(report.warnings ?? []).map((w) => `warning: ${w}`),
    ...(report.dense?.failed ?? []).map((d) => `failed ${d.path} in ${d.channel}: ${d.message}`),
    ...result.synced.map(
      (s) => `synced ${s.channel}: ${s.reports.length} records, ${s.removed.length} removed`,
    ),
  );
}

export function renderRepoMap(result: RepoMapResult): string {
  const outputLines: string[] = [
    `repomap: ${result.totalFiles} files, ${result.totalSymbols} symbols (ranked by graph centrality)`,
    '',
  ];

  function printNode(node: RepoMapTreeNode, prefix: string, isLast: boolean) {
    if (node.path !== '') {
      const connector = isLast ? '└── ' : '├── ';
      const line = `${prefix}${connector}${node.name}${node.isDir ? '/' : ''}${
        node.importers !== undefined && node.importers > 0 ? ` (${node.importers} importers)` : ''
      }`;
      outputLines.push(line);

      if (!node.isDir && node.symbols && node.symbols.length > 0) {
        const symPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
        const symbols = node.symbols;
        for (let i = 0; i < symbols.length; i += 1) {
          const sym = symbols[i];
          if (!sym) continue;
          const symLast = i === symbols.length - 1;
          const sig = sym.signature ? ` ${sym.signature}` : '';
          const callers = sym.callers > 0 ? ` (${sym.callers} callers)` : '';
          outputLines.push(
            `${symPrefix}${symLast ? '└── ' : '├── '}${sym.kind} ${sym.name}${sig}${callers}`,
          );
        }
      }
    }

    if (node.children && node.children.length > 0) {
      const nextPrefix = node.path === '' ? '' : `${prefix}${isLast ? '    ' : '│   '}`;
      const children = node.children;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (!child) continue;
        printNode(child, nextPrefix, i === children.length - 1);
      }
    }
  }

  printNode(result.tree, '', true);
  return lines(...outputLines);
}

export function renderRoutes(routes: readonly RouteInfo[]): string {
  if (routes.length === 0) {
    return 'no HTTP routes discovered in indexed files\n';
  }

  const rows = routes.map((r) => {
    const method = r.method.padEnd(7, ' ');
    const handler = r.handler ? ` -> ${r.handler}` : '';
    const loc = `(${r.path}:${r.line})`;
    const framework = `[${r.framework}]`;
    return `${method} ${r.route.padEnd(30, ' ')}${handler.padEnd(35, ' ')} ${loc} ${framework}`;
  });

  return lines(`routes (${routes.length} discovered):`, ...rows);
}

export function renderExplain(explained: Explanation): string {
  return lines(
    `files ${explained.index.files}, symbols ${explained.index.symbols}, edges ${explained.index.edges}`,
    `languages: ${explained.index.byLanguage.map((l) => `${l.language} ${l.files}`).join(', ')}`,
    'packages:',
    ...explained.packages.map(
      (p) => `  ${p.name}  ${p.root || '.'}  (${p.kind}, ${p.files} files)`,
    ),
    'most imported files:',
    ...explained.hubFiles.map((h) => `  ${h.importedBy}  ${h.path}`),
    'most called symbols:',
    ...explained.hubSymbols.map((h) => `  ${h.calledFrom}  ${h.id}`),
    explained.danglingImports > 0
      ? `${explained.danglingImports} imports do not resolve inside the workspace`
      : undefined,
    `(top ${explained.limit.applied}, ${explained.limit.source}${explained.limit.reached ? ', more exist' : ''})`,
  );
}

export function renderDiagnosis(d: Diagnosis): string {
  return lines(
    d.verdict,
    d.lostAt ? `lost at: ${d.lostAt}` : undefined,
    `index: ${d.indexed.status} — ${d.indexed.detail}`,
    ...d.channels.map(
      (c) =>
        `  ${c.channel}: ${c.cards} cards${c.quarantinedCards ? `, ${c.quarantinedCards} quarantined (${c.reasons.join('; ')})` : ''}`,
    ),
    ...d.ranks.map((r) => `  rank in ${r.lane}: ${r.rank ?? `below ${d.depth}`}`),
    ...d.failed.map((f) => `  ${f.lane} failed: ${f.error.message}`),
  );
}

export function renderModels(models: readonly ModelRow[]): string {
  return lines(
    ...models.map(
      (m) =>
        `${m.installed ? '*' : ' '} ${m.id}  ${m.tier ?? (m.builtin ? 'extra' : 'custom')}  ${m.dimensions}d  ${m.maxTokens} tokens  ${m.sizeMb} MB on disk, ~${m.estimatedMemoryMb} MB in memory  ${m.license}`,
    ),
    '* installed',
  );
}

export function renderDoctor(d: ModelDoctor): string {
  return lines(
    `machine: ${d.probe.platform}/${d.probe.arch}, ${d.probe.cores} cores, ${Math.round(d.probe.availableMemoryMb)} of ${Math.round(d.probe.totalMemoryMb)} MB memory available`,
    `suits: ${d.choice.spec.id} — ${d.choice.reason}`,
    'problem' in d.resolved
      ? `would use: nothing — ${d.resolved.problem}`
      : `would use: ${d.resolved.id} — ${d.resolved.reason}`,
    renderModels(d.models).trimEnd(),
  );
}

export function renderGrammars(rows: readonly GrammarRow[]): string {
  return lines(
    ...rows.map(
      (r) =>
        `${r.state === 'ready' ? '*' : ' '} ${r.language.padEnd(12)} ${r.extensions.join(' ').padEnd(24)} ${r.state}: ${r.detail}`,
    ),
    '* usable',
  );
}

export function renderMappings(mappings: readonly StoredMapping[]): string {
  return lines(
    ...mappings.map(
      (m) =>
        `${m.tier.padEnd(8)} ${m.mapping.name.padEnd(14)} ${m.languages.join(', ').padEnd(28)} ${Object.keys(m.mapping.nodeTypeMap).length} node types, ${m.mapping.structuralTags.length} structural tags  ${m.sha256}`,
    ),
  );
}

export function renderMappingChecks(checks: readonly MappingCheck[]): string {
  return lines(
    ...checks.map((c) => `${c.status.padEnd(10)} ${c.tier.padEnd(8)} ${c.name}  ${c.path}`),
    checks.length === 0 ? 'no stored mappings' : undefined,
  );
}

export function renderTraining(result: TrainedResult): string {
  const { report } = result;
  const rows = report.deductions.map(
    (d) =>
      `  ${d.role.padEnd(18)} ${d.type.padEnd(34)} -> ${d.tag.padEnd(10)} seen ${d.occurrences}${d.nameChild ? `, named by ${d.nameChild}` : ''}`,
  );
  const checks = report.verification.tags.map(
    (t) =>
      `  ${t.tag.padEnd(12)} ${t.found}/${t.expected}${t.found === t.expected ? '' : '  MISMATCH'}`,
  );
  return lines(
    `learned ${report.mapping.name} from ${result.samples} files, ${report.topology.nodes} syntax nodes`,
    'what each node type was taken to be:',
    ...rows,
    'checked against the samples (outline nodes / syntax nodes):',
    ...checks,
    `${report.verification.symbols} named symbols in the outlines`,
    ...report.issues.map((issue) => `${issue.code}: ${issue.message}`),
    result.stored
      ? `kept in ${result.stored.tier}: ${result.stored.path}\nserving ${result.stored.languages.join(', ')}; recorded ${result.stored.sha256}`
      : `not kept: ${result.refused}`,
  );
}

export function renderGoldenCheck(checked: {
  golden: Golden;
  differences: readonly GoldenDifference[];
}): string {
  return lines(
    `${checked.golden.samples.length} samples recorded for ${checked.golden.mapping}`,
    ...checked.differences.map((d) => `  ${d.path}: ${d.problem}`),
    checked.differences.length === 0
      ? 'every sample comes out as recorded'
      : `${checked.differences.length} differ`,
  );
}

export function renderAudit(audit: AuditReport): string {
  const candidateRows = audit.candidates.map((c) => {
    const details = [
      c.occurrences === 1 ? '1 occurrence' : `${c.occurrences} occurrences`,
      `role: ${c.role}`,
      c.nameChild ? `name: ${c.nameChild}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    return `    ${c.type.padEnd(30)} -> tag: ${c.deducedTag.padEnd(12)} (${details})`;
  });

  return lines(
    `mapping audit for ${audit.language} (${audit.samplesCount} files, ${audit.totalNodes} syntax nodes)`,
    `  mapped node types:   ${audit.mappedCount}`,
    `  unmapped node types: ${audit.unmappedCount}`,
    audit.candidates.length > 0
      ? [
          '',
          `  candidate node types to refine (${audit.candidates.length}):`,
          ...candidateRows,
          '',
          `  Run \`anvesa mapping refine ${audit.language}\` to apply these rules to your project.`,
        ].join('\n')
      : '  all syntax nodes are mapped or transparent.',
  );
}

export function renderRefine(result: RefineResult): string {
  if (result.addedRules.length === 0) {
    return lines(
      `no new syntax node rules discovered to refine for ${result.language}.`,
      'mapping is already aligned with sampled code.',
    );
  }
  const rules = result.addedRules.map(
    (r) =>
      `    ${r.type.padEnd(30)} -> tag: ${r.tag}${r.nameChild ? ` (name: ${r.nameChild})` : ''}`,
  );
  return lines(
    `refined mapping for ${result.language}:`,
    `  added ${result.addedRules.length} syntax node rules:`,
    ...rules,
    result.stored
      ? `  recorded in ${result.stored.tier}: ${result.stored.path}\n  Next, run: anvesa index --force`
      : '  (dry run, mapping not saved)',
  );
}

export function renderFragmentStatus(status: FragmentStatus): string {
  if (!status.enabled || !status.drift) {
    return lines(
      'sharded indexing is off (one index.db)',
      'to turn it on: anvesa fragments enable',
    );
  }
  const { drift } = status;
  return lines(
    `sharded by ${status.algorithm?.id}@${status.algorithm?.version}`,
    ...drift.shards.map(
      (s) =>
        `  ${s.id.padEnd(24)} ${s.files} files, ${s.symbols} symbols${s.quarantinedFiles ? `, ${s.quarantinedFiles} quarantined` : ''}`,
    ),
    drift.manifestChanged
      ? 'the manifest changed since the shards were last settled; the next index run moves what is out of place'
      : undefined,
    ...drift.misplacedFiles.map(
      (m) => `  misplaced: ${m.path} is in ${m.in}, belongs in ${m.belongsIn}`,
    ),
    ...drift.misplacedSources.map(
      (m) =>
        `  misplaced embedding (${m.channel}): ${m.path} is in ${m.in}, belongs in ${m.belongsIn}`,
    ),
    ...drift.orphanShards.map(
      (id) => `  orphan shard: ${id}.db belongs to no fragment of the manifest`,
    ),
    !drift.manifestChanged && drift.misplacedFiles.length === 0 && drift.orphanShards.length === 0
      ? 'every file is where the manifest says'
      : undefined,
  );
}

export function renderProposal(manifest: FragmentManifest, written: string | undefined): string {
  const rows = Object.entries(manifest.fragments)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, spec]) => {
      const parts = [
        spec.roots?.length ? `${spec.roots.length} folders (${spec.roots.join(', ')})` : undefined,
        spec.files?.length ? `${spec.files.length} files` : undefined,
      ].filter(Boolean);
      return `  ${id.padEnd(24)} ${parts.join(', ') || (id === manifest.fallback ? 'everything else' : '')}${spec.label && spec.label !== id ? `  — ${spec.label}` : ''}`;
    });
  return lines(
    `${Object.keys(manifest.fragments).length} fragments by ${manifest.algorithm.id}@${manifest.algorithm.version}; everything else goes to "${manifest.fallback}"`,
    ...rows,
    written
      ? `written to ${written}`
      : 'not written: pass --write to keep it (and commit it: every machine follows the file)',
  );
}

export function renderRedTeamRules(rules: readonly RedTeamRuleInfo[]): string {
  return lines(
    'rule                     severity  first-party  third-party  untrusted    source',
    ...rules.map(
      (r) =>
        `${r.id.padEnd(24)} ${r.severity.padEnd(9)} ${r.actions['first-party'].padEnd(12)} ${r.actions['third-party'].padEnd(12)} ${r.actions.untrusted.padEnd(12)} ${r.source}`,
    ),
  );
}

export function renderRedTeamScan(scan: RedTeamScan): string {
  return lines(
    `${scan.cards} cards from ${scan.files} files screened`,
    ...scan.byRule.map(
      (r) =>
        `  ${r.rule.padEnd(24)} ${r.flagged} flagged, ${r.sanitized} sanitized, ${r.quarantined} quarantined`,
    ),
    ...scan.quarantined.map(
      (q) => `  would quarantine ${q.path} (${q.channel}): ${q.rules.join(', ')}`,
    ),
    scan.quarantined.length === 0 ? 'nothing would be quarantined' : undefined,
  );
}

export function renderPatterns(inventory: PatternInventory): string {
  const { patterns: specs, invalid } = inventory;
  const problems = invalid.map((p) => `  invalid ${p.file}: ${p.message} [${p.code}]`);
  if (specs.length === 0 && invalid.length === 0) {
    return 'no patterns found in .anvesa/patterns/\n';
  }
  const rows = specs.map((spec) => {
    const params =
      spec.params?.map((p) => `$${p.name}${p.required ? ' (required)' : ''}`).join(', ') ?? '';
    const desc = spec.description ? `  ${spec.description}` : '';
    const corpus = spec.corpus ? ` [corpus: ${spec.corpus}]` : '';
    return `  ${spec.name.padEnd(20)} ${corpus}${params ? `  params: ${params}` : ''}${desc}`;
  });
  return lines(
    `${specs.length} pattern${specs.length === 1 ? '' : 's'}:`,
    ...rows,
    ...(problems.length > 0 ? [`${problems.length} invalid file(s):`, ...problems] : []),
  );
}

export function renderPatternResult(result: PatternRunResult): string {
  const rows = result.items.map((hit) => {
    const at = place({ path: hit.path ?? '', line: hit.startLine, endLine: hit.endLine });
    return `${hit.tag} ${hit.name ?? ''}  ${at}${hit.signature ? `  ${hit.signature}` : ''}`;
  });
  const diagRows: string[] = [];
  if (result.diagnostic) {
    diagRows.push(`\n[diagnostic] ${result.diagnostic.message}`);
    if (result.diagnostic.hint) {
      diagRows.push(`hint: ${result.diagnostic.hint}`);
    }
  }
  const total = result.total === null ? result.items.length : result.total;
  return lines(
    `pattern: ${result.pattern} -> wql: ${result.wql}`,
    ...rows,
    `${result.items.length} of ${total} matches${result.nextCursor ? ` (next cursor: ${result.nextCursor})` : ''}`,
    ...diagRows,
  );
}
