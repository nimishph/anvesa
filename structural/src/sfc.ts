import { ATTR, makeNode, type WNode } from './node.ts';

/** The outline tag for a single-file component: the `.vue` file itself, named from its filename. */
export const SFC_COMPONENT_TAG = 'component';

/**
 * Tags the engine writes onto an outline itself, rather than a mapping naming them. A query may
 * use them whatever the project's mappings declare, because the engine puts them there for every
 * file their language applies to.
 */
export function syntheticTags(): ReadonlySet<string> {
  return new Set([SFC_COMPONENT_TAG]);
}

/** `Button.vue` -> `Button`, `chart-tooltip.vue` -> `ChartTooltip`; anything not a Vue file is `undefined`. */
function componentName(path: string): string | undefined {
  const file = path.split(/[/\\]/).pop() ?? '';
  if (!/\.vue$/i.test(file)) return undefined;
  const stem = file.slice(0, file.lastIndexOf('.'));
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return name.length > 0 ? name : undefined;
}

/** The 1-based line holding character offset `offset`. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let index = 0; index < end; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly endLine: number;
}

/** Where a component's code is: its `<script>` block, or the whole file when it has none. */
function spanOf(source: string): Span {
  const open = source.search(/<script[\s>]/i);
  if (open === -1) {
    return { start: 0, end: source.length, line: 1, endLine: lineAt(source, source.length) };
  }
  const close = source.indexOf('</script>', open);
  const end = close === -1 ? source.length : close + '</script>'.length;
  return { start: open, end, line: lineAt(source, open), endLine: lineAt(source, end) };
}

/**
 * The component itself on a Vue outline, first among the root's children.
 *
 * `<script setup>` declares nothing by name: the component is the file, and props, emits and
 * options are compiler macros. Without this the file's symbols are only whatever happens to be
 * declared inside it, so a component nobody exported under its own name cannot be found at all.
 *
 * The node carries offsets whether or not the outline asked for positions, because symbol facts
 * place themselves with them. Returns the outline to use (a new root, with the component first),
 * or `undefined` when there is nothing to add: no path to name it by, not a single-file component,
 * or a component that is already there.
 */
export function attachSfcComponent(
  language: string,
  path: string | undefined,
  source: string,
  root: WNode,
): WNode | undefined {
  if (language !== 'vue' || path === undefined) return undefined;
  if (root.children.some((child) => child.tag === SFC_COMPONENT_TAG)) return undefined;
  const name = componentName(path);
  if (name === undefined) return undefined;
  const span = spanOf(source);
  const component = makeNode(SFC_COMPONENT_TAG, {
    [ATTR.name]: name,
    [ATTR.baseName]: name,
    [ATTR.kind]: 'sfc_component',
    [ATTR.declaration]: 'true',
    [ATTR.line]: String(span.line),
    [ATTR.endLine]: String(span.endLine),
    [ATTR.startIndex]: String(span.start),
    [ATTR.endIndex]: String(span.end),
  });
  return makeNode(root.tag, root.attrs, [component, ...root.children]);
}
