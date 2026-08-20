const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// -------------------------------------------------------------
// 1. Git Repository & Diff Helpers
// -------------------------------------------------------------
function findGitRepos() {
  const searchRoots = [
    path.join(os.homedir(), 'dev'),
    path.join(os.homedir(), 'Dev'),
    process.cwd()
  ];
  const repos = new Map();

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const realRoot = fs.realpathSync(root);
      if (fs.existsSync(path.join(realRoot, '.git'))) {
        repos.set(realRoot.toLowerCase(), { name: path.basename(realRoot), path: realRoot });
      }
      const entries = fs.readdirSync(realRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subPath = path.join(realRoot, entry.name);
          if (fs.existsSync(path.join(subPath, '.git'))) {
            const realSub = fs.realpathSync(subPath);
            repos.set(realSub.toLowerCase(), { name: entry.name, path: realSub });
          }
        }
      }
    } catch (e) {}
  }

  return Array.from(repos.values());
}

function executeGit(repoPath, args) {
  try {
    return execSync(`git -c core.quotepath=false ${args}`, { cwd: repoPath, encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 });
  } catch (e) {
    return e.stdout ? e.stdout.toString('utf8') : '';
  }
}

function decodeGitOctalOnly(str) {
  if (!str || !str.includes('\\')) return str;
  return str.replace(/((?:\\[0-7]{3})+)/g, function(match) {
    try {
      const octals = match.match(/\\[0-7]{3}/g);
      if (!octals) return match;
      const bytes = new Uint8Array(octals.map(o => parseInt(o.slice(1), 8)));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return match;
    }
  });
}

function matchRepo(hint, repos) {
  if (!hint || !repos || repos.length === 0) return repos[0]?.path || '';
  const lowerHint = decodeURIComponent(hint).toLowerCase();
  for (const r of repos) {
    if (lowerHint.includes(r.path.toLowerCase()) || lowerHint.includes(r.name.toLowerCase())) {
      return r.path;
    }
  }
  return repos[0]?.path || '';
}

// -------------------------------------------------------------
// 2. Git API Endpoints
// -------------------------------------------------------------
function handleGitApi(req, res, url) {
  const params = url.searchParams;
  const repos = findGitRepos();
  const repoPath = params.get('repo') || (repos[0]?.path);

  if (url.pathname === '/__git/api/repos') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(repos));
  }

  if (!repoPath || !fs.existsSync(repoPath)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Repository not found' }));
  }

  if (url.pathname === '/__git/api/status') {
    const branch = executeGit(repoPath, 'rev-parse --abbrev-ref HEAD').trim();
    const statusRaw = executeGit(repoPath, 'status --porcelain=v1 -uall');
    const files = [];

    statusRaw.split('\n').filter(Boolean).forEach(line => {
      const indexStatus = line.substring(0, 1);
      const workTreeStatus = line.substring(1, 2);
      let filePath = line.substring(3).trim().replace(/^"|"$/g, '');
      filePath = decodeGitOctalOnly(filePath);
      files.push({ path: filePath, index: indexStatus, workTree: workTreeStatus });
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ repo: repoPath, branch, files }));
  }

  if (url.pathname === '/__git/api/diff') {
    const filePath = params.get('file');
    const commitHash = params.get('commit');
    const staged = params.get('staged') === 'true';

    let diffOutput = '';
    if (commitHash) {
      diffOutput = executeGit(repoPath, `show --format=fuller ${commitHash} ${filePath ? `-- "${filePath}"` : ''}`);
    } else if (staged) {
      diffOutput = executeGit(repoPath, `diff --staged ${filePath ? `-- "${filePath}"` : ''}`);
    } else {
      diffOutput = executeGit(repoPath, `diff ${filePath ? `-- "${filePath}"` : ''}`);
      if (!diffOutput.trim() && filePath && fs.existsSync(path.join(repoPath, filePath))) {
        diffOutput = executeGit(repoPath, `diff --no-index -- /dev/null "${filePath}"`);
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(diffOutput);
  }

  if (url.pathname === '/__git/api/log') {
    const limit = parseInt(params.get('limit') || '40', 10);
    const logRaw = executeGit(repoPath, `log -n ${limit} --pretty=format:"%H|%h|%an|%ar|%s"`);
    const commits = logRaw.split('\n').filter(Boolean).map(line => {
      const [fullHash, hash, author, time, ...msgParts] = line.split('|');
      return { fullHash, hash, author, time, message: msgParts.join('|') };
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(commits));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// -------------------------------------------------------------
// 3. Standalone Git Inspector HTML Web UI (Server-Rendered First Frame)
// -------------------------------------------------------------
function renderGitUi(res, url) {
  const repos = findGitRepos();
  const activeHint = (url && url.searchParams) ? (url.searchParams.get('active') || '') : '';
  const currentRepo = matchRepo(activeHint, repos);
  let initialBranch = 'main';
  let initialFiles = [];

  if (currentRepo && fs.existsSync(currentRepo)) {
    initialBranch = executeGit(currentRepo, 'rev-parse --abbrev-ref HEAD').trim() || 'main';
    const statusRaw = executeGit(currentRepo, 'status --porcelain=v1 -uall');
    statusRaw.split('\n').filter(Boolean).forEach(line => {
      const indexStatus = line.substring(0, 1);
      const workTreeStatus = line.substring(1, 2);
      let filePath = line.substring(3).trim().replace(/^"|"$/g, '');
      filePath = decodeGitOctalOnly(filePath);
      initialFiles.push({ path: filePath, index: indexStatus, workTree: workTreeStatus });
    });
  }

  const repoOptions = repos.map(r => {
    const isSelected = r.path === currentRepo ? ' selected' : '';
    return `<option value="${escapeHtmlAttr(r.path)}"${isSelected}>${escapeHtmlText(r.name)}</option>`;
  }).join('');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Git Inspector</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --editor-bg: #181818;
      --text: #cccccc;
      --text-bright: #ffffff;
      --text-muted: #858585;
      --border: #2d2d2d;
      --border-focus: #007acc;
      --accent: #007acc;
      --diff-add-bg: rgba(46, 160, 67, 0.15);
      --diff-add-line: #3fb950;
      --diff-add-word: #2ea043;
      --diff-del-bg: rgba(248, 81, 73, 0.15);
      --diff-del-line: #f85149;
      --diff-del-word: #da3633;
      --diff-hunk: #388bfd;
      --diff-hunk-bg: rgba(56, 139, 253, 0.1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden;
    }
    header {
      background: #252526; border-bottom: 1px solid var(--border); padding: 0.5rem 0.8rem;
      display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
    }
    .header-row-1 { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    .header-row-2 { display: flex; align-items: center; gap: 0.4rem; }
    select, button {
      background: var(--editor-bg); color: var(--text); border: 1px solid var(--border);
      padding: 0.35rem 0.65rem; border-radius: 4px; font-size: 0.82rem; cursor: pointer; transition: all 0.15s ease;
    }
    select:focus, button:focus { outline: none; border-color: var(--border-focus); }
    #repoSelect {
      font-weight: 600; color: #ffffff; max-width: 200px; text-overflow: ellipsis;
    }
    .branch-badge {
      font-size: 0.75rem; background: #333333; padding: 2px 6px; border-radius: 3px;
      color: #cccccc; font-family: monospace; flex-shrink: 0;
    }
    .tabs { display: flex; gap: 0.25rem; background: #181818; padding: 2px; border-radius: 5px; }
    .tabs button {
      border: none; background: transparent; padding: 0.3rem 0.65rem; font-size: 0.78rem; border-radius: 4px;
    }
    .tabs button.active {
      background: var(--accent); color: #ffffff; font-weight: 600;
    }
    .tabs button:hover:not(.active) { color: var(--text-bright); }

    .main-container { display: flex; flex: 1; overflow: hidden; position: relative; }
    .sidebar {
      width: 320px; min-width: 220px; background: var(--bg); border-right: 1px solid var(--border);
      display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0;
    }
    .content { flex: 1; padding: 1rem 1.25rem; overflow-y: auto; background: var(--editor-bg); }
    .file-item, .commit-item {
      padding: 0.65rem 0.9rem; border-bottom: 1px solid #232323;
      cursor: pointer; display: flex; align-items: center; justify-content: space-between; font-size: 0.83rem;
      transition: background 0.1s ease;
    }
    .file-item:hover, .commit-item:hover { background: #2a2d2e; }
    .file-item.selected, .commit-item.selected { background: #04395e; color: #ffffff; border-left: 3px solid var(--accent); }
    .status-badge { font-size: 0.68rem; font-weight: 700; padding: 2px 5px; border-radius: 3px; font-family: monospace; flex-shrink: 0; }
    .badge-M { background: #cca700; color: #000; }
    .badge-A, .badge-U, .badge-question { background: #2ea043; color: #fff; }
    .badge-D { background: #f85149; color: #fff; }
    
    .file-diff-card {
      background: var(--editor-bg); border: 1px solid var(--border); border-radius: 6px;
      margin-bottom: 1rem; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.2);
    }
    .file-diff-header {
      background: #252526; padding: 0.55rem 0.9rem; font-size: 0.84rem; font-weight: 600;
      color: var(--text-bright); border-bottom: 1px solid var(--border); display: flex;
      justify-content: space-between; align-items: center; cursor: pointer; user-select: none;
    }
    .file-diff-header:hover { background: #2d2d30; }
    .file-title-left { display: flex; align-items: center; gap: 0.6rem; word-break: break-all; }
    .file-chevron { font-size: 0.75rem; color: #858585; transition: transform 0.15s ease; width: 12px; text-align: center; }
    .file-diff-card.collapsed .file-chevron { transform: rotate(-90deg); }
    .file-diff-card.collapsed .file-diff-body { display: none; }
    .file-diff-card.collapsed .file-diff-header { border-bottom: none; }
    .file-diff-stats { display: flex; gap: 0.5rem; font-size: 0.75rem; font-weight: normal; }
    .stat-add { color: #3fb950; font-family: monospace; font-weight: 600; }
    .stat-del { color: #f85149; font-family: monospace; font-weight: 600; }

    .file-diff-body {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      width: 100%;
    }
    .diff-table {
      width: max-content;
      min-width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-family: "JetBrains Mono", Menlo, Consolas, "Courier New", monospace;
      font-size: 0.82rem;
    }
    .diff-table tr { line-height: 1.45rem; }
    .diff-table td {
      padding: 0 0.5rem;
      vertical-align: top;
      white-space: pre;
    }
    .code-cell {
      white-space: pre;
      word-break: normal;
      overflow-wrap: normal;
      padding-right: 1.5rem !important;
    }
    .line-num {
      width: 36px;
      min-width: 36px;
      text-align: right;
      color: #666666;
      user-select: none;
      border-right: 1px solid #282828;
      padding-right: 0.4rem !important;
      position: sticky;
      background: #1e1e1e;
      z-index: 2;
    }
    .line-num-old { left: 0; }
    .line-num-new { left: 36px; }
    .line-prefix {
      width: 18px;
      min-width: 18px;
      text-align: center;
      user-select: none;
      position: sticky;
      left: 72px;
      background: #1e1e1e;
      z-index: 2;
    }
    .line-add { background: var(--diff-add-bg); color: var(--text-bright); }
    .line-add .line-num, .line-add .line-prefix { background: #1c2b20; }
    .line-add .line-prefix { color: var(--diff-add-line); font-weight: bold; }
    
    .line-del { background: var(--diff-del-bg); color: var(--text-bright); }
    .line-del .line-num, .line-del .line-prefix { background: #2f1d1e; }
    .line-del .line-prefix { color: var(--diff-del-line); font-weight: bold; }
    
    .line-hunk { background: var(--diff-hunk-bg); color: var(--diff-hunk); font-style: italic; }
    .line-hunk .line-num, .line-hunk .line-prefix { background: #192535; }
    
    ins { background: var(--diff-add-word); color: #ffffff; text-decoration: none; border-radius: 2px; padding: 1px 2px; }
    del { background: var(--diff-del-word); color: #ffffff; text-decoration: none; border-radius: 2px; padding: 1px 2px; }

    .empty-state { text-align: center; padding: 3rem; color: var(--text-muted); font-size: 0.9rem; }
    .summary-bar { margin-bottom: 0.75rem; font-size: 0.82rem; color: var(--text-muted); display: flex; align-items: center; justify-content: space-between; }
    .summary-controls { display: flex; gap: 0.5rem; }
    .summary-controls button { padding: 0.2rem 0.5rem; font-size: 0.75rem; }

    #btnBackToFiles {
      display: none;
      background: var(--accent);
      color: #ffffff;
      font-weight: 600;
      border: none;
      padding: 0.35rem 0.65rem;
      border-radius: 4px;
      flex-shrink: 0;
    }

    @media (max-width: 768px) {
      header {
        flex-direction: column;
        align-items: stretch;
        padding: 0.45rem 0.6rem;
        gap: 0.4rem;
      }
      .header-row-1 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.4rem;
        width: 100%;
      }
      .header-row-2 {
        display: flex;
        align-items: center;
        width: 100%;
      }
      .header-row-2 .tabs {
        width: 100%;
        display: flex;
      }
      .header-row-2 .tabs button {
        flex: 1;
        text-align: center;
        padding: 0.4rem 0.2rem;
        font-size: 0.78rem;
      }
      #repoSelect {
        flex: 1;
        min-width: 0;
        max-width: none;
        font-size: 0.82rem;
      }
      .sidebar {
        width: 100% !important;
        min-width: 100% !important;
        border-right: none;
      }
      .content {
        display: none;
        width: 100% !important;
        padding: 0.5rem 0.25rem;
      }
      body.viewing-diff .sidebar {
        display: none !important;
      }
      body.viewing-diff .content {
        display: block !important;
      }
      #btnBackToFiles {
        display: none;
      }
      body.viewing-diff #btnBackToFiles {
        display: inline-flex !important;
      }
      .line-num { width: 30px; min-width: 30px; font-size: 0.72rem; }
      .line-num-old { left: 0; }
      .line-num-new { left: 30px; }
      .line-prefix { left: 60px; width: 14px; min-width: 14px; }
      .diff-table td { padding: 0 0.25rem; font-size: 0.76rem; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row-1">
      <button id="btnBackToFiles" onclick="backToFilesList()">← Files</button>
      <select id="repoSelect">
        ${repoOptions || '<option value="">No Git repos found</option>'}
      </select>
      <span id="branchBadge" class="branch-badge">${escapeHtmlText(initialBranch)}</span>
      <button onclick="refreshData()" title="Refresh (R)" style="padding:0.35rem 0.55rem; flex-shrink:0;">↻</button>
    </div>
    <div class="header-row-2">
      <div class="tabs">
        <button id="tabWorking" class="active" onclick="switchTab('working')">Changes</button>
        <button id="tabHistory" onclick="switchTab('history')">History</button>
      </div>
    </div>
  </header>
  <div class="main-container">
    <div class="sidebar" id="sidebarList"></div>
    <div class="content" id="diffContent">
      <div class="empty-state">Select a file or commit to inspect diff</div>
    </div>
  </div>

  <script>
    var initialRepos = ${JSON.stringify(repos)};
    var initialFiles = ${JSON.stringify(initialFiles)};
    var currentRepo = ${JSON.stringify(currentRepo)};
    var currentTab = 'working';
    var selectedItem = null;

    async function fetchJson(url) {
      try {
        var res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return await res.json();
      } catch (e) {
        console.error('fetchJson error for ' + url, e);
        return null;
      }
    }

    async function fetchText(url) {
      try {
        var res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return '';
        return await res.text();
      } catch (e) {
        console.error('fetchText error for ' + url, e);
        return '';
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function backToFilesList() {
      document.body.classList.remove('viewing-diff');
    }

    function switchTab(tab) {
      currentTab = tab;
      selectedItem = null;
      document.body.classList.remove('viewing-diff');
      document.getElementById('tabWorking').classList.toggle('active', tab === 'working');
      document.getElementById('tabHistory').classList.toggle('active', tab === 'history');
      loadCurrentView();
    }

    function refreshData() {
      loadCurrentView();
    }

    function loadCurrentView() {
      if (!currentRepo) return;
      if (currentTab === 'working') {
        loadWorkingChanges();
      } else {
        loadCommitHistory();
      }
    }

    function findActiveRepoFromParent() {
      try {
        if (!window.parent || !window.parent.document) return null;
        var pWin = window.parent;
        var pDoc = pWin.document;

        // 1. Check parent window URL
        var pUrl = decodeURIComponent(pWin.location.href || '').toLowerCase();
        for (var i = 0; i < initialRepos.length; i++) {
          var r = initialRepos[i];
          if (pUrl.includes(r.path.toLowerCase()) || pUrl.includes('/' + r.name.toLowerCase() + '/') || pUrl.includes('/' + r.name.toLowerCase() + '?') || pUrl.includes('=' + r.name.toLowerCase())) {
            return r.path;
          }
        }

        // 2. Check parent document title
        var pTitle = (pDoc.title || '').toLowerCase();
        for (var i = 0; i < initialRepos.length; i++) {
          var r = initialRepos[i];
          if (pTitle.includes(r.name.toLowerCase())) {
            return r.path;
          }
        }

        // 3. Check workspace titles, breadcrumbs, tabs, or headers
        var selectors = [
          '.monaco-workbench .part.titlebar',
          '.monaco-workbench .breadcrumbs-control',
          '.monaco-workbench .tabs-and-actions-container',
          '.workspace-title',
          '.project-title',
          'header',
          '[data-workspace-path]',
          '[role="tab"]'
        ];
        for (var s = 0; s < selectors.length; s++) {
          var els = pDoc.querySelectorAll(selectors[s]);
          for (var k = 0; k < els.length; k++) {
            var elText = (els[k].innerText || els[k].getAttribute('aria-label') || '').toLowerCase();
            for (var i = 0; i < initialRepos.length; i++) {
              var r = initialRepos[i];
              if (elText.includes(r.name.toLowerCase())) {
                return r.path;
              }
            }
          }
        }

        // 4. Check visible document body text
        var bodyText = (pDoc.body ? pDoc.body.innerText.substring(0, 20000) : '').toLowerCase();
        for (var i = 0; i < initialRepos.length; i++) {
          var r = initialRepos[i];
          if (bodyText.includes(r.name.toLowerCase())) {
            return r.path;
          }
        }
      } catch (err) {
        console.warn('Could not inspect parent DOM:', err);
      }
      return null;
    }

    function autoSelectProject(hint) {
      if (!hint || !initialRepos || initialRepos.length === 0) return;
      var lower = decodeURIComponent(hint).toLowerCase();
      var matched = null;
      for (var i = 0; i < initialRepos.length; i++) {
        var r = initialRepos[i];
        if (lower.includes(r.path.toLowerCase()) || lower.includes(r.name.toLowerCase())) {
          matched = r.path;
          break;
        }
      }
      if (matched && matched !== currentRepo) {
        currentRepo = matched;
        var sel = document.getElementById('repoSelect');
        if (sel) sel.value = matched;
        selectedItem = null;
        document.body.classList.remove('viewing-diff');
        loadCurrentView();
      }
    }

    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'AUTO_SELECT_PROJECT' && e.data.project) {
        autoSelectProject(e.data.project);
      }
    });

    function renderFilesList(files) {
      var sidebar = document.getElementById('sidebarList');
      sidebar.innerHTML = '';

      if (!files || files.length === 0) {
        sidebar.innerHTML = '<div style="padding:1.5rem; color:#6e7681; font-size:0.83rem; text-align:center;">Working tree clean ✨</div>';
        document.getElementById('diffContent').innerHTML = '<div class="empty-state">No uncommitted changes in this project ✨</div>';
        return;
      }

      files.forEach(function(f, idx) {
        try {
          var item = document.createElement('div');
          item.className = 'file-item' + (selectedItem === f.path ? ' selected' : '');
          
          var statusLetter = f.index !== ' ' && f.index !== '?' ? f.index : (f.workTree || '?');
          if (statusLetter === '?') statusLetter = 'U';
          
          var badgeClass = statusLetter === 'M' ? 'badge-M' : (statusLetter === 'D' ? 'badge-D' : 'badge-U');
          var cleanPath = f.path;
          
          var lastSlash = cleanPath.lastIndexOf('/');
          var fileName = lastSlash !== -1 ? cleanPath.substring(lastSlash + 1) : cleanPath;
          var dirName = lastSlash !== -1 ? cleanPath.substring(0, lastSlash) : '';

          var html = '<div style="display:flex; flex-direction:column; overflow:hidden; flex:1; min-width:0; margin-right:8px;" title="' + escapeHtml(cleanPath) + '">';
          html += '<span style="font-weight:500; color:var(--text-bright); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">' + escapeHtml(fileName) + '</span>';
          if (dirName) {
            html += '<span style="font-size:0.73rem; color:var(--text-muted); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; margin-top:2px;">' + escapeHtml(dirName) + '</span>';
          }
          html += '</div>';
          html += '<span class="status-badge ' + badgeClass + '">' + statusLetter + '</span>';

          item.innerHTML = html;
          item.onclick = function() {
            selectedItem = f.path;
            document.querySelectorAll('.file-item').forEach(function(el) { el.classList.remove('selected'); });
            item.classList.add('selected');
            document.body.classList.add('viewing-diff');
            showDiff(f.path, cleanPath);
          };
          sidebar.appendChild(item);
          if (window.innerWidth > 768 && idx === 0 && !selectedItem) {
            item.click();
          }
        } catch (err) {
          console.error('Error rendering file item:', err);
        }
      });
    }

    async function loadWorkingChanges() {
      if (!currentRepo) return;
      var sidebar = document.getElementById('sidebarList');
      sidebar.innerHTML = '<div style="padding:1.5rem; color:#858585; font-size:0.83rem; text-align:center;">Loading changes...</div>';

      var data = await fetchJson('/__git/api/status?repo=' + encodeURIComponent(currentRepo));
      if (!data || !data.files) {
        sidebar.innerHTML = '<div style="padding:1.5rem; color:#f85149; font-size:0.83rem; text-align:center;">Failed to load Git status</div>';
        return;
      }

      document.getElementById('branchBadge').textContent = data.branch || 'main';
      renderFilesList(data.files);
    }

    async function loadCommitHistory() {
      if (!currentRepo) return;
      var sidebar = document.getElementById('sidebarList');
      sidebar.innerHTML = '<div style="padding:1.5rem; color:#858585; font-size:0.83rem; text-align:center;">Loading commits...</div>';

      var commits = await fetchJson('/__git/api/log?limit=40&repo=' + encodeURIComponent(currentRepo));
      if (!commits || !Array.isArray(commits)) {
        sidebar.innerHTML = '<div style="padding:1.5rem; color:#f85149; font-size:0.83rem; text-align:center;">Failed to load commit log</div>';
        return;
      }

      sidebar.innerHTML = '';
      commits.forEach(function(c, idx) {
        var item = document.createElement('div');
        item.className = 'commit-item' + (selectedItem === c.fullHash ? ' selected' : '');
        item.innerHTML = '<div style="width:100%;"><div style="font-weight:600; color:#ffffff; word-break:break-word;">' + escapeHtml(c.message) + '</div><div style="font-size:0.74rem; color:#858585; margin-top:3px;">' + c.hash + ' • ' + escapeHtml(c.author) + ' • ' + c.time + '</div></div>';
        item.onclick = function() {
          selectedItem = c.fullHash;
          document.querySelectorAll('.commit-item').forEach(function(el) { el.classList.remove('selected'); });
          item.classList.add('selected');
          document.body.classList.add('viewing-diff');
          showCommitDiff(c.fullHash, c.message);
        };
        sidebar.appendChild(item);
        if (window.innerWidth > 768 && idx === 0 && !selectedItem) {
          item.click();
        }
      });
    }

    async function showDiff(filePath, cleanPath) {
      var diffText = await fetchText('/__git/api/diff?repo=' + encodeURIComponent(currentRepo) + '&file=' + encodeURIComponent(filePath));
      var container = document.getElementById('diffContent');
      if (!diffText.trim()) {
        container.innerHTML = '<div class="empty-state">No diff available for this file</div>';
        return;
      }
      container.innerHTML = renderSingleFileDiffCard(diffText, cleanPath || filePath);
    }

    async function showCommitDiff(commitHash, message) {
      var diffText = await fetchText('/__git/api/diff?repo=' + encodeURIComponent(currentRepo) + '&commit=' + encodeURIComponent(commitHash));
      var container = document.getElementById('diffContent');
      if (!diffText.trim()) {
        container.innerHTML = '<div class="empty-state">No diff changes in this commit</div>';
        return;
      }
      container.innerHTML = renderMultiFileDiffView(diffText, message);
    }

    function renderSingleFileDiffCard(diffText, title) {
      var parsed = parseUnifiedDiff(diffText);
      var file = parsed[0] || { filePath: title, header: title, hunks: [], additions: 0, deletions: 0 };
      var html = '<div class="summary-bar"><span>Showing: <strong>' + escapeHtml(title) + '</strong></span></div>';
      html += renderFileCard(file, true);
      return html;
    }

    function renderMultiFileDiffView(diffText, title) {
      var files = parseUnifiedDiff(diffText);
      var totalAdd = files.reduce(function(acc, f) { return acc + f.additions; }, 0);
      var totalDel = files.reduce(function(acc, f) { return acc + f.deletions; }, 0);

      var html = '<div class="summary-bar">';
      html += '<div><strong>' + escapeHtml(title) + '</strong> <span style="margin-left:8px;">(' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' changed: <span class="stat-add">+' + totalAdd + '</span> <span class="stat-del">-' + totalDel + '</span>)</span></div>';
      html += '<div class="summary-controls">';
      html += '<button onclick="expandAllCards(true)">Expand All</button>';
      html += '<button onclick="expandAllCards(false)">Collapse All</button>';
      html += '</div>';
      html += '</div>';

      files.forEach(function(f, i) {
        html += renderFileCard(f, i === 0);
      });

      return html;
    }

    function toggleDiffCard(headerEl) {
      if (headerEl && headerEl.closest) {
        headerEl.closest('.file-diff-card').classList.toggle('collapsed');
      }
    }

    function renderFileCard(file, isOpen) {
      var cardTitle = file.filePath || file.header || 'Diff';
      var html = '<div class="file-diff-card ' + (isOpen ? '' : 'collapsed') + '">';
      html += '<div class="file-diff-header" onclick="toggleDiffCard(this)">';
      html += '<div class="file-title-left">';
      html += '<span class="file-chevron">▼</span>';
      html += '<span>' + escapeHtml(cardTitle) + '</span>';
      html += '</div>';
      html += '<div class="file-diff-stats">';
      if (file.additions > 0) html += '<span class="stat-add">+' + file.additions + '</span>';
      if (file.deletions > 0) html += '<span class="stat-del">-' + file.deletions + '</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="file-diff-body">';
      html += '<table class="diff-table">';
      
      file.hunks.forEach(function(h) {
        html += '<tr class="line-hunk"><td class="line-num line-num-old">...</td><td class="line-num line-num-new">...</td><td class="line-prefix"></td><td class="code-cell">' + escapeHtml(h.header) + '</td></tr>';
        h.lines.forEach(function(l) {
          var rowClass = l.type === 'add' ? 'line-add' : (l.type === 'del' ? 'line-del' : '');
          html += '<tr class="' + rowClass + '">';
          html += '<td class="line-num line-num-old">' + (l.oldNum || '') + '</td>';
          html += '<td class="line-num line-num-new">' + (l.newNum || '') + '</td>';
          html += '<td class="line-prefix">' + (l.type === 'add' ? '+' : (l.type === 'del' ? '-' : ' ')) + '</td>';
          html += '<td class="code-cell">' + (l.htmlContent || escapeHtml(l.text)) + '</td>';
          html += '</tr>';
        });
      });

      html += '</table></div></div>';
      return html;
    }

    function expandAllCards(expand) {
      document.querySelectorAll('.file-diff-card').forEach(function(card) {
        if (expand) {
          card.classList.remove('collapsed');
        } else {
          card.classList.add('collapsed');
        }
      });
    }

    function parseUnifiedDiff(diffText) {
      var files = [];
      var currentFile = null;
      var currentHunk = null;
      var oldLine = 0;
      var newLine = 0;

      var lines = diffText.split('\\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        if (line.startsWith('diff --git')) {
          var rawText = line.substring(11);
          var m = rawText.match(/a\\/(.+?)\\s+b\\/(.+)$/);
          var filePath = m ? m[2] : rawText;

          currentFile = {
            filePath: filePath,
            hunks: [],
            additions: 0,
            deletions: 0
          };
          files.push(currentFile);
          currentHunk = null;
          continue;
        }

        if (line.startsWith('@@ ')) {
          var hunkMatch = line.match(/@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@(.*)/);
          if (hunkMatch) {
            oldLine = parseInt(hunkMatch[1], 10);
            newLine = parseInt(hunkMatch[2], 10);
            currentHunk = {
              header: line,
              lines: []
            };
            if (currentFile) currentFile.hunks.push(currentHunk);
          }
          continue;
        }

        if (!currentHunk) continue;

        if (line.startsWith('+')) {
          if (currentFile) currentFile.additions++;
          currentHunk.lines.push({
            type: 'add',
            oldNum: null,
            newNum: newLine++,
            text: line.substring(1)
          });
        } else if (line.startsWith('-')) {
          if (currentFile) currentFile.deletions++;
          currentHunk.lines.push({
            type: 'del',
            oldNum: oldLine++,
            newNum: null,
            text: line.substring(1)
          });
        } else if (line.startsWith(' ') || line === '') {
          currentHunk.lines.push({
            type: 'ctx',
            oldNum: oldLine++,
            newNum: newLine++,
            text: line.startsWith(' ') ? line.substring(1) : line
          });
        }
      }

      files.forEach(function(f) {
        f.hunks.forEach(function(h) {
          computeWordDiff(h.lines);
        });
      });

      return files;
    }

    function computeWordDiff(lines) {
      if (lines.length > 500) return;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].type === 'del' && i + 1 < lines.length && lines[i + 1].type === 'add') {
          var delLine = lines[i];
          var addLine = lines[i + 1];

          var delWords = delLine.text.split(/(\\s+|[.,;:\\/()[\\]{}<>"'])/).filter(Boolean);
          var addWords = addLine.text.split(/(\\s+|[.,;:\\/()[\\]{}<>"'])/).filter(Boolean);

          var delHtml = '';
          var addHtml = '';

          var maxLen = Math.max(delWords.length, addWords.length);
          if (maxLen > 80) continue;

          for (var j = 0; j < maxLen; j++) {
            var dw = delWords[j];
            var aw = addWords[j];

            if (dw === aw) {
              if (dw !== undefined) delHtml += escapeHtml(dw);
              if (aw !== undefined) addHtml += escapeHtml(aw);
            } else {
              if (dw !== undefined) delHtml += '<del>' + escapeHtml(dw) + '</del>';
              if (aw !== undefined) addHtml += '<ins>' + escapeHtml(aw) + '</ins>';
            }
          }

          delLine.htmlContent = delHtml;
          addLine.htmlContent = addHtml;
          i++;
        }
      }
    }

    // Setup select onchange
    var sel = document.getElementById('repoSelect');
    if (sel) {
      sel.onchange = function() {
        currentRepo = sel.value;
        selectedItem = null;
        document.body.classList.remove('viewing-diff');
        loadCurrentView();
      };
    }

    // Auto-detect from parent DOM on load
    var detectedRepo = findActiveRepoFromParent();
    if (detectedRepo && detectedRepo !== currentRepo) {
      currentRepo = detectedRepo;
      if (sel) sel.value = detectedRepo;
      selectedItem = null;
      loadCurrentView();
    } else if (initialFiles && initialFiles.length > 0) {
      renderFilesList(initialFiles);
    } else {
      loadCurrentView();
    }
  </script>
</body>
</html>`);
}

function escapeHtmlText(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// -------------------------------------------------------------
// 4. Injected Floating Action Button & Git Drawer
// -------------------------------------------------------------
function getInjectedDrawerSnippet() {
  return `
<!-- 🌿 Antigravity Git Drawer -->
<div id="__ag_git_fab" style="position:fixed;top:14px;right:14px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;touch-action:none;user-select:none;">
  <button id="__ag_git_fab_btn" onclick="window.__toggleAgGit(event)" aria-label="Git Inspector" title="Git Inspector" style="width:48px;height:48px;border-radius:50%;background:#1a73e8;color:#fff;border:none;box-shadow:0 4px 12px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;transition:transform 0.1s ease, background 0.15s ease;outline:none;-webkit-tap-highlight-color:transparent;">
    🌿
  </button>
</div>
<div id="__ag_git_overlay" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);z-index:9999998;" onclick="window.__toggleAgGit()"></div>
<div id="__ag_git_drawer" style="position:fixed;top:0;right:-100vw;width:min(1150px, 95vw);height:100vh;background:#181818;box-shadow:-8px 0 30px rgba(0,0,0,0.8);z-index:9999999;transition:right 0.25s ease;display:flex;flex-direction:column;">
  <!-- Left resize drag handle -->
  <div id="__ag_git_resizer" style="position:absolute;top:0;left:0;width:10px;height:100%;cursor:col-resize;user-select:none;z-index:10000000;background:transparent;" title="Drag to resize width"></div>
  
  <div style="padding:8px 14px;background:#252526;border-bottom:1px solid #2d2d2d;display:flex;justify-content:space-between;align-items:center;">
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-weight:600;color:#ffffff;font-size:13px;">🌿 Git</span>
      <button onclick="window.__toggleFullscreenGit()" id="__ag_git_expand_btn" style="background:#333333;color:#cccccc;border:none;padding:3px 8px;border-radius:3px;font-size:11px;cursor:pointer;" title="Toggle Fullscreen">⛶</button>
    </div>
    <button onclick="window.__toggleAgGit()" style="background:transparent;border:none;color:#858585;font-size:20px;cursor:pointer;padding:0 6px;">✕</button>
  </div>
  <iframe id="__ag_git_iframe" src="/__git" style="flex:1;border:none;width:100%;height:100%;"></iframe>
</div>
<script>
  (function() {
    var drawer = document.getElementById('__ag_git_drawer');
    var overlay = document.getElementById('__ag_git_overlay');
    var resizer = document.getElementById('__ag_git_resizer');
    var fab = document.getElementById('__ag_git_fab');
    var fabBtn = document.getElementById('__ag_git_fab_btn');
    var iframe = document.getElementById('__ag_git_iframe');
    var isExpanded = false;
    var defaultWidth = window.innerWidth <= 768 ? '100vw' : (Math.min(1150, window.innerWidth * 0.95) + 'px');
    var justDragged = false;

    window.__toggleAgGit = function(e) {
      if (justDragged) {
        justDragged = false;
        return;
      }
      if (drawer.style.right === '0px') {
        drawer.style.right = '-100vw';
        overlay.style.display = 'none';
      } else {
        drawer.style.width = window.innerWidth <= 768 ? '100vw' : defaultWidth;
        drawer.style.right = '0px';
        overlay.style.display = 'block';

        if (iframe && iframe.contentWindow) {
          try {
            iframe.contentWindow.location.reload();
          } catch(err) {
            iframe.src = '/__git';
          }
        }
      }
    };

    window.__toggleFullscreenGit = function() {
      var btn = document.getElementById('__ag_git_expand_btn');
      if (!isExpanded) {
        drawer.style.width = '100vw';
        btn.textContent = '⤢';
        isExpanded = true;
      } else {
        drawer.style.width = defaultWidth;
        btn.textContent = '⛶';
        isExpanded = false;
      }
    };

    function ensureFabVisible() {
      var maxLeft = Math.max(8, window.innerWidth - 56);
      var maxTop = Math.max(8, window.innerHeight - 56);
      var rect = fab.getBoundingClientRect();
      var currentLeft = rect.left;
      var currentTop = rect.top;

      var clampedX = Math.max(8, Math.min(maxLeft, currentLeft));
      var clampedY = Math.max(8, Math.min(maxTop, currentTop));

      fab.style.left = clampedX + 'px';
      fab.style.top = clampedY + 'px';
      fab.style.bottom = 'auto';
      fab.style.right = 'auto';
    }

    // Restore saved FAB position
    try {
      var savedPos = localStorage.getItem('__ag_git_fab_pos');
      if (savedPos) {
        var parsed = JSON.parse(savedPos);
        var parsedLeft = parseFloat(parsed.left);
        var parsedTop = parseFloat(parsed.top);
        if (!isNaN(parsedLeft) && !isNaN(parsedTop)) {
          var maxLeft = Math.max(8, window.innerWidth - 56);
          var maxTop = Math.max(8, window.innerHeight - 56);
          fab.style.left = Math.max(8, Math.min(maxLeft, parsedLeft)) + 'px';
          fab.style.top = Math.max(8, Math.min(maxTop, parsedTop)) + 'px';
          fab.style.bottom = 'auto';
          fab.style.right = 'auto';
        }
      }
    } catch (e) {}

    window.addEventListener('resize', ensureFabVisible);

    // Draggable Round FAB
    var isDraggingFab = false;
    var startX = 0, startY = 0;
    var fabStartX = 0, fabStartY = 0;

    fabBtn.addEventListener('pointerdown', function(e) {
      isDraggingFab = true;
      justDragged = false;
      startX = e.clientX;
      startY = e.clientY;
      var rect = fab.getBoundingClientRect();
      fabStartX = rect.left;
      fabStartY = rect.top;
      fabBtn.style.transform = 'scale(0.92)';
      try { fabBtn.setPointerCapture(e.pointerId); } catch (err) {}
    });

    fabBtn.addEventListener('pointermove', function(e) {
      if (!isDraggingFab) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        justDragged = true;
        var newX = Math.max(8, Math.min(window.innerWidth - fab.offsetWidth - 8, fabStartX + dx));
        var newY = Math.max(8, Math.min(window.innerHeight - fab.offsetHeight - 8, fabStartY + dy));
        fab.style.left = newX + 'px';
        fab.style.top = newY + 'px';
        fab.style.bottom = 'auto';
        fab.style.right = 'auto';
      }
    });

    fabBtn.addEventListener('pointerup', function(e) {
      if (!isDraggingFab) return;
      isDraggingFab = false;
      fabBtn.style.transform = 'scale(1)';
      try { fabBtn.releasePointerCapture(e.pointerId); } catch (err) {}

      if (justDragged) {
        try {
          localStorage.setItem('__ag_git_fab_pos', JSON.stringify({
            top: fab.style.top,
            left: fab.style.left
          }));
        } catch (err) {}
      }
    });

    fabBtn.addEventListener('pointercancel', function(e) {
      isDraggingFab = false;
      fabBtn.style.transform = 'scale(1)';
    });

    // Resizer logic
    var isDraggingResizer = false;
    resizer.addEventListener('mousedown', function(e) {
      isDraggingResizer = true;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', function(e) {
      if (!isDraggingResizer) return;
      var newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 300 && newWidth <= window.innerWidth) {
        drawer.style.width = newWidth + 'px';
      }
    });

    window.addEventListener('mouseup', function() {
      if (isDraggingResizer) {
        isDraggingResizer = false;
        document.body.style.userSelect = '';
      }
    });
  })();
</script>
`;
}

module.exports = {
  findGitRepos,
  executeGit,
  decodeGitOctalOnly,
  matchRepo,
  handleGitApi,
  renderGitUi,
  getInjectedDrawerSnippet
};
