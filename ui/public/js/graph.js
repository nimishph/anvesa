/**
 * ANVESA UI — Code Graph & Architecture Visualizer
 * Physics-based interactive force graph on HTML5 Canvas.
 */

export function initGraphVisualizer(state, api) {
  const canvas = document.getElementById('graphCanvas');
  const symbolInput = document.getElementById('graphSymbolInput');
  const inspector = document.getElementById('nodeInspectorDrawer');
  const inspectorTitle = document.getElementById('inspectorSymbolTitle');
  const inspectorKind = document.getElementById('inspectorSymbolKind');
  const inspectorPath = document.getElementById('inspectorSymbolPath');
  const inspectorCallersCount = document.getElementById('inspectorCallersCount');
  const inspectorCalleesCount = document.getElementById('inspectorCalleesCount');
  const btnInspectorClose = document.getElementById('btnInspectorClose');
  const btnRefocusGraph = document.getElementById('btnRefocusGraph');

  // Subnav buttons & containers
  const btnSubCallGraph = document.getElementById('btnSubCallGraph');
  const btnSubRepomap = document.getElementById('btnSubRepomap');
  const btnSubRoutes = document.getElementById('btnSubRoutes');
  const viewCallGraph = document.getElementById('viewCallGraph');
  const viewRepomap = document.getElementById('viewRepomap');
  const viewRoutes = document.getElementById('viewRoutes');

  // Repomap & Routes containers
  const repomapTree = document.getElementById('repomapTree');
  const routesTableBody = document.getElementById('routesTableBody');
  const routesSearchInput = document.getElementById('routesSearchInput');

  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Graph state
  let width = canvas.parentElement.clientWidth || 800;
  let height = canvas.parentElement.clientHeight || 640;
  let scale = 1;
  let panX = width / 2;
  let panY = height / 2;
  let isDragging = false;
  let dragNode = null;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let hoveredNode = null;
  let animationFrameId = null;

  let nodes = [];
  let links = [];
  let activeSymbol = 'Retriever.search';
  let activeNodeData = null;

  function resizeCanvas() {
    if (!canvas || !canvas.parentElement) return;
    width = canvas.parentElement.clientWidth;
    height = canvas.parentElement.clientHeight;
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Load symbol into graph
  async function loadSymbolGraph(symName) {
    activeSymbol = symName;
    if (symbolInput) symbolInput.value = symName;

    let data = null;
    try {
      const resp = await api.getNeighbors(symName);
      if (resp && resp.success && resp.neighbors) {
        data = resp.neighbors;
      }
    } catch {
      // Fallback to mock
    }

    if (!data) {
      data =
        window.ANVESA_MOCK?.graphData?.[symName] ||
        window.ANVESA_MOCK?.graphData?.['Retriever.search'];
    }

    buildGraphStructure(data, symName);
  }

  function buildGraphStructure(data, rootName) {
    nodes = [];
    links = [];

    // Target Node (Center)
    const targetNode = {
      id: 'target',
      name: rootName,
      type: 'target',
      kind: data?.symbol?.kind || 'method',
      path: data?.symbol?.path || 'src/retriever.ts',
      radius: 26,
      color: '#6366f1',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      callersCount: data?.callers?.length || 0,
      calleesCount: data?.callees?.length || 0,
    };
    nodes.push(targetNode);

    // Callers (Incoming Links)
    const callers = data?.callers || [
      { id: 'cli:search', name: 'anvesa search', kind: 'command', path: 'cli/src/commands.ts:643' },
      { id: 'mcp:tool', name: 'MCP Server', kind: 'tool', path: 'cli/src/mcp.ts:61' },
    ];
    callers.forEach((c, idx) => {
      const angle = (idx / Math.max(1, callers.length)) * Math.PI - Math.PI / 2;
      const dist = 160 + (idx % 2) * 30;
      const node = {
        id: 'caller_' + idx,
        name: c.name,
        type: 'caller',
        kind: c.kind || 'function',
        path: c.path || '',
        radius: 18,
        color: '#c084fc',
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
      };
      nodes.push(node);
      links.push({ source: node, target: targetNode, type: 'calls' });
    });

    // Callees (Outgoing Links)
    const callees = data?.callees || [
      { id: 'fuse', name: 'fuse', kind: 'function', path: 'retriever/src/fuse.ts:34' },
      {
        id: 'retrieveDense',
        name: 'retrieveDense',
        kind: 'function',
        path: 'dense/src/retrieve.ts:28',
      },
      {
        id: 'StructuralEngine',
        name: 'StructuralEngine.query',
        kind: 'method',
        path: 'structural/src/engine.ts:89',
      },
    ];
    callees.forEach((c, idx) => {
      const angle = (idx / Math.max(1, callees.length)) * Math.PI + Math.PI / 2;
      const dist = 170 + (idx % 2) * 30;
      const node = {
        id: 'callee_' + idx,
        name: c.name,
        type: 'callee',
        kind: c.kind || 'function',
        path: c.path || '',
        radius: 18,
        color: '#06b6d4',
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
      };
      nodes.push(node);
      links.push({ source: targetNode, target: node, type: 'calls' });
    });

    // Neighbors (Amber)
    const neighbors = data?.neighbors || [];
    neighbors.forEach((n, idx) => {
      const node = {
        id: 'neighbor_' + idx,
        name: n.name,
        type: 'neighbor',
        kind: n.kind || 'symbol',
        path: n.path || '',
        radius: 15,
        color: '#f59e0b',
        x: (idx + 1) * 80 - 120,
        y: 220,
        vx: 0,
        vy: 0,
      };
      nodes.push(node);
      links.push({ source: targetNode, target: node, type: 'adjacent' });
    });

    panX = width / 2;
    panY = height / 2;
    scale = 1;
  }

  // Force simulation tick
  function simulatePhysics() {
    // Repulsion between nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 280) {
          const force = ((280 - dist) / dist) * 0.08;
          if (nodes[i] !== dragNode && nodes[i].type !== 'target') {
            nodes[i].vx -= dx * force;
            nodes[i].vy -= dy * force;
          }
          if (nodes[j] !== dragNode && nodes[j].type !== 'target') {
            nodes[j].vx += dx * force;
            nodes[j].vy += dy * force;
          }
        }
      }
    }

    // Spring tension on links
    links.forEach((link) => {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetDist = 150;
      const force = (dist - targetDist) * 0.04;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (link.source !== dragNode && link.source.type !== 'target') {
        link.source.vx += fx;
        link.source.vy += fy;
      }
      if (link.target !== dragNode && link.target.type !== 'target') {
        link.target.vx -= fx;
        link.target.vy -= fy;
      }
    });

    // Update positions with damping
    nodes.forEach((n) => {
      if (n !== dragNode && n.type !== 'target') {
        n.x += n.vx;
        n.y += n.vy;
        n.vx *= 0.85;
        n.vy *= 0.85;
      }
    });
  }

  function renderGraph() {
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    // Draw Links
    links.forEach((link) => {
      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);

      if (link.type === 'calls') {
        ctx.strokeStyle =
          link.source.type === 'caller' ? 'rgba(192, 132, 252, 0.45)' : 'rgba(6, 182, 212, 0.45)';
        ctx.lineWidth = 2;
      } else {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw Arrow head
      const angle = Math.atan2(link.target.y - link.source.y, link.target.x - link.source.x);
      const headDist = link.target.radius + 6;
      const arrowX = link.target.x - Math.cos(angle) * headDist;
      const arrowY = link.target.y - Math.sin(angle) * headDist;

      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(
        arrowX - 8 * Math.cos(angle - Math.PI / 6),
        arrowY - 8 * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        arrowX - 8 * Math.cos(angle + Math.PI / 6),
        arrowY - 8 * Math.sin(angle + Math.PI / 6),
      );
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    });

    // Draw Nodes
    nodes.forEach((n) => {
      const isHovered = hoveredNode === n;
      const isTarget = n.type === 'target';

      // Outer glow for target or hover
      if (isTarget || isHovered) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + (isHovered ? 8 : 12), 0, Math.PI * 2);
        ctx.fillStyle = isTarget ? 'rgba(99, 102, 241, 0.25)' : 'rgba(6, 182, 212, 0.25)';
        ctx.fill();
      }

      // Node body
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = isHovered ? 3 : 1.5;
      ctx.stroke();

      // Node label
      ctx.font = isTarget
        ? '600 13px "JetBrains Mono", monospace'
        : '500 11px "JetBrains Mono", monospace';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(n.name, n.x, n.y + n.radius + 6);
    });

    ctx.restore();

    simulatePhysics();
    animationFrameId = requestAnimationFrame(renderGraph);
  }

  // Mouse & interaction events
  function screenToWorld(sx, sy) {
    return {
      x: (sx - panX) / scale,
      y: (sy - panY) / scale,
    };
  }

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mousePos = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    // Check hit node
    const hit = nodes.find((n) => {
      const dx = n.x - mousePos.x;
      const dy = n.y - mousePos.y;
      return Math.sqrt(dx * dx + dy * dy) <= n.radius + 4;
    });

    if (hit) {
      dragNode = hit;
      showNodeInspector(hit);
    } else {
      isDragging = true;
    }
  });

  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mousePos = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    if (dragNode) {
      dragNode.x = mousePos.x;
      dragNode.y = mousePos.y;
    } else if (isDragging) {
      panX += e.clientX - lastMouseX;
      panY += e.clientY - lastMouseY;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    } else {
      // Check hover
      hoveredNode =
        nodes.find((n) => {
          const dx = n.x - mousePos.x;
          const dy = n.y - mousePos.y;
          return Math.sqrt(dx * dx + dy * dy) <= n.radius + 4;
        }) || null;
    }
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    dragNode = null;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    scale = Math.min(Math.max(scale * zoomFactor, 0.4), 3.0);
  });

  // Node Inspector Modal
  function showNodeInspector(node) {
    activeNodeData = node;
    if (inspectorTitle) inspectorTitle.textContent = node.name;
    if (inspectorKind) inspectorKind.textContent = (node.kind || 'symbol').toUpperCase();
    if (inspectorPath) inspectorPath.textContent = node.path || 'Workspace symbol';
    if (inspectorCallersCount)
      inspectorCallersCount.textContent = node.callersCount || (node.type === 'caller' ? '1' : '0');
    if (inspectorCalleesCount)
      inspectorCalleesCount.textContent = node.calleesCount || (node.type === 'callee' ? '1' : '0');

    if (inspector) inspector.classList.add('open');
  }

  if (btnInspectorClose) {
    btnInspectorClose.addEventListener('click', () => {
      if (inspector) inspector.classList.remove('open');
    });
  }

  if (btnRefocusGraph) {
    btnRefocusGraph.addEventListener('click', () => {
      if (activeNodeData && activeNodeData.name) {
        loadSymbolGraph(activeNodeData.name);
        if (inspector) inspector.classList.remove('open');
      }
    });
  }

  // Symbol Input autocomplete & submit
  if (symbolInput) {
    symbolInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = symbolInput.value.trim();
        if (val) loadSymbolGraph(val);
      }
    });
  }

  // Global navigator bridge
  window.navigateToGraphSymbol = (symName) => {
    const navBtn = document.querySelector('[data-view="graph"]');
    if (navBtn) navBtn.click();
    loadSymbolGraph(symName);
  };

  // Sub-Navigation between Call Graph, Repomap, and Routes
  function switchGraphSubView(view) {
    if (btnSubCallGraph) btnSubCallGraph.classList.toggle('active', view === 'callgraph');
    if (btnSubRepomap) btnSubRepomap.classList.toggle('active', view === 'repomap');
    if (btnSubRoutes) btnSubRoutes.classList.toggle('active', view === 'routes');

    if (viewCallGraph) viewCallGraph.style.display = view === 'callgraph' ? 'block' : 'none';
    if (viewRepomap) viewRepomap.style.display = view === 'repomap' ? 'block' : 'none';
    if (viewRoutes) viewRoutes.style.display = view === 'routes' ? 'block' : 'none';

    if (view === 'repomap') loadRepomap();
    if (view === 'routes') loadRoutes();
  }

  if (btnSubCallGraph)
    btnSubCallGraph.addEventListener('click', () => switchGraphSubView('callgraph'));
  if (btnSubRepomap) btnSubRepomap.addEventListener('click', () => switchGraphSubView('repomap'));
  if (btnSubRoutes) btnSubRoutes.addEventListener('click', () => switchGraphSubView('routes'));

  // Render Repomap
  async function loadRepomap() {
    if (!repomapTree) return;
    repomapTree.innerHTML =
      '<div style="padding:2rem;text-align:center;color:var(--text-secondary);">Calculating PageRank weights...</div>';

    let repomap = null;
    try {
      const resp = await api.getRepoMap();
      if (resp && resp.success && resp.repomap) repomap = resp.repomap;
    } catch {}

    if (!repomap) repomap = window.ANVESA_MOCK?.repomap;

    const files = repomap?.files || [];
    repomapTree.innerHTML = files
      .map((file) => {
        const prPct = (file.pageRank * 100).toFixed(1) + '%';
        return `
        <div class="repomap-file-card">
          <div class="repomap-file-header">
            <span class="repomap-file-path">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              ${file.path}
            </span>
            <div class="symbol-rank-meter">
              <span style="font-size:0.75rem;font-family:var(--font-mono);color:var(--text-secondary);">Weight: ${prPct}</span>
              <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${prPct}"></div></div>
            </div>
          </div>
          <div class="repomap-symbols-list">
            ${file.symbols
              .map(
                (sym) => `
              <div class="repomap-symbol-item">
                <div class="symbol-left">
                  <span class="symbol-kind-tag">${sym.kind}</span>
                  <a href="javascript:void(0)" class="symbol-name-text" onclick="window.navigateToGraphSymbol('${sym.name}')">${sym.name}</a>
                </div>
                <div style="font-size:0.75rem;font-family:var(--font-mono);color:var(--text-tertiary);">
                  ${sym.callers} callers
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
      `;
      })
      .join('');
  }

  // Render Routes
  async function loadRoutes() {
    if (!routesTableBody) return;
    let routes = null;
    try {
      const resp = await api.getRoutes();
      if (resp && resp.success && resp.routes) routes = resp.routes;
    } catch {}

    if (!routes) routes = window.ANVESA_MOCK?.routes || [];

    function renderRoutesList(list) {
      routesTableBody.innerHTML = list
        .map((r) => {
          const mClass = 'm-' + r.method.toLowerCase();
          return `
          <tr>
            <td><span class="method-pill ${mClass}">${r.method}</span></td>
            <td><span class="route-pattern">${r.path}</span></td>
            <td><span class="route-handler">${r.handler}</span></td>
            <td style="color:var(--text-secondary);">${r.file}</td>
            <td><span class="badge badge-indigo">${r.framework}</span></td>
          </tr>
        `;
        })
        .join('');
    }

    renderRoutesList(routes);

    if (routesSearchInput) {
      routesSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        const filtered = routes.filter(
          (r) => r.path.toLowerCase().includes(q) || r.handler.toLowerCase().includes(q),
        );
        renderRoutesList(filtered);
      });
    }
  }

  // Initial load
  loadSymbolGraph(activeSymbol);
  renderGraph();
}
