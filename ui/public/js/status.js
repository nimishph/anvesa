/**
 * ANVESA UI — Index Status & WQL Playground Controller
 */

import { escapeHtml } from './search.js';
import { showStatePanel, stateOf, stateText, unreachable } from './state-panel.js';

export function initStatusAndWql(_state, api) {
  const byId = (id) => document.getElementById(id);
  const setText = (id, text) => {
    const el = byId(id);
    if (el) el.textContent = text;
  };
  const count = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

  // WQL Playground elements
  const wqlQueryInput = byId('wqlPlaygroundInput');
  const btnRunWql = byId('btnRunWql');
  const wqlAstPreview = byId('wqlAstPreview');

  async function loadSystemHealth() {
    let panel;
    let statusData = {};
    try {
      const resp = await api.getStatus();
      panel = stateOf(resp);
      if (!panel) statusData = resp.status ?? {};
      // An index that opened but holds nothing yet is not indexed, whatever the server could open.
      if (!panel && !(statusData.index?.files > 0)) {
        panel = { state: 'not-indexed', error: '' };
      }
    } catch (err) {
      panel = unreachable(err);
    }

    const banner = byId('statusSourceBanner');
    // `.status-section` sets `display`, which would override the `hidden` attribute.
    if (banner) {
      banner.style.display = panel ? '' : 'none';
      if (panel) showStatePanel(banner, panel);
    }

    const index = statusData.index ?? {};
    const channels = Array.isArray(statusData.channels) ? statusData.channels : [];
    const languages = Array.isArray(index.byLanguage) ? index.byLanguage : [];
    const models = Array.isArray(statusData.indexedModels) ? statusData.indexedModels : [];
    const structural = statusData.structural ?? {};
    const missing = Array.isArray(structural.missing) ? structural.missing.length : undefined;

    setText('valActiveModel', statusData.embedder?.id ?? 'none loaded');
    setText(
      'valModelDims',
      statusData.embedder
        ? `${count(statusData.embedder.dimensions)} dimensions`
        : 'structural search only',
    );
    setText('valIndexedModels', count(models.length));
    setText('valInterrupted', statusData.interrupted ? 'interrupted' : 'complete');

    setText('valIndexedSymbols', count(index.symbols));
    setText('valIndexedFiles', `${count(index.files)} files (${count(index.calls)} calls)`);
    setText('valGraphEdges', count(index.edges));
    setText('valImports', count(index.imports));

    setText('valLanguageCount', count(languages.length));
    setText('valStructuralFiles', `${count(structural.files)} files with outlines`);
    setText('valMissingOutlines', count(missing));

    setText('valQuarantinedFiles', count(index.quarantinedFiles ?? statusData.quarantinedFiles));
    setText(
      'valQuarantinedCards',
      count(channels.reduce((sum, c) => sum + (Number(c.quarantined) || 0), 0)),
    );
    setText(
      'valPinnedChannels',
      `${count(channels.filter((c) => c.pinned).length)} of ${count(channels.length)}`,
    );

    const languagesBody = byId('languagesTableBody');
    if (languagesBody) {
      languagesBody.innerHTML = languages
        .map(
          (l) => `
          <tr>
            <td style="font-weight:600;color:#fff;">${escapeHtml(l.language)}</td>
            <td>${escapeHtml(count(l.files))}</td>
          </tr>`,
        )
        .join('');
    }

    const channelsBody = byId('channelsTableBody');
    if (channelsBody) {
      channelsBody.innerHTML = channels
        .map((c) => {
          const state = c.problem
            ? `<span class="badge badge-amber" title="${escapeHtml(c.problem)}">not loaded</span>`
            : c.enabled === false
              ? '<span class="badge badge-indigo">disabled</span>'
              : '<span class="badge badge-emerald">enabled</span>';
          return `
          <tr>
            <td style="font-weight:600;color:#fff;">${escapeHtml(c.name)}${c.pinned ? ' <span class="badge badge-cyan">pinned</span>' : ''}</td>
            <td>${state}</td>
            <td>${escapeHtml(c.trust ?? '—')}</td>
            <td>${escapeHtml(count(c.cards))}</td>
            <td>${escapeHtml(count(c.sources))}</td>
            <td>${escapeHtml(count(c.quarantined))}</td>
          </tr>`;
        })
        .join('');
    }
  }

  // WQL Playground logic
  if (btnRunWql) {
    btnRunWql.addEventListener('click', runWqlPlayground);
  }

  // Syntax snippet insertion buttons
  document.querySelectorAll('.syntax-tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const snippet = btn.getAttribute('data-syntax');
      if (wqlQueryInput && snippet) {
        wqlQueryInput.value = snippet;
        runWqlPlayground();
      }
    });
  });

  async function runWqlPlayground() {
    const wql = wqlQueryInput?.value.trim() || '//function';
    if (wqlAstPreview) {
      wqlAstPreview.textContent = 'Evaluating AST query against workspace Tree-Sitter outline...';
    }

    try {
      const resp = await api.queryWql({ wql });
      const panel = resp?.result ? undefined : (stateOf(resp) ?? { state: 'error', error: '' });
      wqlAstPreview.textContent = panel ? stateText(panel) : JSON.stringify(resp.result, null, 2);
    } catch (err) {
      wqlAstPreview.textContent = stateText(unreachable(err));
    }
  }

  // Initial load
  loadSystemHealth();
}
