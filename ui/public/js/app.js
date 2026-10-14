/**
 * ANVESA UI — Main Application Orchestrator
 */

import { initGraphVisualizer } from './graph.js';
import { initSearchStudio } from './search.js';
import { initStatusAndWql } from './status.js';

class ApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  async getStatus() {
    const res = await fetch(`${this.baseUrl}/api/status`);
    return res.json();
  }

  async search(payload) {
    const res = await fetch(`${this.baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  async queryWql(payload) {
    const res = await fetch(`${this.baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  async getNeighbors(symbol) {
    const res = await fetch(
      `${this.baseUrl}/api/graph/neighbors?symbol=${encodeURIComponent(symbol)}`,
    );
    return res.json();
  }

  async getRepoMap(budget, scope) {
    let url = `${this.baseUrl}/api/repomap`;
    const params = [];
    if (budget) params.push(`budget=${budget}`);
    if (scope) params.push(`scope=${encodeURIComponent(scope)}`);
    if (params.length) url += `?${params.join('&')}`;
    const res = await fetch(url);
    return res.json();
  }

  async getRoutes(method, path) {
    let url = `${this.baseUrl}/api/routes`;
    const params = [];
    if (method) params.push(`method=${method}`);
    if (path) params.push(`path=${encodeURIComponent(path)}`);
    if (params.length) url += `?${params.join('&')}`;
    const res = await fetch(url);
    return res.json();
  }
}

// App Initialization
document.addEventListener('DOMContentLoaded', () => {
  const api = new ApiClient();
  const state = {
    activeView: 'search',
    projectRoot: 'anvesa',
  };

  // View Navigation
  const navTabs = document.querySelectorAll('.nav-tab');
  const viewSections = document.querySelectorAll('.view-section');

  function switchView(targetView) {
    state.activeView = targetView;
    navTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-view') === targetView);
    });
    viewSections.forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${targetView}`);
    });
  }

  navTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const view = tab.getAttribute('data-view');
      if (view) switchView(view);
    });
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Focus search on "/" or "Ctrl+K"
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
    } else if (
      e.key === '/' &&
      document.activeElement?.tagName !== 'INPUT' &&
      document.activeElement?.tagName !== 'TEXTAREA'
    ) {
      e.preventDefault();
      switchView('search');
      document.getElementById('searchQueryInput')?.focus();
    } else if (e.key === 'Escape') {
      closeAllModals();
    }
  });

  // Command Palette Modal
  const modalCmdPalette = document.getElementById('modalCommandPalette');
  const btnCmdPalette = document.getElementById('btnCommandPalette');
  const paletteInput = document.getElementById('paletteSearchInput');
  const paletteResults = document.getElementById('paletteResultsList');

  function openCommandPalette() {
    if (modalCmdPalette) {
      modalCmdPalette.classList.add('open');
      paletteInput?.focus();
    }
  }

  function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.remove('open'));
  }

  if (btnCmdPalette) {
    btnCmdPalette.addEventListener('click', openCommandPalette);
  }

  document.querySelectorAll('.modal-close, .modal-overlay').forEach((elem) => {
    elem.addEventListener('click', (e) => {
      if (e.target === elem) closeAllModals();
    });
  });

  // Command Palette navigation items
  const PALETTE_ACTIONS = [
    {
      title: 'Search: Find authentication token handler',
      category: 'Search Studio',
      action: () => {
        switchView('search');
        document.getElementById('searchQueryInput').value = 'authentication token';
      },
    },
    {
      title: 'Graph: Inspect Retriever.search Call Graph',
      category: 'Code Graph',
      action: () => {
        switchView('graph');
        window.navigateToGraphSymbol?.('Retriever.search');
      },
    },
    {
      title: 'Graph: Architectural PageRank Repomap',
      category: 'Architecture',
      action: () => {
        switchView('graph');
        document.getElementById('btnSubRepomap')?.click();
      },
    },
    {
      title: 'Graph: Explore Discovered HTTP Routes',
      category: 'Routes',
      action: () => {
        switchView('graph');
        document.getElementById('btnSubRoutes')?.click();
      },
    },
    {
      title: 'WQL: Query all class methods //class//method',
      category: 'Structural',
      action: () => {
        switchView('wql');
        document.getElementById('wqlPlaygroundInput').value = '//class//method';
      },
    },
    {
      title: 'Status: Check Embedding Model & Tree-Sitter matrix',
      category: 'Health',
      action: () => {
        switchView('status');
      },
    },
  ];

  if (paletteInput && paletteResults) {
    function renderPaletteItems(items) {
      paletteResults.innerHTML = items
        .map(
          (item, idx) => `
        <div class="palette-item" data-idx="${idx}" style="padding:0.75rem 1rem;border-radius:var(--radius-md);display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:background 150ms;">
          <div>
            <div style="font-weight:600;color:#fff;font-size:0.875rem;">${item.title}</div>
            <div style="font-size:0.75rem;color:var(--text-tertiary);">${item.category}</div>
          </div>
          <span class="kbd-shortcut">↵</span>
        </div>
      `,
        )
        .join('');

      paletteResults.querySelectorAll('.palette-item').forEach((elem) => {
        elem.addEventListener(
          'mouseenter',
          () => (elem.style.background = 'var(--bg-surface-hover)'),
        );
        elem.addEventListener('mouseleave', () => (elem.style.background = 'transparent'));
        elem.addEventListener('click', () => {
          const idx = Number(elem.getAttribute('data-idx'));
          PALETTE_ACTIONS[idx]?.action();
          closeAllModals();
        });
      });
    }

    renderPaletteItems(PALETTE_ACTIONS);

    paletteInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = PALETTE_ACTIONS.filter(
        (a) => a.title.toLowerCase().includes(q) || a.category.toLowerCase().includes(q),
      );
      renderPaletteItems(filtered);
    });
  }

  // Check live connection
  api
    .getStatus()
    .then((status) => {
      const statusPill = document.getElementById('connectionStatusPill');
      if (statusPill && status.live) {
        statusPill.innerHTML = '<span class="status-dot pulse"></span> Live Index Connected';
      }
    })
    .catch(() => {});

  // Initialize Subsystems
  initSearchStudio(state, api);
  initGraphVisualizer(state, api);
  initStatusAndWql(state, api);

  // Parse and apply URL query parameters (Agent UI Showcase)
  function applyUrlParameters() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q') || params.get('search');
    const mode = params.get('mode');
    const wql = params.get('wql');
    const scope = params.get('scope');
    const weightCode = params.get('weightCode');
    const weightDocs = params.get('weightDocs');
    const weightWql = params.get('weightWql');
    const symbol = params.get('symbol');
    const view = params.get('view');
    const repomap = params.get('repomap');
    const routes = params.get('routes');

    if (view && ['search', 'graph', 'wql', 'status'].includes(view.toLowerCase())) {
      switchView(view.toLowerCase());
    } else if (
      symbol ||
      repomap === 'true' ||
      repomap === '1' ||
      routes === 'true' ||
      routes === '1'
    ) {
      switchView('graph');
    } else if (wql && !q) {
      switchView('wql');
    }

    if (q || mode || wql || scope || weightCode || weightDocs || weightWql) {
      window.applySearchParameters?.({
        ...(q ? { query: q } : {}),
        ...(mode ? { mode } : {}),
        ...(wql ? { wql } : {}),
        ...(scope ? { scope } : {}),
        ...(weightCode ? { weightCode } : {}),
        ...(weightDocs ? { weightDocs } : {}),
        ...(weightWql ? { weightWql } : {}),
      });
    }

    if (symbol) {
      window.navigateToGraphSymbol?.(symbol);
    }

    if (repomap === 'true' || repomap === '1') {
      document.getElementById('btnSubRepomap')?.click();
    } else if (routes === 'true' || routes === '1') {
      document.getElementById('btnSubRoutes')?.click();
    }

    if (wql && document.getElementById('wqlPlaygroundInput')) {
      document.getElementById('wqlPlaygroundInput').value = wql;
      if (view === 'wql') {
        document.getElementById('btnRunWql')?.click();
      }
    }
  }

  applyUrlParameters();
});
