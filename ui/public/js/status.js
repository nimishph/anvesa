/**
 * ANVESA UI — System Health, Grammars, Red-Team & WQL Playground Controller
 */

export function initStatusAndWql(state, api) {
  // Telemetry elements
  const valActiveModel = document.getElementById('valActiveModel');
  const valModelDims = document.getElementById('valModelDims');
  const valIndexedSymbols = document.getElementById('valIndexedSymbols');
  const valIndexedFiles = document.getElementById('valIndexedFiles');
  const valGrammarCount = document.getElementById('valGrammarCount');
  const valRedteamStatus = document.getElementById('valRedteamStatus');
  const grammarsTableBody = document.getElementById('grammarsTableBody');
  const redteamRulesGrid = document.getElementById('redteamRulesGrid');

  // WQL Playground elements
  const wqlQueryInput = document.getElementById('wqlPlaygroundInput');
  const btnRunWql = document.getElementById('btnRunWql');
  const wqlAstPreview = document.getElementById('wqlAstPreview');

  async function loadSystemHealth() {
    let statusData = null;
    try {
      const resp = await api.getStatus();
      if (resp && resp.success && resp.status) {
        statusData = resp.status;
      }
    } catch {}

    if (!statusData) {
      statusData = window.ANVESA_MOCK?.status;
    }

    // Populate Top Telemetry Metrics
    if (valActiveModel) valActiveModel.textContent = statusData?.embedder?.id || 'bge-base-en-v1.5';
    if (valModelDims)
      valModelDims.textContent = `${statusData?.embedder?.dimensions || 768} dims · ${statusData?.embedder?.pooling || 'mean'} pooling`;
    if (valIndexedSymbols)
      valIndexedSymbols.textContent = Number(statusData?.index?.symbols || 2418).toLocaleString();
    if (valIndexedFiles)
      valIndexedFiles.textContent = `${statusData?.index?.files || 148} files (${statusData?.index?.calls || 4102} calls)`;
    if (valGrammarCount) valGrammarCount.textContent = '14 Installed';
    if (valRedteamStatus) valRedteamStatus.textContent = 'Enforced';

    // Populate Grammars Table
    if (grammarsTableBody) {
      const grammars = window.ANVESA_MOCK?.grammars || [];
      grammarsTableBody.innerHTML = grammars
        .map((g) => {
          const isNative = g.engine.includes('Native');
          return `
          <tr>
            <td style="font-weight:600;color:#fff;">${g.language}</td>
            <td><span class="badge ${isNative ? 'badge-indigo' : 'badge-cyan'}">${g.engine}</span></td>
            <td>v${g.version}</td>
            <td><span class="badge badge-emerald">● ${g.status}</span></td>
          </tr>
        `;
        })
        .join('');
    }

    // Populate Red-Team Security Gate Rules
    if (redteamRulesGrid) {
      const policies = window.ANVESA_MOCK?.redteamPolicies || [];
      redteamRulesGrid.innerHTML = policies
        .map((p) => {
          return `
          <div class="rule-box">
            <div class="rule-name">
              <span>${p.name}</span>
              <span class="badge badge-emerald">${p.status}</span>
            </div>
            <div class="rule-desc">${p.desc}</div>
          </div>
        `;
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
      if (resp && resp.success && resp.result) {
        wqlAstPreview.textContent = JSON.stringify(resp.result, null, 2);
        return;
      }
    } catch {}

    // Simulated AST matching visualization
    setTimeout(() => {
      if (!wqlAstPreview) return;
      const sampleAst = {
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
