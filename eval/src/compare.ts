import type {
  CallFact,
  CallResolution,
  ImportFact,
  Resolution,
  SymbolFact,
} from '@cntxt-labs/anvesa-indexer';
import type {
  CallTarget,
  ImportTarget,
  SymbolGroup,
  TruthCall,
  TruthImport,
  TruthSymbol,
} from './truth.ts';

/** A count out of a total. `value` is `undefined` when there is nothing to measure. */
export interface Ratio {
  readonly hits: number;
  readonly total: number;
  readonly value: number | undefined;
}

export function ratio(hits: number, total: number): Ratio {
  return { hits, total, value: total === 0 ? undefined : hits / total };
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

// --- symbols --------------------------------------------------------------------------------------

export interface SymbolScore {
  readonly precision: Ratio;
  readonly recall: Ratio;
  readonly byGroup: Readonly<Record<string, { precision: Ratio; recall: Ratio }>>;
  /** Symbols the compiler sees and medha does not. */
  readonly missed: readonly string[];
  /** Symbols medha reports that the compiler does not see as declarations of that kind. */
  readonly extra: readonly string[];
  /** Kinds medha reports that have no counterpart to compare against, by count. */
  readonly notComparable: ReadonlyMap<string, number>;
}

const GROUP_OF_KIND: Readonly<Record<string, SymbolGroup>> = {
  function: 'callable',
  method: 'callable',
  class: 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  namespace: 'namespace',
  module: 'namespace',
};

/** Compare declared symbols as multisets of (file, name, kind group), so repeats count. */
export function scoreSymbols(
  truth: readonly TruthSymbol[],
  ours: ReadonlyMap<string, readonly SymbolFact[]>,
): SymbolScore {
  const key = (path: string, name: string, group: string) => `${path}\u0000${name}\u0000${group}`;
  const truthCount = new Map<string, number>();
  for (const symbol of truth) bump(truthCount, key(symbol.path, symbol.baseName, symbol.group));

  const oursCount = new Map<string, number>();
  const notComparable = new Map<string, number>();
  for (const [path, symbols] of ours) {
    for (const symbol of symbols) {
      const group = GROUP_OF_KIND[symbol.kind];
      if (group === undefined) bump(notComparable, symbol.kind);
      else bump(oursCount, key(path, symbol.baseName, group));
    }
  }

  const tallies = new Map<string, { matched: number; truth: number; ours: number }>();
  const missed: string[] = [];
  const extra: string[] = [];
  const tally = (group: string) => {
    let entry = tallies.get(group);
    if (!entry) {
      entry = { matched: 0, truth: 0, ours: 0 };
      tallies.set(group, entry);
    }
    return entry;
  };

  for (const [id, count] of truthCount) {
    const [path, name, group] = id.split('\u0000') as [string, string, string];
    const other = oursCount.get(id) ?? 0;
    const entry = tally(group);
    entry.truth += count;
    entry.matched += Math.min(count, other);
    if (other < count)
      missed.push(`${path}  ${group} ${name}${count - other > 1 ? ` x${count - other}` : ''}`);
  }
  for (const [id, count] of oursCount) {
    const [path, name, group] = id.split('\u0000') as [string, string, string];
    const other = truthCount.get(id) ?? 0;
    tally(group).ours += count;
    if (other < count)
      extra.push(`${path}  ${group} ${name}${count - other > 1 ? ` x${count - other}` : ''}`);
  }

  let matched = 0;
  let truthTotal = 0;
  let oursTotal = 0;
  const byGroup: Record<string, { precision: Ratio; recall: Ratio }> = {};
  for (const [group, entry] of [...tallies].sort(([a], [b]) => (a < b ? -1 : 1))) {
    matched += entry.matched;
    truthTotal += entry.truth;
    oursTotal += entry.ours;
    byGroup[group] = {
      precision: ratio(entry.matched, entry.ours),
      recall: ratio(entry.matched, entry.truth),
    };
  }
  return {
    precision: ratio(matched, oursTotal),
    recall: ratio(matched, truthTotal),
    byGroup,
    missed: missed.sort(),
    extra: extra.sort(),
    notComparable,
  };
}

// --- imports --------------------------------------------------------------------------------------

export interface OursImport {
  readonly fact: ImportFact;
  readonly resolution: Resolution;
}

export interface ImportScore {
  /** Import sites the compiler sees that medha also extracted. */
  readonly extracted: Ratio;
  /** Of the extracted sites, how many landed in the same place as the compiler's answer. */
  readonly agreement: Ratio;
  /** `truth>ours` -> count, over extracted sites. */
  readonly confusion: ReadonlyMap<string, number>;
  readonly disagreements: readonly string[];
  readonly notExtracted: readonly string[];
}

const truthClass = (target: ImportTarget) => (target.kind === 'file' ? `file` : target.kind);
const oursClass = (resolution: Resolution) =>
  resolution.kind === 'file' ? 'file' : resolution.kind === 'dangling' ? 'unresolved' : 'external';

export function scoreImports(
  truth: readonly TruthImport[],
  ours: ReadonlyMap<string, readonly OursImport[]>,
): ImportScore {
  const oursByKey = new Map<string, OursImport[]>();
  for (const [path, list] of ours) {
    for (const entry of list) {
      const key = `${path}\u0000${entry.fact.specifier}`;
      const bucket = oursByKey.get(key);
      if (bucket) bucket.push(entry);
      else oursByKey.set(key, [entry]);
    }
  }
  const seen = new Map<string, number>();
  const confusion = new Map<string, number>();
  const disagreements: string[] = [];
  const notExtracted: string[] = [];
  let extracted = 0;
  let agreed = 0;

  for (const site of truth) {
    const key = `${site.path}\u0000${site.specifier}`;
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const match = oursByKey.get(key)?.[index];
    if (!match) {
      notExtracted.push(`${site.path}:${site.line}  ${site.specifier}`);
      continue;
    }
    extracted += 1;
    const t = truthClass(site.target);
    const o = oursClass(match.resolution);
    bump(confusion, `${t}>${o}`);
    const same =
      t === o &&
      (site.target.kind !== 'file' ||
        (match.resolution.kind === 'file' && match.resolution.path === site.target.path));
    if (same) agreed += 1;
    else {
      const wanted = site.target.kind === 'file' ? site.target.path : site.target.kind;
      const got = match.resolution.kind === 'file' ? match.resolution.path : match.resolution.kind;
      disagreements.push(
        `${site.path}:${site.line}  ${site.specifier}  compiler: ${wanted}  medha: ${got}`,
      );
    }
  }
  return {
    extracted: ratio(extracted, truth.length),
    agreement: ratio(agreed, extracted),
    confusion,
    disagreements,
    notExtracted,
  };
}

// --- calls ----------------------------------------------------------------------------------------

export interface ObservedCall {
  readonly call: CallFact;
  readonly resolution: CallResolution;
}

export interface CallScore {
  readonly truthCalls: number;
  /** Call sites the compiler sees that medha also extracted. */
  readonly extracted: Ratio;
  readonly truthKinds: ReadonlyMap<string, number>;
  /** Calls the compiler resolved to a symbol anvesa extracted: what resolution is judged on. */
  readonly judged: number;
  readonly outcomes: ReadonlyMap<string, number>;
  /** Right symbol found by scope and imports, of the judged calls. */
  readonly recallResolved: Ratio;
  /** Right symbol found by scope and imports, or named among the guesses. */
  readonly recallWithGuesses: Ratio;
  /** Of the calls linked to a symbol, how many were linked to the right one. */
  readonly precisionResolved: Ratio;
  /** Of the guesses, how many contain the right symbol. */
  readonly guessPrecision: Ratio;
  readonly meanGuessCandidates: number | undefined;
  /** External calls (the compiler says declared outside the repo) that medha also called external. */
  readonly externalAgreement: Ratio;
  readonly byForm: Readonly<
    Record<'bare' | 'member', { recallResolved: Ratio; precisionResolved: Ratio }>
  >;
  /** Caller -> callee links, as `callers` and `callees` would report them. */
  readonly edgePrecision: Ratio;
  readonly edgeRecall: Ratio;
  readonly edgeRecallWithGuesses: Ratio;
  readonly samples: ReadonlyMap<string, readonly string[]>;
}

/** Find our symbol for a declaration the compiler named. */
function symbolFor(
  target: Extract<CallTarget, { kind: 'symbol' }>,
  symbols: ReadonlyMap<string, readonly SymbolFact[]>,
): SymbolFact | undefined {
  let best: SymbolFact | undefined;
  for (const symbol of symbols.get(target.path) ?? []) {
    if (symbol.baseName !== target.name) continue;
    if (target.line < symbol.startLine || target.line > symbol.endLine) continue;
    if (best === undefined || symbol.startLine >= best.startLine) best = symbol;
  }
  return best;
}

export function scoreCalls(
  truth: readonly TruthCall[],
  ours: ReadonlyMap<string, readonly ObservedCall[]>,
  symbols: ReadonlyMap<string, readonly SymbolFact[]>,
  options: { readonly samplesPerCategory: number },
): CallScore {
  const oursByKey = new Map<string, ObservedCall[]>();
  for (const [path, list] of ours) {
    for (const entry of list) {
      const key = `${path}\u0000${entry.call.line}\u0000${entry.call.name}`;
      const bucket = oursByKey.get(key);
      if (bucket) bucket.push(entry);
      else oursByKey.set(key, [entry]);
    }
  }

  const seen = new Map<string, number>();
  const truthKinds = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const samples = new Map<string, string[]>();
  const sample = (category: string, text: string) => {
    const list = samples.get(category) ?? [];
    if (list.length < options.samplesPerCategory) list.push(text);
    samples.set(category, list);
  };

  const forms = {
    bare: { judged: 0, correct: 0, linked: 0 },
    member: { judged: 0, correct: 0, linked: 0 },
  };
  let extracted = 0;
  let judged = 0;
  let correct = 0;
  let guessHit = 0;
  let guessTotal = 0;
  let candidateSum = 0;
  let linked = 0; // calls linked to a symbol where the compiler gave a verdict
  let linkedRight = 0;
  let externalTotal = 0;
  let externalAgreed = 0;
  const truthEdges = new Set<string>();
  const resolvedEdges = new Set<string>();
  const guessedEdges = new Set<string>();
  const oursEdgesJudged = new Set<string>();

  for (const site of truth) {
    bump(truthKinds, site.target.kind);
    const key = `${site.path}\u0000${site.line}\u0000${site.name}`;
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const match = oursByKey.get(key)?.[index];
    if (!match) {
      bump(outcomes, 'not extracted');
      sample('not extracted', `${site.path}:${site.line}  ${site.name}`);
      continue;
    }
    extracted += 1;
    const { resolution } = match;
    const from = match.call.from ?? site.path;
    const where = `${site.path}:${site.line}  ${site.member ? '.' : ''}${site.name}`;
    const target = site.target;

    if (target.kind === 'unknown') {
      bump(outcomes, 'compiler could not tell');
      continue;
    }

    if (target.kind === 'external') {
      externalTotal += 1;
      if (resolution.kind === 'external') {
        externalAgreed += 1;
        bump(outcomes, 'external: agreed');
      } else if (resolution.kind === 'unresolved') {
        bump(outcomes, 'external: left unresolved');
      } else {
        bump(outcomes, `external: linked to a symbol (${resolution.kind})`);
        sample('external: linked to a symbol', `${where}  -> ${resolution.ids.join(', ')}`);
        if (resolution.kind === 'symbol') {
          linked += 1;
          for (const id of resolution.ids) oursEdgesJudged.add(`${from}\u0000${id}`);
        }
      }
      continue;
    }

    if (target.kind === 'untracked') {
      bump(outcomes, `untracked (${resolution.kind})`);
      if (resolution.kind === 'symbol') {
        linked += 1;
        for (const id of resolution.ids) oursEdgesJudged.add(`${from}\u0000${id}`);
        sample(
          'untracked: linked to a symbol',
          `${where}  compiler: ${target.why}  -> ${resolution.ids.join(', ')}`,
        );
      }
      continue;
    }

    const expected = symbolFor(target, symbols);
    if (!expected) {
      bump(outcomes, 'target symbol not extracted');
      sample(
        'target symbol not extracted',
        `${where}  -> ${target.path}:${target.line} ${target.name}`,
      );
      continue;
    }

    judged += 1;
    const form = site.member ? forms.member : forms.bare;
    form.judged += 1;
    truthEdges.add(`${from}\u0000${expected.id}`);

    if (resolution.kind === 'symbol') {
      linked += 1;
      form.linked += 1;
      for (const id of resolution.ids) {
        oursEdgesJudged.add(`${from}\u0000${id}`);
        resolvedEdges.add(`${from}\u0000${id}`);
      }
      if (resolution.ids.includes(expected.id)) {
        correct += 1;
        linkedRight += 1;
        form.correct += 1;
        bump(outcomes, 'resolved: correct');
      } else {
        bump(outcomes, 'resolved: wrong symbol');
        sample(
          'resolved: wrong symbol',
          `${where}  expected ${expected.id}  got ${resolution.ids.join(', ')}`,
        );
      }
    } else if (resolution.kind === 'byName') {
      guessTotal += 1;
      candidateSum += resolution.ids.length;
      for (const id of resolution.ids) guessedEdges.add(`${from}\u0000${id}`);
      if (resolution.ids.includes(expected.id)) {
        guessHit += 1;
        bump(outcomes, 'guess: contains the right symbol');
      } else {
        bump(outcomes, 'guess: wrong');
        sample('guess: wrong', `${where}  expected ${expected.id}  among ${resolution.ids.length}`);
      }
    } else if (resolution.kind === 'external') {
      bump(outcomes, 'wrongly external');
      sample('wrongly external', `${where}  expected ${expected.id}  got ${resolution.to}`);
    } else {
      bump(outcomes, `unresolved: ${resolution.reason}`);
      sample(`unresolved: ${resolution.reason}`, `${where}  expected ${expected.id}`);
    }
  }

  let edgesRight = 0;
  for (const edge of oursEdgesJudged) if (truthEdges.has(edge)) edgesRight += 1;
  let edgesFound = 0;
  let edgesFoundWithGuesses = 0;
  for (const edge of truthEdges) {
    if (resolvedEdges.has(edge)) edgesFound += 1;
    if (resolvedEdges.has(edge) || guessedEdges.has(edge)) edgesFoundWithGuesses += 1;
  }

  return {
    truthCalls: truth.length,
    extracted: ratio(extracted, truth.length),
    truthKinds,
    judged,
    outcomes,
    recallResolved: ratio(correct, judged),
    recallWithGuesses: ratio(correct + guessHit, judged),
    precisionResolved: ratio(linkedRight, linked),
    guessPrecision: ratio(guessHit, guessTotal),
    meanGuessCandidates: guessTotal === 0 ? undefined : candidateSum / guessTotal,
    externalAgreement: ratio(externalAgreed, externalTotal),
    byForm: {
      bare: {
        recallResolved: ratio(forms.bare.correct, forms.bare.judged),
        precisionResolved: ratio(forms.bare.correct, forms.bare.linked),
      },
      member: {
        recallResolved: ratio(forms.member.correct, forms.member.judged),
        precisionResolved: ratio(forms.member.correct, forms.member.linked),
      },
    },
    edgePrecision: ratio(edgesRight, oursEdgesJudged.size),
    edgeRecall: ratio(edgesFound, truthEdges.size),
    edgeRecallWithGuesses: ratio(edgesFoundWithGuesses, truthEdges.size),
    samples,
  };
}
