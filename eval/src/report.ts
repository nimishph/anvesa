import type { CallScore, ImportScore, Ratio, SymbolScore } from './compare.ts';
import type { IndexRun } from './indexing.ts';

const percent = (ratio: Ratio): string =>
  ratio.value === undefined ? 'n/a' : `${(ratio.value * 100).toFixed(1)}%`;
const counted = (ratio: Ratio): string => `${ratio.hits}/${ratio.total}`;
const both = (ratio: Ratio): string => `${percent(ratio).padStart(6)}  (${counted(ratio)})`;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

function section(title: string): string {
  return `\n${title}\n${'-'.repeat(title.length)}`;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function sorted(map: ReadonlyMap<string, number>): [string, number][] {
  return [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export interface ReportInput {
  readonly repository: string;
  readonly revision: string;
  readonly run: IndexRun;
  readonly truthMs: number;
  readonly truthFiles: number;
  readonly symbols: SymbolScore;
  readonly imports: ImportScore;
  readonly calls: CallScore;
  readonly samples: number;
}

/** The evaluation as text a person can read. */
export function renderReport(input: ReportInput): string {
  const { run, symbols, imports, calls, samples } = input;
  const lines: string[] = [];
  lines.push(`code-lens evaluation: ${input.repository} @ ${input.revision}`);

  lines.push(section('Indexing'));
  const totalMs = run.timings.walkAndExtractMs + run.timings.linkMs;
  lines.push(
    table([
      ['files indexed', String(run.files.indexed)],
      ['files quarantined', String(run.files.quarantined.length)],
      ['files with syntax errors (facts still extracted)', String(run.files.withSyntaxErrors)],
      ['source bytes', mb(run.files.bytes)],
      ['walk + parse + extract + store', seconds(run.timings.walkAndExtractMs)],
      ['link (imports and calls)', seconds(run.timings.linkMs)],
      [
        'throughput',
        `${(run.files.indexed / (totalMs / 1000)).toFixed(0)} files/s, ${(run.files.bytes / 1024 / 1024 / (totalMs / 1000)).toFixed(1)} MB/s`,
      ],
      ['peak resident memory', mb(run.peakRss)],
      ['workspace packages found', String(run.workspace.packages().length)],
      [
        'compiler ground truth (for reference)',
        `${seconds(input.truthMs)} over ${input.truthFiles} files`,
      ],
    ]),
  );
  if (run.files.skippedLanguages.size > 0) {
    lines.push(
      `not indexed (other languages): ${sorted(run.files.skippedLanguages)
        .map(([language, count]) => `${language} ${count}`)
        .join(', ')}`,
    );
  }
  for (const item of run.files.quarantined.slice(0, samples)) {
    lines.push(`  quarantined: ${item.path} (${item.reason}) ${item.message}`);
  }

  lines.push(section('Symbols (declarations, against the compiler)'));
  lines.push(
    table([
      ['', 'precision', 'recall'],
      ['all', both(symbols.precision), both(symbols.recall)],
      ...Object.entries(symbols.byGroup).map(([group, score]) => [
        group,
        both(score.precision),
        both(score.recall),
      ]),
    ]),
  );
  if (symbols.notComparable.size > 0) {
    lines.push(
      `reported with no counterpart: ${sorted(symbols.notComparable)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(', ')}`,
    );
  }
  lines.push(...examples('missed by code-lens', symbols.missed, samples));
  lines.push(
    ...examples('reported by code-lens, not a declaration to the compiler', symbols.extra, samples),
  );

  lines.push(section('Imports (resolved to the same place the compiler resolves them)'));
  lines.push(
    table([
      ['import sites the compiler sees, also extracted', both(imports.extracted)],
      ['of those, resolved to the same file / same class', both(imports.agreement)],
    ]),
  );
  lines.push('compiler > code-lens');
  lines.push(table(sorted(imports.confusion).map(([pair, count]) => [`  ${pair}`, String(count)])));
  lines.push(...examples('disagreements', imports.disagreements, samples));
  lines.push(...examples('not extracted', imports.notExtracted, samples));

  lines.push(section('Calls (linked to the symbol the compiler says is called)'));
  lines.push(
    table([
      ['call sites the compiler sees, also extracted', both(calls.extracted)],
      ['judged (compiler names a symbol code-lens extracts)', String(calls.judged)],
      ['recall, resolved by scope and imports', both(calls.recallResolved)],
      ['recall, also counting name guesses', both(calls.recallWithGuesses)],
      ['precision of resolved links', both(calls.precisionResolved)],
      ['name guesses containing the right symbol', both(calls.guessPrecision)],
      [
        'mean candidates per guess',
        calls.meanGuessCandidates === undefined ? 'n/a' : calls.meanGuessCandidates.toFixed(1),
      ],
      ['external calls also called external', both(calls.externalAgreement)],
      ['caller->callee edges: precision', both(calls.edgePrecision)],
      ['caller->callee edges: recall', both(calls.edgeRecall)],
      ['caller->callee edges: recall with guesses', both(calls.edgeRecallWithGuesses)],
    ]),
  );
  lines.push('by call form');
  lines.push(
    table([
      ['', 'recall (resolved)', 'precision (resolved)'],
      [
        'bare  f()',
        both(calls.byForm.bare.recallResolved),
        both(calls.byForm.bare.precisionResolved),
      ],
      [
        'member  a.f()',
        both(calls.byForm.member.recallResolved),
        both(calls.byForm.member.precisionResolved),
      ],
    ]),
  );
  lines.push('what the compiler says the calls are');
  lines.push(table(sorted(calls.truthKinds).map(([kind, count]) => [`  ${kind}`, String(count)])));
  lines.push('what code-lens did');
  lines.push(
    table(sorted(calls.outcomes).map(([outcome, count]) => [`  ${outcome}`, String(count)])),
  );
  for (const [category, list] of [...calls.samples].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(...examples(category, list, samples));
  }

  lines.push(section('Graph accounting (the linker’s own view)'));
  lines.push(
    table([
      [
        'imports',
        `resolved ${run.link.imports.resolved}, asset ${run.link.imports.asset}, external ${run.link.imports.external}, dangling ${run.link.imports.dangling}`,
      ],
      [
        'calls',
        `resolved ${run.link.calls.resolved}, by name ${run.link.calls.byName}, external ${run.link.calls.external}, unresolved ${run.link.calls.unresolved}`,
      ],
      ['edges written', String(run.link.edges)],
    ]),
  );
  return `${lines.join('\n')}\n`;
}

function examples(title: string, list: readonly string[], limit: number): string[] {
  if (list.length === 0) return [];
  return [
    `\n${title} (${list.length}${list.length > limit ? `, first ${limit}` : ''})`,
    ...list.slice(0, limit).map((item) => `  ${item}`),
  ];
}

/** JSON for the same result, with maps as objects and no examples beyond `samples`. */
export function reportJson(input: ReportInput): unknown {
  const { run, symbols, imports, calls, samples } = input;
  const object = (map: ReadonlyMap<string, number>) => Object.fromEntries(sorted(map));
  return {
    repository: input.repository,
    revision: input.revision,
    indexing: {
      files: run.files.indexed,
      quarantined: run.files.quarantined.length,
      withSyntaxErrors: run.files.withSyntaxErrors,
      bytes: run.files.bytes,
      walkAndExtractMs: run.timings.walkAndExtractMs,
      linkMs: run.timings.linkMs,
      peakRss: run.peakRss,
      packages: run.workspace.packages().map((pkg) => pkg.name),
    },
    symbols: {
      precision: symbols.precision,
      recall: symbols.recall,
      byGroup: symbols.byGroup,
      notComparable: object(symbols.notComparable),
      missed: symbols.missed.slice(0, samples),
      extra: symbols.extra.slice(0, samples),
    },
    imports: {
      extracted: imports.extracted,
      agreement: imports.agreement,
      confusion: object(imports.confusion),
      disagreements: imports.disagreements.slice(0, samples),
    },
    calls: {
      extracted: calls.extracted,
      judged: calls.judged,
      recallResolved: calls.recallResolved,
      recallWithGuesses: calls.recallWithGuesses,
      precisionResolved: calls.precisionResolved,
      guessPrecision: calls.guessPrecision,
      meanGuessCandidates: calls.meanGuessCandidates,
      externalAgreement: calls.externalAgreement,
      byForm: calls.byForm,
      edgePrecision: calls.edgePrecision,
      edgeRecall: calls.edgeRecall,
      edgeRecallWithGuesses: calls.edgeRecallWithGuesses,
      truthKinds: object(calls.truthKinds),
      outcomes: object(calls.outcomes),
      samples: Object.fromEntries(calls.samples),
    },
    link: run.link,
  };
}
