import {
  type Deadline,
  InvalidArgumentError,
  type Page,
  resolveLimit,
} from '@cntxt-labs/anvesa-core';
import { toHit, type WqlHit } from './hits.ts';
import { ATTR, type WNode, walk } from './node.ts';
import {
  isCallableTag,
  type MatchContext,
  nodeMatchesStep,
  parseWql,
  type WqlQuery,
  type WqlStep,
} from './wql.ts';

/** A file whose W-expression tree the index holds. */
export interface IndexedFile {
  readonly path: string;
  readonly root: WNode;
  readonly language?: string;
}

export interface IndexQueryOptions {
  /** Page size. Defaults to core's `DEFAULT_RESULT_LIMIT`. */
  readonly limit?: number;
  /** From a previous result's `nextCursor`. Valid only while the index is unchanged. */
  readonly cursor?: string;
  readonly deadline?: Deadline;
  /** Restrict the search to matching paths, e.g. one package of a monorepo. */
  readonly include?: (path: string) => boolean;
}

export interface IndexQueryResult extends Page<WqlHit> {
  /** Files whose nodes were actually examined. Fewer than `fileCount` when postings pruned some. */
  readonly filesExamined: number;
}

interface Entry {
  readonly node: WNode;
  readonly parent: Entry | undefined;
}

interface FileIndex {
  readonly file: IndexedFile;
  readonly entries: readonly Entry[];
  readonly byTag: ReadonlyMap<string, readonly Entry[]>;
  /** Every dotted suffix of a qualified name -> the entries it names, in document order. */
  readonly byName: ReadonlyMap<string, readonly Entry[]>;
}

/**
 * Many files' W-expression trees, searchable by WQL without walking every file.
 *
 * Each file keeps postings by tag and by name. A query is answered from the most selective
 * postings for its *last* step and the earlier steps are checked by climbing parents, so a
 * lookup like `//method[@name="parse"]` touches only the nodes named `parse`. Results come in a
 * fixed order (path, then document order), so pages are stable and reproducible.
 */
export class StructuralIndex {
  readonly #files = new Map<string, FileIndex>();
  readonly #filesByTag = new Map<string, Set<string>>();
  #sortedPaths: readonly string[] | undefined;
  #version = 0;

  get fileCount(): number {
    return this.#files.size;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  get(path: string): IndexedFile | undefined {
    return this.#files.get(path)?.file;
  }

  paths(): readonly string[] {
    return this.#sorted();
  }

  /** Add a file, or replace the one already indexed under the same path. */
  set(file: IndexedFile): void {
    this.delete(file.path);
    const index = buildFileIndex(file);
    this.#files.set(file.path, index);
    for (const tag of index.byTag.keys()) {
      const paths = this.#filesByTag.get(tag) ?? new Set<string>();
      paths.add(file.path);
      this.#filesByTag.set(tag, paths);
    }
    this.#changed();
  }

  delete(path: string): boolean {
    const existing = this.#files.get(path);
    if (!existing) return false;
    this.#files.delete(path);
    for (const tag of existing.byTag.keys()) {
      const paths = this.#filesByTag.get(tag);
      paths?.delete(path);
      if (paths?.size === 0) this.#filesByTag.delete(tag);
    }
    this.#changed();
    return true;
  }

  query(input: string | WqlQuery, options: IndexQueryOptions = {}): IndexQueryResult {
    const query = typeof input === 'string' ? parseWql(input) : input;
    const last = query.steps[query.steps.length - 1] as WqlStep;
    const { value: limit, source } = resolveLimit('limit', options.limit);
    const offset = options.cursor === undefined ? 0 : this.#decodeCursor(options.cursor);
    const wanted = offset + limit + 1; // one extra tells us whether another page exists

    const hits: WqlHit[] = [];
    let filesExamined = 0;
    search: for (const path of this.#pathsFor(last)) {
      options.deadline?.throwIfExpired('query the structural index');
      if (options.include && !options.include(path)) continue;
      const index = this.#files.get(path) as FileIndex;
      filesExamined += 1;
      const matches = chainMatcher(query.steps, { path });
      for (const entry of candidates(index, last)) {
        if (!matches(entry)) continue;
        hits.push(toHit(path, entry.node));
        if (hits.length >= wanted) break search;
      }
    }

    const more = hits.length > offset + limit;
    return {
      items: hits.slice(offset, offset + limit),
      total: more ? null : hits.length,
      nextCursor: more ? this.#encodeCursor(offset + limit) : null,
      limit: { name: 'limit', applied: limit, source, reached: more },
      filesExamined,
    };
  }

  #sorted(): readonly string[] {
    this.#sortedPaths ??= [...this.#files.keys()].sort();
    return this.#sortedPaths;
  }

  /** Files worth examining for a query, in path order. */
  #pathsFor(last: WqlStep): readonly string[] {
    if (last.tag === '*') return this.#sorted();
    const holding = this.#filesByTag.get(last.tag);
    if (!holding) return [];
    return this.#sorted().filter((path) => holding.has(path));
  }

  #changed(): void {
    this.#version += 1;
    this.#sortedPaths = undefined;
  }

  #encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ v: 1, offset, index: this.#version })).toString(
      'base64url',
    );
  }

  #decodeCursor(cursor: string): number {
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch (parseFailure) {
      throw new InvalidArgumentError('cursor', 'a cursor from a previous query', cursor, {
        cause: parseFailure,
      });
    }
    const candidate = payload as { v?: unknown; offset?: unknown; index?: unknown } | null;
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      candidate.v !== 1 ||
      typeof candidate.offset !== 'number' ||
      !Number.isSafeInteger(candidate.offset) ||
      candidate.offset < 0
    ) {
      throw new InvalidArgumentError('cursor', 'a cursor from a previous query', cursor);
    }
    if (candidate.index !== this.#version) {
      throw new InvalidArgumentError('cursor', 'a cursor from the current index state', cursor, {
        hint: 'The index changed since this cursor was issued. Run the query again from the start.',
        context: { issuedAtVersion: candidate.index, currentVersion: this.#version },
      });
    }
    return candidate.offset;
  }
}

function buildFileIndex(file: IndexedFile): FileIndex {
  const entries: Entry[] = [];
  const byTag = new Map<string, Entry[]>();
  const byName = new Map<string, Entry[]>();
  const entryOf = new Map<WNode, Entry>();

  for (const { node, parent } of walk(file.root)) {
    const entry: Entry = { node, parent: parent ? entryOf.get(parent) : undefined };
    entryOf.set(node, entry);
    entries.push(entry);
    push(byTag, node.tag, entry);
    if (isCallableTag(node.tag) || node.attrs.get(ATTR.callable) === 'true') {
      push(byTag, 'callable', entry);
      push(byTag, 'fn', entry);
    }
    if (node.attrs.get(ATTR.isMethod) === 'true' && node.tag !== 'method') {
      push(byTag, 'method', entry);
    }
    const name = node.attrs.get(ATTR.name);
    if (name !== undefined) {
      push(byName, name, entry);
      for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
        push(byName, name.slice(dot + 1), entry);
      }
    }
  }
  return { file, entries, byTag, byName };
}

function push(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

/** The smallest list of entries that can contain every match of the last step. */
function candidates(index: FileIndex, last: WqlStep): readonly Entry[] {
  let best: readonly Entry[] | undefined;
  const exactName = last.predicates.find((p) => p.attr === ATTR.name && p.op === 'eq');
  if (exactName && exactName.value !== undefined) best = index.byName.get(exactName.value) ?? [];
  if (last.tag !== '*') {
    const tagged = index.byTag.get(last.tag) ?? [];
    if (!best || tagged.length < best.length) best = tagged;
  }
  return best ?? index.entries;
}

/**
 * Answers "does this entry satisfy the whole query, climbing parents?" for one file, remembering
 * every sub-answer so no (entry, step) pair is worked out twice.
 *
 * A `child` relation needs the direct parent to satisfy the previous step; `descendant` needs
 * some ancestor to. "Some ancestor" is computed with a loop and cached along the way, so a very
 * deep chain is neither recursed into nor re-walked.
 */
function chainMatcher(steps: readonly WqlStep[], context: MatchContext): (entry: Entry) => boolean {
  const chainMemo = new Map<Entry, (boolean | undefined)[]>();
  const upMemo = new Map<Entry, (boolean | undefined)[]>();
  const recall = (memo: Map<Entry, (boolean | undefined)[]>, entry: Entry, step: number) =>
    memo.get(entry)?.[step];
  const remember = (
    memo: Map<Entry, (boolean | undefined)[]>,
    entry: Entry,
    step: number,
    answer: boolean,
  ): boolean => {
    const row = memo.get(entry) ?? [];
    row[step] = answer;
    memo.set(entry, row);
    return answer;
  };

  /** Does `entry` satisfy steps 0..at, with step `at` being this very node? */
  const chain = (entry: Entry, at: number): boolean => {
    const known = recall(chainMemo, entry, at);
    if (known !== undefined) return known;
    const step = steps[at] as WqlStep;
    let ok = nodeMatchesStep(step, entry.node, context);
    if (ok && at === 0) {
      ok = step.relation === 'descendant' || entry.parent === undefined;
    } else if (ok && entry.parent === undefined) {
      ok = false;
    } else if (ok) {
      const parent = entry.parent as Entry;
      ok = step.relation === 'child' ? chain(parent, at - 1) : up(parent, at - 1);
    }
    return remember(chainMemo, entry, at, ok);
  };

  /** Does `entry` or any ancestor of it satisfy steps 0..at? */
  const up = (entry: Entry, at: number): boolean => {
    const trail: Entry[] = [];
    let answer = false;
    for (let current: Entry | undefined = entry; current; current = current.parent) {
      const known = recall(upMemo, current, at);
      if (known !== undefined) {
        answer = known;
        break;
      }
      trail.push(current);
      if (chain(current, at)) {
        answer = true;
        break;
      }
    }
    for (const visited of trail) remember(upMemo, visited, at, answer);
    return answer;
  };

  return (entry) => chain(entry, steps.length - 1);
}
