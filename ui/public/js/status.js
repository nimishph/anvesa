/**
 * ANVESA UI — Index Status & WQL Playground Controller
 */

import { escapeHtml } from './search.js';

export function initStatusAndWql(state, api) {
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
    let statusData = null;
    let message = '';
    try {
      const resp = await api.getStatus();
      if (resp?.success && resp.live && resp.status) {
        statusData = resp.status;
      } else {
        message = resp?.error || resp?.message || '';
      }
    } catch (err) {
      message = String(err);
    }

    // Sample figures are shown only when no index answered, and the tab says so.
    const live = statusData !== null;
    if (!live) statusData = window.ANVESA_MOCK?.status ?? {};
    const banner = byId('statusSourceBanner');
    // `.status-section` sets `display`, which would override the `hidden` attribute.
    if (banner) banner.style.display = live ? 'none' : '';
    if (!live) {
      setText(
        'statusSourceMessage',
        `No index is connected, so this tab shows sample figures.${message ? ` (${message})` : ''}`,
      );
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
      statusData.embedder ? `${count(statusData.embedder.dimensions)} dimensions` : 'structural search only',
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
    setText('valPinnedChannels', `${count(channels.filter((c) => c.pinned).length)} of ${count(channels.length)}`);

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

    let failure = '';
    try {
      const resp = await api.queryWql({ wql });
      if (resp?.live && resp.result) {
        wqlAstPreview.textContent = JSON.stringify(resp.result, null, 2);
        return;
      }
      failure = resp?.error ?? '';
    } catch (err) {
      failure = String(err);
    }

    // A live index rejected the query: show why, rather than a sample that looks like an answer.
    if (failure) {
      wqlAstPreview.textContent = `Query failed: ${failure}`;
      return;
    }

    // Simulated AST matching visualization
    setTimeout(() => {
      if (!wqlAstPreview) return;
      const sampleAst = {
        note: 'Sample output: no index is connected.',
        query: wql,
        parsedPredicate: {
          tag: wql.includes('class') ? 'class' : 'function',
          attributes: wql.includes('@name')
            ? { name: wql.match(/@name\^?="([^"]+)"/)?.[1] || 'parse' }
            : {},
          scope: 'monorepo',
        },
        matchedNodes: [
          {
            symbol: 'search',
            kind: 'function',
            location: 'retriever/src/retriever.ts:142',
            astNodeType: 'function_declaration',
            parent: 'export_statement',
          },
          {
            symbol: 'fuse',
            kind: 'function',
            location: 'retriever/src/fuse.ts:34',
            astNodeType: 'function_declaration',
            parent: 'export_statement',
          },
          {
            symbol: 'parseWql',
            kind: 'function',
            location: 'structural/src/wql.ts:52',
            astNodeType: 'function_declaration',
            parent: 'export_statement',
          },
        ],
        stats: {
          syntaxNodesScanned: 18420,
          matchedCount: 3,
          elapsedMicros: 342,
        },
      };
      wqlAstPreview.textContent = JSON.stringify(sampleAst, null, 2);
    }, 150);
  }

  // Initial load
  loadSystemHealth();
}
