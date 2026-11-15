/**
 * ANVESA UI — the status panel every view shows when it has no answer to draw.
 *
 * The dashboard never shows sample data in place of an answer: it says which state it is in and
 * what to do about it. The states match the server's `state` field (ui/src/server.ts), plus
 * `unreachable` for when the server itself did not answer.
 */

const STATES = {
  'not-indexed': {
    title: 'This project is not indexed yet',
    action: 'Run anvesa index in the project, then reload this page.',
  },
  unavailable: {
    title: 'No index is open for this project',
    action: 'Fix what the message below names, then restart anvesa ui.',
  },
  unreachable: {
    title: 'The anvesa ui server is not answering',
    action: 'Start anvesa ui again in the project, then reload this page.',
  },
  'no-encoder': {
    title: 'No encoder is installed for plain-language search',
    action: 'Pick one with anvesa model use. WQL queries still run without one.',
  },
  invalid: { title: 'Nothing to look up yet', action: '' },
  empty: { title: 'Nothing found', action: '' },
  error: { title: 'The index could not answer', action: '' },
};

function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The state of a server answer that carries no result, or `undefined` when it has one. */
export function stateOf(resp) {
  if (resp?.success) return undefined;
  return { state: resp?.state ?? 'error', error: resp?.error ?? resp?.message ?? '' };
}

/** The state when the request itself failed: the server did not answer. */
export function unreachable(err) {
  return { state: 'unreachable', error: err instanceof Error ? err.message : String(err) };
}

/** The panel's markup. `title` replaces the state's own heading (an empty search, say). */
export function statePanelHtml({ state, error }, title) {
  const known = STATES[state] ?? STATES.error;
  return `
    <div class="state-container" role="status" data-state="${escapeText(state)}">
      <div class="state-title">${escapeText(title ?? known.title)}</div>
      ${error ? `<div class="state-desc">${escapeText(error)}</div>` : ''}
      ${known.action ? `<div class="state-desc state-action">${escapeText(known.action)}</div>` : ''}
    </div>
  `;
}

/** Draw the panel into `element` (replacing what was there). */
export function showStatePanel(element, panel, title) {
  if (element) element.innerHTML = statePanelHtml(panel, title);
}

/** The panel as plain lines, for a text-only place such as the WQL preview. */
export function stateText({ state, error }) {
  const known = STATES[state] ?? STATES.error;
  return [known.title, error, known.action].filter(Boolean).join('\n');
}
