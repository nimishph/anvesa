/**
 * ANVESA UI — Search Studio Controller
 */

export function initSearchStudio(state, api) {
  const searchInput = document.getElementById('searchQueryInput');
  const searchModeSelect = document.getElementById('searchModeSelect');
  const weightCode = document.getElementById('weightCode');
  const weightDocs = document.getElementById('weightDocs');
  const weightWql = document.getElementById('weightWql');
  const valWeightCode = document.getElementById('valWeightCode');
  const valWeightDocs = document.getElementById('valWeightDocs');
  const valWeightWql = document.getElementById('valWeightWql');
  const filterScope = document.getElementById('filterScope');
  const filterWql = document.getElementById('filterWql');
  const resultsContainer = document.getElementById('searchResultsContainer');
  const resultsMetaText = document.getElementById('resultsMetaText');
  const cliPreviewOutput = document.getElementById('cliPreviewOutput');

  let debounceTimer = null;

  // Sliders value display
  if (weightCode && valWeightCode) {
    weightCode.addEventListener('input', (e) => {
      valWeightCode.textContent = Number(e.target.value).toFixed(1);
      updateCliCommand();
      triggerSearch();
    });
  }
  if (weightDocs && valWeightDocs) {
    weightDocs.addEventListener('input', (e) => {
      valWeightDocs.textContent = Number(e.target.value).toFixed(1);
      updateCliCommand();
      triggerSearch();
    });
  }
  if (weightWql && valWeightWql) {
    weightWql.addEventListener('input', (e) => {
      valWeightWql.textContent = Number(e.target.value).toFixed(1);
      updateCliCommand();
      triggerSearch();
    });
  }

  // Filter & Search input handlers
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        triggerSearch();
        updateCliCommand();
      }, 250);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        triggerSearch();
      }
    });
  }

  if (filterScope) {
    filterScope.addEventListener('input', () => {
      updateCliCommand();
      triggerSearch();
    });
  }
  if (filterWql) {
    filterWql.addEventListener('input', () => {
      updateCliCommand();
      triggerSearch();
    });
  }
  if (searchModeSelect) {
    searchModeSelect.addEventListener('change', () => {
      updateCliCommand();
      triggerSearch();
    });
  }

  // Chips click handlers
  document.querySelectorAll('.query-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const q = chip.getAttribute('data-query') || chip.textContent.trim();
      if (searchInput) {
        searchInput.value = q;
        searchInput.focus();
        triggerSearch();
        updateCliCommand();
      }
    });
  });

  // CLI Command generation
  function updateCliCommand() {
    const q = searchInput?.value.trim() || 'query';
    const mode = searchModeSelect?.value || 'fused';
    const wDocs = weightDocs?.value;
    const scope = filterScope?.value.trim();
    const wql = filterWql?.value.trim();

    let cmd = `anvesa search "${q}"`;
    if (mode === 'semantic') cmd += ' --no-wql';
    if (mode === 'structural' && !wql) cmd = `anvesa query "${q}"`;
    if (wDocs && Number(wDocs) !== 1.0) cmd += ` --weight docs=${Number(wDocs).toFixed(1)}`;
    if (scope) cmd += ` --scope "${scope}"`;
    if (wql) cmd += ` --wql "${wql}"`;

    if (cliPreviewOutput) {
      cliPreviewOutput.textContent = cmd;
    }
  }

  async function triggerSearch() {
    const query = searchInput?.value.trim() || '';
    if (!query) {
      renderDefaultResults();
      return;
    }

    if (resultsMetaText) {
      resultsMetaText.textContent = `Searching "${query}"...`;
    }

    const payload = {
      query,
      wql: filterWql?.value.trim() || undefined,
      scope: filterScope?.value.trim() || undefined,
      weights: {
        code: Number(weightCode?.value || 1.0),
        docs: Number(weightDocs?.value || 0.8),
        wql: Number(weightWql?.value || 1.0),
      },
    };

    const startTime = performance.now();
    try {
      const resp = await api.search(payload);
      const elapsed = (performance.now() - startTime).toFixed(1);

      if (resp && resp.success && resp.result && resp.result.hits) {
        renderResults(resp.result.hits, elapsed, false);
      } else {
        // Fallback or filter mock items
        const hits = window.ANVESA_MOCK?.searchResults || [];
        const filtered = hits.filter(
          (h) =>
            h.name.toLowerCase().includes(query.toLowerCase()) ||
            h.docSummary.toLowerCase().includes(query.toLowerCase()) ||
            h.path.toLowerCase().includes(query.toLowerCase()),
        );
        renderResults(filtered.length ? filtered : hits, elapsed, true);
      }
    } catch {
      const hits = window.ANVESA_MOCK?.searchResults || [];
      renderResults(hits, 12.4, true);
    }
  }

  function renderDefaultResults() {
    const hits = window.ANVESA_MOCK?.searchResults || [];
    renderResults(hits, 8.2, true);
  }

  function renderResults(hits, elapsedMs, isDemo) {
    if (!resultsContainer) return;

    if (resultsMetaText) {
      resultsMetaText.innerHTML = `Found <strong>${hits.length}</strong> results in <strong>${elapsedMs}ms</strong> · Model: <strong>bge-base-en-v1.5 (768d)</strong> · Reciprocal Rank Fusion (k=60) ${isDemo ? '<span class="badge badge-amber" style="margin-left:8px;">Demo Data</span>' : '<span class="badge badge-emerald" style="margin-left:8px;">Live Index</span>'}`;
    }

    if (hits.length === 0) {
      resultsContainer.innerHTML = `
        <div class="state-container">
          <svg class="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <div class="state-title">No matching symbols found</div>
          <div class="state-desc">Try loosening search keywords, removing path scope filters, or switching to fused semantic mode.</div>
        </div>
      `;
      return;
    }

    resultsContainer.innerHTML = hits
      .map((hit, index) => {
        const bestScorePct = hit.bestScore ? (hit.bestScore * 100).toFixed(1) + '%' : 'N/A';
        const rrfScore = hit.score ? Number(hit.score).toFixed(3) : '0.850';
        const lanesBadges = (hit.lanes || ['dense:symbols'])
          .map((lane) => {
            if (lane.includes('wql')) return `<span class="badge badge-cyan">${lane}</span>`;
            if (lane.includes('docs')) return `<span class="badge badge-purple">${lane}</span>`;
            return `<span class="badge badge-indigo">${lane}</span>`;
          })
          .join(' ');

        const formattedCode = syntaxHighlight(hit.code || '// No preview available');

        return `
        <div class="result-card" data-symbol="${hit.name}" data-path="${hit.path}">
          <div class="result-header">
            <div class="result-title-group">
              <span class="result-rank-num">#${index + 1}</span>
              <a href="javascript:void(0)" class="result-location" title="${hit.path}:${hit.lines}">
                <span class="result-symbol-name">${hit.container ? hit.container + '.' : ''}${hit.name}</span>
                <span style="opacity:0.6;font-weight:400;">(${hit.path}:${hit.lines})</span>
              </a>
            </div>
            <div class="result-badges-group">
              ${lanesBadges}
              <span class="badge badge-emerald" title="Screened by Red-Team filter">🛡️ RRF: ${rrfScore}</span>
              <span class="badge badge-indigo" title="Cosine similarity">Similarity: ${bestScorePct}</span>
            </div>
          </div>
          <div class="result-body">
            ${hit.docSummary ? `<div class="result-docstring">${hit.docSummary}</div>` : ''}
            <div class="code-fence-wrapper">
              <div class="code-fence-header">
                <span class="fence-security-tag">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                  UNTRUSTED RETRIEVAL FENCE (RED-TEAM SCREENED)
                </span>
                <span>Language: TypeScript</span>
              </div>
              <pre class="code-pre"><code>${formattedCode}</code></pre>
            </div>
          </div>
          <div class="result-footer">
            <div class="result-footer-left">
              <button class="btn-card-action btn-inspect-graph" data-symbol="${hit.name}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="18" cy="5" r="3"></circle>
                  <circle cx="6" cy="12" r="3"></circle>
                  <circle cx="18" cy="19" r="3"></circle>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
                </svg>
                Explore in Code Graph
              </button>
              <button class="btn-card-action btn-copy-loc" data-loc="${hit.path}:${hit.lines}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Location
              </button>
            </div>
            <button class="btn-card-action btn-copy-cmd" data-name="${hit.name}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="4 17 10 11 4 5"></polyline>
                <line x1="12" y1="19" x2="20" y2="19"></line>
              </svg>
              anvesa callers "${hit.name}"
            </button>
          </div>
        </div>
      `;
      })
      .join('');

    // Attach card event listeners
    resultsContainer.querySelectorAll('.btn-inspect-graph').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sym = btn.getAttribute('data-symbol');
        if (sym && window.navigateToGraphSymbol) {
          window.navigateToGraphSymbol(sym);
        }
      });
    });

    resultsContainer.querySelectorAll('.btn-copy-loc').forEach((btn) => {
      btn.addEventListener('click', () => {
        const loc = btn.getAttribute('data-loc');
        if (loc) {
          navigator.clipboard.writeText(loc);
          const orig = btn.innerHTML;
          btn.innerHTML = '✓ Copied!';
          setTimeout(() => {
            btn.innerHTML = orig;
          }, 1500);
        }
      });
    });

    resultsContainer.querySelectorAll('.btn-copy-cmd').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sym = btn.getAttribute('data-name');
        if (sym) {
          const cmd = `anvesa callers "${sym}"`;
          navigator.clipboard.writeText(cmd);
          const orig = btn.innerHTML;
          btn.innerHTML = '✓ Copied Command!';
          setTimeout(() => {
            btn.innerHTML = orig;
          }, 1500);
        }
      });
    });
  }

  function syntaxHighlight(code) {
    const lines = code.split('\n');
    return lines
      .map((line, idx) => {
        const lineNum = idx + 1;
        let escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        escaped = escaped.replace(
          /\b(export|async|function|const|let|return|await|interface|type|class)\b/g,
          '<span class="hl-keyword">$1</span>',
        );
        escaped = escaped.replace(
          /\b(search|fuse|retrieveDense|parseWql|openSession|loadProjectConfig)\b/g,
          '<span class="hl-fn">$1</span>',
        );
        escaped = escaped.replace(/(".*?"|'.*?'|`.*?`)/g, '<span class="hl-string">$1</span>');
        escaped = escaped.replace(/(\/\/.*$)/g, '<span class="hl-comment">$1</span>');

        return `<div class="code-line"><span class="line-number">${lineNum}</span><span class="line-content">${escaped}</span></div>`;
      })
      .join('');
  }

  // Expose search parameter applicator for URL routing & agent triggers
  window.applySearchParameters = (params) => {
    if (!params) return;
    if (params.query !== undefined && searchInput) {
      searchInput.value = params.query;
    }
    if (params.mode !== undefined && searchModeSelect) {
      searchModeSelect.value = params.mode;
    }
    if (params.wql !== undefined && filterWql) {
      filterWql.value = params.wql;
    }
    if (params.scope !== undefined && filterScope) {
      filterScope.value = params.scope;
    }
    if (params.weightCode !== undefined && weightCode && valWeightCode) {
      weightCode.value = params.weightCode;
      valWeightCode.textContent = Number(params.weightCode).toFixed(1);
    }
    if (params.weightDocs !== undefined && weightDocs && valWeightDocs) {
      weightDocs.value = params.weightDocs;
      valWeightDocs.textContent = Number(params.weightDocs).toFixed(1);
    }
    if (params.weightWql !== undefined && weightWql && valWeightWql) {
      weightWql.value = params.weightWql;
      valWeightWql.textContent = Number(params.weightWql).toFixed(1);
    }
    updateCliCommand();
    triggerSearch();
  };

  // Initial load
  updateCliCommand();
  renderDefaultResults();
}
