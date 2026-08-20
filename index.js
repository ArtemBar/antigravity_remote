#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

// -------------------------------------------------------------
// 0. Parse CLI Flags & Environment
// -------------------------------------------------------------
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '.env'),
    path.join(os.homedir(), '.antigravity_remote.env')
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...vals] = trimmed.split('=');
          if (key && vals.length > 0 && !process.env[key.trim()]) {
            process.env[key.trim()] = vals.join('=').trim().replace(/^['"]|['"]$/g, '');
          }
        }
      }
    }
  }
}
loadEnv();

// Parse CLI flags (e.g. --domain=..., --password=..., --port=..., --quick)
const args = process.argv.slice(2);
args.forEach(arg => {
  if (arg.startsWith('--domain=')) process.env.CUSTOM_DOMAIN = arg.split('=')[1];
  if (arg.startsWith('--password=') || arg.startsWith('--token=')) process.env.SECRET_TOKEN = arg.split('=')[1];
  if (arg.startsWith('--tunnel=')) process.env.TUNNEL_NAME = arg.split('=')[1];
  if (arg.startsWith('--port=')) process.env.LISTEN_PORT = arg.split('=')[1];
  if (arg === '--quick' || arg === '--try' || arg === '--trycloudflare') {
    process.env.CUSTOM_DOMAIN = '';
    delete process.env.TUNNEL_NAME;
  }
});

const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '64650', 10);
const TARGET_HOST = '127.0.0.1';

// Defaults (Completely Generic & Safe for Open Source)
const SECRET_TOKEN = process.env.SECRET_TOKEN || crypto.randomBytes(8).toString('hex');
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || null;
const TUNNEL_NAME = process.env.TUNNEL_NAME || 'antigravity-tunnel';

const CLOUDFLARED_DIR = path.join(os.homedir(), '.cloudflared');
const CONFIG_FILE = path.join(CLOUDFLARED_DIR, 'config.yml');
const CERT_FILE = path.join(CLOUDFLARED_DIR, 'cert.pem');

let cachedTargetPort = null;
let isDiscovering = false;
let tunnelProcess = null;
let quickTunnelUrl = null;
let lastRequestTime = Date.now();

// -------------------------------------------------------------
// 1. Automatic Cloudflare Setup Wizard
// -------------------------------------------------------------
function ensureCloudflareConfig() {
  if (!CUSTOM_DOMAIN) return; // Quick tunnel requires no named config

  if (!fs.existsSync(CLOUDFLARED_DIR)) {
    fs.mkdirSync(CLOUDFLARED_DIR, { recursive: true });
  }

  if (!fs.existsSync(CERT_FILE)) {
    console.log(`\n🔑 [Setup] First time setup: Authorizing Cloudflare for ${CUSTOM_DOMAIN}...`);
    console.log(`👉 A browser window will open. Select your domain to authorize.\n`);
    try {
      execSync('npx -y cloudflared tunnel login', { stdio: 'inherit' });
    } catch (e) {
      console.error(`[Setup Error] Cloudflare login failed: ${e.message}`);
      process.exit(1);
    }
  }

  let tunnelId = null;
  const jsonFiles = fs.readdirSync(CLOUDFLARED_DIR).filter(f => f.endsWith('.json'));
  
  if (jsonFiles.length > 0) {
    tunnelId = jsonFiles[0].replace('.json', '');
  } else {
    console.log(`\n⚙️ [Setup] Creating Cloudflare named tunnel "${TUNNEL_NAME}"...`);
    try {
      const createOutput = execSync(`npx -y cloudflared tunnel create ${TUNNEL_NAME}`, { encoding: 'utf8' });
      const match = createOutput.match(/with id ([a-f0-9-]+)/i);
      if (match) {
        tunnelId = match[1];
        console.log(`✅ [Setup] Tunnel created with ID: ${tunnelId}`);
      }
    } catch (e) {
      try {
        const listOutput = execSync('npx -y cloudflared tunnel list', { encoding: 'utf8' });
        const listMatch = listOutput.match(new RegExp(`([a-f0-9-]+)\\s+${TUNNEL_NAME}`, 'i'));
        if (listMatch) {
          tunnelId = listMatch[1];
        }
      } catch (err) {}
    }
  }

  try {
    execSync(`npx -y cloudflared tunnel route dns -f ${TUNNEL_NAME} ${CUSTOM_DOMAIN}`, { stdio: 'ignore' });
  } catch (e) {}

  if (tunnelId) {
    const credPath = path.join(CLOUDFLARED_DIR, `${tunnelId}.json`);
    const configContent = `tunnel: ${TUNNEL_NAME}\ncredentials-file: ${credPath}\n\ningress:\n  - hostname: ${CUSTOM_DOMAIN}\n    service: http://127.0.0.1:${LISTEN_PORT}\n  - service: http_status:404\n`;
    fs.writeFileSync(CONFIG_FILE, configContent, 'utf8');
  }
}

// -------------------------------------------------------------
// 2. Git Repository & Diff Inspector Helpers
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
    const statusRaw = executeGit(repoPath, 'status --porcelain=v1');
    const files = [];

    statusRaw.split('\n').filter(Boolean).forEach(line => {
      const indexStatus = line.substring(0, 1);
      const workTreeStatus = line.substring(1, 2);
      const filePath = line.substring(3).trim().replace(/^"|"$/g, '');
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

function renderGitUi(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Git Inspector</title>
  <style>
    :root {
      --bg: #181818;
      --editor-bg: #1e1e1e;
      --card: #252526;
      --border: #2d2d2d;
      --border-focus: #007acc;
      --text: #cccccc;
      --text-bright: #ffffff;
      --text-muted: #858585;
      --accent: #007acc;
      --accent-hover: #1f8ad2;
      --diff-add-bg: rgba(46, 160, 67, 0.15);
      --diff-add-text: #7ee787;
      --diff-add-word: rgba(46, 160, 67, 0.45);
      --diff-del-bg: rgba(248, 81, 73, 0.15);
      --diff-del-text: #ff7b72;
      --diff-del-word: rgba(248, 81, 73, 0.45);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg); color: var(--text); display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    }
    header {
      background: var(--card); border-bottom: 1px solid var(--border); padding: 0.6rem 1rem;
      display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; flex-shrink: 0;
    }
    .header-left { display: flex; align-items: center; gap: 0.75rem; }
    h1 { font-size: 0.95rem; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 0.5rem; color: var(--text-bright); }
    select, button {
      background: var(--editor-bg); color: var(--text); border: 1px solid var(--border);
      padding: 0.35rem 0.75rem; border-radius: 4px; font-size: 0.82rem; cursor: pointer; transition: all 0.15s ease;
    }
    select:focus, button:focus { outline: none; border-color: var(--border-focus); }
    button.active { background: var(--accent); color: #ffffff; border-color: var(--accent); font-weight: 500; }
    button:hover:not(.active) { background: #2a2d2e; color: var(--text-bright); }
    .tabs { display: flex; gap: 0.4rem; }
    .main-container { display: flex; flex: 1; overflow: hidden; position: relative; }
    .sidebar {
      width: 360px; min-width: 240px; background: var(--bg); border-right: 1px solid var(--border);
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
    .status-badge { font-size: 0.68rem; font-weight: 700; padding: 2px 5px; border-radius: 3px; font-family: monospace; }
    .badge-M { background: #cca700; color: #000; }
    .badge-A, .badge-question { background: #2ea043; color: #fff; }
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
    
    .file-stats { display: flex; gap: 0.5rem; font-size: 0.75rem; font-family: monospace; }
    .stat-add { color: #7ee787; font-weight: bold; }
    .stat-del { color: #ff7b72; font-weight: bold; }

    .commit-meta-box {
      background: #252526; border: 1px solid var(--border); border-radius: 6px;
      padding: 0.9rem 1.1rem; margin-bottom: 1.25rem;
    }
    .commit-meta-title { font-size: 1.05rem; font-weight: 600; color: #ffffff; margin-bottom: 0.5rem; line-height: 1.4; word-break: break-word; }
    .commit-meta-details { font-size: 0.78rem; color: #858585; line-height: 1.5; }
    .commit-toolbar {
      display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem;
      padding-top: 0.75rem; border-top: 1px solid #333333;
    }
    .toolbar-btn {
      background: #181818; color: var(--text); border: 1px solid #333333;
      padding: 0.25rem 0.6rem; border-radius: 3px; font-size: 0.75rem; cursor: pointer;
    }
    .toolbar-btn:hover { background: #333333; color: #ffffff; }

    .diff-lines { font-family: "Cascadia Code", "Fira Code", Menlo, Monaco, Consolas, "Courier New", monospace; font-size: 0.81rem; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
    .diff-line { padding: 1px 0.75rem; display: flex; }
    .diff-line.add { background: var(--diff-add-bg); color: var(--diff-add-text); }
    .diff-line.del { background: var(--diff-del-bg); color: var(--diff-del-text); }
    .diff-line.info { color: #58a6ff; background: rgba(88, 166, 255, 0.08); padding-top: 3px; padding-bottom: 3px; border-top: 1px solid rgba(88, 166, 255, 0.15); border-bottom: 1px solid rgba(88, 166, 255, 0.15); }
    .diff-line.meta { color: var(--text-muted); background: #1a1a1a; font-size: 0.76rem; }
    .diff-num { width: 35px; user-select: none; color: #6e7681; text-align: right; margin-right: 0.9rem; flex-shrink: 0; font-size: 0.75rem; }
    .diff-code { flex: 1; }
    ins { background: var(--diff-add-word); text-decoration: none; border-radius: 2px; padding: 0 2px; }
    del { background: var(--diff-del-word); text-decoration: none; border-radius: 2px; padding: 0 2px; }
    .empty-state { text-align: center; color: var(--text-muted); padding: 4rem 1rem; font-size: 0.95rem; }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <h1>🌿 Git Inspector</h1>
      <select id="repoSelect"></select>
      <span id="branchBadge" style="font-size:0.78rem; color:#58a6ff; background:rgba(88,166,255,0.12); padding:2px 7px; border-radius:3px; font-weight:500;"></span>
    </div>
    <div class="tabs">
      <button id="tabWorking" class="active">Uncommitted</button>
      <button id="tabHistory">Commit History</button>
      <button id="btnRefresh">🔄</button>
    </div>
  </header>

  <div class="main-container">
    <div class="sidebar" id="sidebarList"></div>
    <div class="content" id="diffContent">
      <div class="empty-state">Select a file or commit to inspect word-by-word diffs</div>
    </div>
  </div>

  <script>
    let currentRepo = '';
    let currentTab = 'working';
    let selectedItem = null;

    function decodeGitOctalOnly(str) {
      if (!str || !str.includes('\\\\')) return str;
      return str.replace(/((?:\\\\[0-7]{3})+)/g, function(match) {
        try {
          var octals = match.match(/\\\\[0-7]{3}/g);
          var bytes = new Uint8Array(octals.map(function(o) { return parseInt(o.slice(1), 8); }));
          return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
          return match;
        }
      });
    }

    async function fetchJson(url) {
      const res = await fetch(url);
      return res.json();
    }

    async function loadRepos() {
      const repos = await fetchJson('/__git/api/repos');
      const select = document.getElementById('repoSelect');
      select.innerHTML = '';
      if (repos.length === 0) {
        select.innerHTML = '<option value="">No Git repos found</option>';
        return;
      }
      repos.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.path;
        opt.textContent = r.name;
        select.appendChild(opt);
      });
      currentRepo = repos[0].path;
      loadView();
    }

    async function loadView() {
      if (!currentRepo) return;
      if (currentTab === 'working') {
        loadWorkingChanges();
      } else {
        loadCommitHistory();
      }
    }

    async function loadWorkingChanges() {
      const data = await fetchJson('/__git/api/status?repo=' + encodeURIComponent(currentRepo));
      document.getElementById('branchBadge').textContent = data.branch;
      const sidebar = document.getElementById('sidebarList');
      sidebar.innerHTML = '';

      if (data.files.length === 0) {
        sidebar.innerHTML = '<div style="padding:1.5rem; color:#6e7681; font-size:0.83rem; text-align:center;">Working tree clean ✨</div>';
        document.getElementById('diffContent').innerHTML = '<div class="empty-state">No uncommitted changes in this project ✨</div>';
        return;
      }

      data.files.forEach((f, idx) => {
        const item = document.createElement('div');
        item.className = 'file-item' + (selectedItem === f.path ? ' selected' : '');
        const statusLetter = f.index !== ' ' && f.index !== '?' ? f.index : (f.workTree || '?');
        const badgeClass = statusLetter === 'M' ? 'badge-M' : (statusLetter === 'D' ? 'badge-D' : 'badge-A');
        
        const cleanName = decodeGitOctalOnly(f.path);
        item.innerHTML = '<span style="word-break:break-all;">' + escapeHtml(cleanName) + '</span><span class="status-badge ' + badgeClass + '">' + statusLetter + '</span>';
        item.onclick = () => {
          selectedItem = f.path;
          document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          showDiff(f.path, cleanName);
        };
        sidebar.appendChild(item);
        if (idx === 0 && !selectedItem) item.click();
      });
    }

    async function loadCommitHistory() {
      const commits = await fetchJson('/__git/api/log?limit=40&repo=' + encodeURIComponent(currentRepo));
      const sidebar = document.getElementById('sidebarList');
      sidebar.innerHTML = '';

      commits.forEach((c, idx) => {
        const item = document.createElement('div');
        item.className = 'commit-item' + (selectedItem === c.fullHash ? ' selected' : '');
        item.innerHTML = '<div style="width:100%;"><div style="font-weight:600; color:#ffffff; word-break:break-word;">' + escapeHtml(c.message) + '</div><div style="font-size:0.74rem; color:#858585; margin-top:3px;">' + c.hash + ' • ' + escapeHtml(c.author) + ' • ' + c.time + '</div></div>';
        item.onclick = () => {
          selectedItem = c.fullHash;
          document.querySelectorAll('.commit-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          showCommitDiff(c.fullHash, c.message);
        };
        sidebar.appendChild(item);
        if (idx === 0 && !selectedItem) item.click();
      });
    }

    async function showDiff(filePath, cleanName) {
      const res = await fetch('/__git/api/diff?repo=' + encodeURIComponent(currentRepo) + '&file=' + encodeURIComponent(filePath));
      const text = await res.text();
      renderSingleFileDiff(text, cleanName || filePath);
    }

    async function showCommitDiff(hash, msg) {
      const res = await fetch('/__git/api/diff?repo=' + encodeURIComponent(currentRepo) + '&commit=' + encodeURIComponent(hash));
      const text = await res.text();
      renderCommitMultiDiff(text, hash, msg);
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function highlightWordDiff(delLine, addLine) {
      const delWords = delLine.split(/(\\s+|[^a-zA-Z0-9_\\u0400-\\u04FF])/);
      const addWords = addLine.split(/(\\s+|[^a-zA-Z0-9_\\u0400-\\u04FF])/);

      let delHtml = '';
      let addHtml = '';

      let i = 0, j = 0;
      while (i < delWords.length || j < addWords.length) {
        if (i < delWords.length && j < addWords.length && delWords[i] === addWords[j]) {
          delHtml += escapeHtml(delWords[i]);
          addHtml += escapeHtml(addWords[j]);
          i++; j++;
        } else {
          if (i < delWords.length) {
            delHtml += '<del>' + escapeHtml(delWords[i]) + '</del>';
            i++;
          }
          if (j < addWords.length) {
            addHtml += '<ins>' + escapeHtml(addWords[j]) + '</ins>';
            j++;
          }
        }
      }
      return { delHtml, addHtml };
    }

    function renderDiffLinesHtml(lines) {
      let html = '<div class="diff-lines">';
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith('@@')) {
          html += '<div class="diff-line info"><span class="diff-num"> </span><span class="diff-code">' + escapeHtml(line) + '</span></div>';
          i++;
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity index') || line.startsWith('rename ')) {
          html += '<div class="diff-line meta"><span class="diff-num"> </span><span class="diff-code">' + escapeHtml(line) + '</span></div>';
          i++;
        } else if (line.startsWith('-') && i + 1 < lines.length && lines[i + 1].startsWith('+')) {
          const { delHtml, addHtml } = highlightWordDiff(line.slice(1), lines[i + 1].slice(1));
          html += '<div class="diff-line del"><span class="diff-num">-</span><span class="diff-code">' + delHtml + '</span></div>';
          html += '<div class="diff-line add"><span class="diff-num">+</span><span class="diff-code">' + addHtml + '</span></div>';
          i += 2;
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          html += '<div class="diff-line add"><span class="diff-num">+</span><span class="diff-code">' + escapeHtml(line.slice(1)) + '</span></div>';
          i++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          html += '<div class="diff-line del"><span class="diff-num">-</span><span class="diff-code">' + escapeHtml(line.slice(1)) + '</span></div>';
          i++;
        } else {
          const content = line.startsWith(' ') ? line.slice(1) : line;
          html += '<div class="diff-line"><span class="diff-num"> </span><span class="diff-code">' + escapeHtml(content) + '</span></div>';
          i++;
        }
      }
      html += '</div>';
      return html;
    }

    function renderSingleFileDiff(diffText, title) {
      const container = document.getElementById('diffContent');
      if (!diffText.trim()) {
        container.innerHTML = '<div class="empty-state">No diff for ' + escapeHtml(title) + '</div>';
        return;
      }
      diffText = decodeGitOctalOnly(diffText);
      const lines = diffText.split('\\n');

      let html = '<div class="file-diff-card">';
      html += '<div class="file-diff-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
      html += '<div class="file-title-left"><span class="file-chevron">▼</span><span>📄 ' + escapeHtml(title) + '</span></div>';
      html += '</div>';
      html += '<div class="file-diff-body">' + renderDiffLinesHtml(lines) + '</div>';
      html += '</div>';

      container.innerHTML = html;
    }

    function parseMultiFileDiff(rawText) {
      rawText = decodeGitOctalOnly(rawText);

      let commitHeader = '';
      let bodyText = rawText;

      const firstDiffIdx = rawText.indexOf('diff --git ');
      if (firstDiffIdx > 0) {
        commitHeader = rawText.substring(0, firstDiffIdx).trim();
        bodyText = rawText.substring(firstDiffIdx);
      } else if (firstDiffIdx === -1 && rawText.startsWith('commit ')) {
        commitHeader = rawText.trim();
        bodyText = '';
      }

      const files = [];
      if (bodyText) {
        const rawChunks = bodyText.split(/(?=diff --git )/);
        for (const chunk of rawChunks) {
          if (!chunk.trim()) continue;
          const lines = chunk.split('\\n');
          let filePath = '';
          const m = lines[0].match(/diff --git a\\/(.*?) b\\/(.*)/);
          if (m) {
            filePath = m[2];
          } else {
            filePath = lines[0].replace('diff --git ', '');
          }

          let adds = 0, dels = 0;
          for (const l of lines) {
            if (l.startsWith('+') && !l.startsWith('+++')) adds++;
            if (l.startsWith('-') && !l.startsWith('---')) dels++;
          }

          files.push({ filePath: filePath.trim(), adds, dels, lines });
        }
      }

      return { commitHeader, files };
    }

    function renderCommitMultiDiff(diffText, hash, message) {
      const container = document.getElementById('diffContent');
      if (!diffText.trim()) {
        container.innerHTML = '<div class="empty-state">No changes in commit ' + hash.substring(0, 8) + '</div>';
        return;
      }

      const { commitHeader, files } = parseMultiFileDiff(diffText);

      let html = '';

      html += '<div class="commit-meta-box">';
      html += '<div class="commit-meta-title">' + escapeHtml(message) + '</div>';
      
      let headerDetailsHtml = '';
      if (commitHeader) {
        const metaLines = commitHeader.split('\\n');
        metaLines.forEach(ml => {
          if (ml.startsWith('Author:') || ml.startsWith('CommitDate:') || ml.startsWith('Date:') || ml.startsWith('commit ')) {
            headerDetailsHtml += '<div>' + escapeHtml(ml) + '</div>';
          }
        });
      }
      html += '<div class="commit-meta-details">' + (headerDetailsHtml || '<span>Commit ' + hash + '</span>') + '</div>';

      html += '<div class="commit-toolbar">';
      html += '<span style="font-size:0.78rem; font-weight:600; color:#ffffff;">📁 ' + files.length + ' changed file' + (files.length === 1 ? '' : 's') + '</span>';
      html += '<div style="display:flex; gap:0.4rem;">';
      html += '<button class="toolbar-btn" onclick="document.querySelectorAll(\\'.file-diff-card\\').forEach(c => c.classList.remove(\\'collapsed\\'))">Expand All</button>';
      html += '<button class="toolbar-btn" onclick="document.querySelectorAll(\\'.file-diff-card\\').forEach(c => c.classList.add(\\'collapsed\\'))">Collapse All</button>';
      html += '</div></div>';
      html += '</div>';

      if (files.length === 0) {
        html += '<div class="empty-state">No file diffs to display</div>';
      } else {
        files.forEach(f => {
          html += '<div class="file-diff-card">';
          html += '<div class="file-diff-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
          html += '<div class="file-title-left"><span class="file-chevron">▼</span><span>📄 ' + escapeHtml(f.filePath) + '</span></div>';
          html += '<div class="file-stats"><span class="stat-add">+' + f.adds + '</span><span class="stat-del">-' + f.dels + '</span></div>';
          html += '</div>';
          html += '<div class="file-diff-body">' + renderDiffLinesHtml(f.lines) + '</div>';
          html += '</div>';
        });
      }

      container.innerHTML = html;
    }

    document.getElementById('repoSelect').onchange = (e) => {
      currentRepo = e.target.value;
      selectedItem = null;
      loadView();
    };

    document.getElementById('tabWorking').onclick = () => {
      currentTab = 'working';
      selectedItem = null;
      document.getElementById('tabWorking').classList.add('active');
      document.getElementById('tabHistory').classList.remove('active');
      loadView();
    };

    document.getElementById('tabHistory').onclick = () => {
      currentTab = 'history';
      selectedItem = null;
      document.getElementById('tabHistory').classList.add('active');
      document.getElementById('tabWorking').classList.remove('active');
      loadView();
    };

    document.getElementById('btnRefresh').onclick = loadView;

    loadRepos();
  </script>
</body>
</html>`);
}

// -------------------------------------------------------------
// 3. Port Auto-Discovery & Zero-Leak Sockets
// -------------------------------------------------------------
function testPort(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: TARGET_HOST,
      port: port,
      path: '/',
      method: 'GET',
      headers: { host: `localhost:${port}`, connection: 'close' },
      agent: false,
      rejectUnauthorized: false,
      timeout: 300
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { 
      req.destroy(); 
      resolve(false); 
    });
    req.end();
  });
}

async function probeAndFindPort() {
  try {
    const output = execSync('lsof -iTCP -sTCP:LISTEN -P -n', { encoding: 'utf8' });
    const lines = output.split('\n');
    const candidatePorts = [];

    for (const l of lines) {
      if (l.includes('language_') || l.includes('Antigravi')) {
        const m = l.match(/:(\d+)\s+\(LISTEN\)/);
        if (m) {
          const port = parseInt(m[1], 10);
          if (port && port !== LISTEN_PORT && !candidatePorts.includes(port)) {
            candidatePorts.push(port);
          }
        }
      }
    }

    for (const p of candidatePorts) {
      if (await testPort(p)) {
        if (cachedTargetPort !== p) {
          console.log(`[Auto-Discovery] 🎯 Verified active Antigravity backend on port: ${p}`);
          cachedTargetPort = p;
        }
        return p;
      }
    }
  } catch (e) {}

  return null;
}

setInterval(async () => {
  if (isDiscovering) return;
  isDiscovering = true;
  try {
    if (cachedTargetPort) {
      if (Date.now() - lastRequestTime > 10000) {
        const stillAlive = await testPort(cachedTargetPort);
        if (!stillAlive) {
          console.log(`[Auto-Discovery] ⚠️ Port ${cachedTargetPort} became unreachable, searching for new port...`);
          cachedTargetPort = null;
          await probeAndFindPort();
        }
      }
    } else {
      await probeAndFindPort();
    }
  } finally {
    isDiscovering = false;
  }
}, 10000);

async function getAntigravityPort() {
  if (cachedTargetPort) return cachedTargetPort;
  return await probeAndFindPort();
}

const agent = new https.Agent({ 
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 32,
  maxFreeSockets: 4,
  timeout: 10000
});

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
  });
  return list;
}

function isAuthenticated(req) {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const tokenQuery = reqUrl.searchParams.get('token');
    if (tokenQuery === SECRET_TOKEN) return true;
  } catch (e) {}

  const cookies = parseCookies(req.headers.cookie);
  if (cookies.ag_auth === SECRET_TOKEN) return true;

  return false;
}

function renderLoginPage(res, errorMsg = '') {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Protected Antigravity Session</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #181818; color: #cccccc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #252526; border: 1px solid #333333; border-radius: 8px; padding: 2rem; width: 100%; max-width: 360px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; }
        h2 { margin-top: 0; font-size: 1.15rem; color: #ffffff; }
        input[type="password"] { width: 100%; padding: 0.75rem; border-radius: 4px; border: 1px solid #3c3c3c; background: #1e1e1e; color: #fff; margin: 1rem 0; box-sizing: border-box; font-size: 1rem; }
        input[type="password"]:focus { outline: 1px solid #007acc; }
        button { width: 100%; padding: 0.75rem; border-radius: 4px; border: none; background: #007acc; color: white; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
        button:hover { background: #0062a3; }
        .error { color: #f85149; font-size: 0.85rem; margin-bottom: 1rem; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🔒 Protected Access</h2>
        <p style="font-size:0.85rem; color:#858585;">Enter passkey to access this Antigravity session.</p>
        ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
        <form method="POST" action="/__auth">
          <input type="password" name="password" placeholder="Passkey" autofocus required />
          <button type="submit">Unlock</button>
        </form>
      </div>
    </body>
    </html>
  `);
}

function prepareUpstreamHeaders(incomingHeaders, targetPort) {
  const headers = {};
  for (const [key, val] of Object.entries(incomingHeaders)) {
    if (!key.startsWith(':')) {
      headers[key] = val;
    }
  }

  const targetAuthority = `localhost:${targetPort}`;
  headers.host = targetAuthority;
  headers['x-forwarded-host'] = targetAuthority;
  headers['x-forwarded-server'] = targetAuthority;
  headers['x-forwarded-proto'] = 'https';
  headers['accept-encoding'] = 'identity';

  if (headers.origin) {
    headers.origin = `https://${targetAuthority}`;
  }
  if (headers.referer) {
    try {
      const refUrl = new URL(headers.referer);
      refUrl.protocol = 'https:';
      refUrl.host = targetAuthority;
      headers.referer = refUrl.toString();
    } catch (e) {}
  }

  return headers;
}

const INJECTED_DRAWER_SNIPPET = `
<!-- 🌿 Antigravity Git Drawer -->
<div id="__ag_git_fab" style="position:fixed;bottom:18px;right:18px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <button onclick="window.__toggleAgGit()" style="background:#007acc;color:#fff;border:none;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,0.5);cursor:pointer;display:flex;align-items:center;gap:6px;">
    🌿 Git Inspector
  </button>
</div>
<div id="__ag_git_overlay" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);z-index:9999998;" onclick="window.__toggleAgGit()"></div>
<div id="__ag_git_drawer" style="position:fixed;top:0;right:-100vw;width:min(1150px, 95vw);height:100vh;background:#181818;box-shadow:-8px 0 30px rgba(0,0,0,0.8);z-index:9999999;transition:right 0.25s ease;display:flex;flex-direction:column;">
  <!-- Left resize drag handle -->
  <div id="__ag_git_resizer" style="position:absolute;top:0;left:0;width:10px;height:100%;cursor:col-resize;user-select:none;z-index:10000000;background:transparent;" title="Drag to resize width"></div>
  
  <div style="padding:8px 16px;background:#252526;border-bottom:1px solid #2d2d2d;display:flex;justify-content:space-between;align-items:center;">
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="font-weight:600;color:#ffffff;font-size:13px;">🌿 Git Live Inspector</span>
      <button onclick="window.__toggleFullscreenGit()" id="__ag_git_expand_btn" style="background:#333333;color:#cccccc;border:none;padding:3px 8px;border-radius:3px;font-size:11px;cursor:pointer;" title="Toggle Fullscreen">⛶ Fullscreen</button>
    </div>
    <button onclick="window.__toggleAgGit()" style="background:transparent;border:none;color:#858585;font-size:18px;cursor:pointer;padding:0 6px;">✕</button>
  </div>
  <iframe src="/__git" style="flex:1;border:none;width:100%;height:100%;"></iframe>
</div>
<script>
  (function() {
    var drawer = document.getElementById('__ag_git_drawer');
    var overlay = document.getElementById('__ag_git_overlay');
    var resizer = document.getElementById('__ag_git_resizer');
    var isExpanded = false;
    var defaultWidth = Math.min(1150, window.innerWidth * 0.95) + 'px';

    window.__toggleAgGit = function() {
      if (drawer.style.right === '0px') {
        drawer.style.right = '-100vw';
        overlay.style.display = 'none';
      } else {
        drawer.style.right = '0px';
        overlay.style.display = 'block';
      }
    };

    window.__toggleFullscreenGit = function() {
      var btn = document.getElementById('__ag_git_expand_btn');
      if (!isExpanded) {
        drawer.style.width = '100vw';
        btn.textContent = '⤢ Restore';
        isExpanded = true;
      } else {
        drawer.style.width = defaultWidth;
        btn.textContent = '⛶ Fullscreen';
        isExpanded = false;
      }
    };

    var isDragging = false;
    resizer.addEventListener('mousedown', function(e) {
      isDragging = true;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      var newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 450 && newWidth <= window.innerWidth) {
        drawer.style.width = newWidth + 'px';
      }
    });

    window.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        document.body.style.userSelect = '';
      }
    });
  })();
</script>
`;

async function handleAuthAndProxy(req, res) {
  lastRequestTime = Date.now();

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && req.url === '/__auth') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const submittedToken = params.get('password');
      if (submittedToken === SECRET_TOKEN) {
        res.writeHead(302, {
          'Set-Cookie': `ag_auth=${SECRET_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
          'Location': '/'
        });
        return res.end();
      } else {
        return renderLoginPage(res, 'Incorrect passkey!');
      }
    });
    return;
  }

  if (reqUrl.searchParams.get('token') === SECRET_TOKEN) {
    reqUrl.searchParams.delete('token');
    const cleanPath = reqUrl.pathname + (reqUrl.search ? reqUrl.search : '');
    res.writeHead(302, {
      'Set-Cookie': `ag_auth=${SECRET_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
      'Location': cleanPath || '/'
    });
    return res.end();
  }

  if (!isAuthenticated(req)) {
    return renderLoginPage(res);
  }

  if (reqUrl.pathname === '/__git') {
    return renderGitUi(res);
  }
  if (reqUrl.pathname.startsWith('/__git/api/')) {
    return handleGitApi(req, res, reqUrl);
  }

  const currentTargetPort = await getAntigravityPort();
  if (!currentTargetPort) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`
      <div style="font-family:sans-serif; text-align:center; padding:3rem; background:#181818; color:#cccccc; height:100vh; box-sizing:border-box;">
        <h2>⏳ Backend Unavailable</h2>
        <p style="color:#858585;">Antigravity backend server is currently starting up or not running.</p>
        <p style="font-size:0.85rem; color:#6e7681;">The proxy will auto-connect as soon as the server is ready.</p>
      </div>
    `);
  }

  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 1000);
  }

  const reqOptions = {
    hostname: TARGET_HOST,
    port: currentTargetPort,
    path: req.url,
    method: req.method,
    headers: prepareUpstreamHeaders(req.headers, currentTargetPort),
    agent: agent,
  };

  let proxyResEnded = false;

  const proxyReq = https.request(reqOptions, (proxyRes) => {
    if (proxyRes.socket) {
      proxyRes.socket.setTimeout(0);
      proxyRes.socket.setNoDelay(true);
      proxyRes.socket.setKeepAlive(true, 1000);
    }

    const respHeaders = { ...proxyRes.headers };
    for (const k of Object.keys(respHeaders)) {
      if (k.startsWith(':')) {
        delete respHeaders[k];
      }
    }

    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    if (isHtml) {
      delete respHeaders['content-length'];
      delete respHeaders['content-encoding'];
      res.writeHead(proxyRes.statusCode, respHeaders);

      const chunks = [];
      proxyRes.on('data', chunk => { chunks.push(chunk); });
      proxyRes.on('end', () => {
        proxyResEnded = true;
        let buffer = Buffer.concat(chunks);
        const encoding = proxyRes.headers['content-encoding'];

        try {
          if (encoding === 'gzip') {
            buffer = zlib.gunzipSync(buffer);
          } else if (encoding === 'deflate') {
            buffer = zlib.inflateSync(buffer);
          } else if (encoding === 'br') {
            buffer = zlib.brotliDecompressSync(buffer);
          }
        } catch (e) {}

        let body = buffer.toString('utf8');
        if (body.includes('</body>')) {
          body = body.replace('</body>', `${INJECTED_DRAWER_SNIPPET}</body>`);
        } else {
          body += INJECTED_DRAWER_SNIPPET;
        }
        res.end(body);
      });
      return;
    }

    res.writeHead(proxyRes.statusCode, respHeaders);
    if (res.flushHeaders) {
      res.flushHeaders();
    }

    proxyRes.on('end', () => {
      proxyResEnded = true;
    });

    proxyRes.on('close', () => {
      proxyResEnded = true;
    });

    proxyRes.pipe(res);
  });

  res.on('close', () => {
    if (!proxyResEnded && !proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });

  req.on('aborted', () => {
    if (!proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });

  proxyReq.on('error', (err) => {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      cachedTargetPort = null;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy Error: ' + err.message);
    }
  });

  req.pipe(proxyReq);
}

const server = http.createServer(handleAuthAndProxy);
server.timeout = 0;
server.keepAliveTimeout = 0;

server.on('upgrade', async (req, socket, head) => {
  lastRequestTime = Date.now();

  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const currentTargetPort = await getAntigravityPort();
  if (!currentTargetPort) {
    socket.write('HTTP/1.1 530 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  socket.setTimeout(0);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);

  const headers = prepareUpstreamHeaders(req.headers, currentTargetPort);

  const targetSocket = tls.connect({
    host: TARGET_HOST,
    port: currentTargetPort,
    rejectUnauthorized: false
  }, () => {
    targetSocket.setTimeout(0);
    targetSocket.setNoDelay(true);
    targetSocket.setKeepAlive(true, 1000);

    let reqStr = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      reqStr += `${key}: ${value}\r\n`;
    }
    reqStr += '\r\n';
    targetSocket.write(reqStr);
    if (head && head.length) {
      targetSocket.write(head);
    }
    targetSocket.pipe(socket);
    socket.pipe(targetSocket);
  });

  const cleanup = () => {
    if (!socket.destroyed) socket.destroy();
    if (!targetSocket.destroyed) targetSocket.destroy();
  };

  socket.on('close', cleanup);
  socket.on('end', cleanup);
  socket.on('error', cleanup);

  targetSocket.on('close', cleanup);
  targetSocket.on('end', cleanup);
  targetSocket.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      cachedTargetPort = null;
    }
    cleanup();
  });
});

function launchCloudflareTunnel() {
  if (CUSTOM_DOMAIN) {
    console.log(`🌐 Launching Cloudflare Named Tunnel for https://${CUSTOM_DOMAIN}...`);
    tunnelProcess = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--protocol', 'http2', '--no-autoupdate', 'run', TUNNEL_NAME], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } else {
    console.log(`🌐 Launching Cloudflare Quick Tunnel (Unlimited Bandwidth)...`);
    const quickEnv = { ...process.env };
    delete quickEnv.TUNNEL_NAME;
    delete quickEnv.TUNNEL_CRED_FILE;
    delete quickEnv.TUNNEL_ORIGIN_CERT;
    delete quickEnv.TUNNEL_CONFIG;
    tunnelProcess = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--protocol', 'http2', '--no-autoupdate', '--config', '/dev/null', '--url', `http://127.0.0.1:${LISTEN_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: quickEnv
    });
  }

  let tunnelOutputAcc = '';
  const handleTunnelOutput = (chunk) => {
    const str = chunk.toString();
    tunnelOutputAcc += str;

    const tryMatch = tunnelOutputAcc.match(/https:\/\/[^\s"'<>]+\.trycloudflare\.com/i);
    if (tryMatch && !quickTunnelUrl) {
      quickTunnelUrl = tryMatch[0].replace(/[|\s]+$/, '');
      console.log(`\n=============================================================`);
      console.log(`🚀 PUBLIC CLOUDFLARE QUICK TUNNEL READY!`);
      console.log(`🌐 Public URL: ${quickTunnelUrl}`);
      console.log(`🌿 Direct Git UI: ${quickTunnelUrl}/__git`);
      console.log(`👉 Instant Auth Link: ${quickTunnelUrl}/?token=${SECRET_TOKEN}`);
      console.log(`=============================================================\n`);
      return;
    }

    const isBenignNotice = (line) => {
      return (
        line.includes('error code 0') ||
        line.includes('canceled by remote') ||
        line.includes('context canceled') ||
        line.includes('ended abruptly') ||
        line.includes('/dev/null was empty')
      );
    };

    if (CUSTOM_DOMAIN) {
      const cleanLines = str.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of cleanLines) {
        if (!isBenignNotice(line) && (line.includes('ERR') || line.includes('Registered tunnel') || line.includes('Retrying'))) {
          console.log(`[tunnel] ${line}`);
        }
      }
    } else if (!quickTunnelUrl) {
      const cleanLines = str.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of cleanLines) {
        if (!isBenignNotice(line)) {
          console.log(`[tunnel] ${line}`);
        }
      }
    }
  };

  tunnelProcess.stdout.on('data', handleTunnelOutput);
  tunnelProcess.stderr.on('data', handleTunnelOutput);

  tunnelProcess.on('error', (err) => {
    console.error(`\n❌ Failed to launch cloudflared tunnel: ${err.message}`);
  });

  tunnelProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log(`\n[tunnel] Process exited (Code ${code})`);
    }
  });
}

function shutdown() {
  console.log('\n🛑 Shutting down proxy & Cloudflare tunnel...');
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM');
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// -------------------------------------------------------------
// Main Entrypoint
// -------------------------------------------------------------
(async () => {
  ensureCloudflareConfig();

  const initialPort = await getAntigravityPort();

  server.listen(LISTEN_PORT, '0.0.0.0', () => {
    launchCloudflareTunnel();

    console.log(`\n=============================================================`);
    console.log(`🚀 ANTIGRAVITY REMOTE GATEWAY READY!`);
    console.log(`=============================================================`);
    if (initialPort) {
      console.log(`🎯 Active Antigravity Backend: 127.0.0.1:${initialPort}`);
    }
    console.log(`🔑 Passkey: ${SECRET_TOKEN}`);
    if (CUSTOM_DOMAIN) {
      console.log(`🌐 Public URL: https://${CUSTOM_DOMAIN}`);
      console.log(`🌿 Direct Git UI: https://${CUSTOM_DOMAIN}/__git`);
      console.log(`👉 Instant Auth Link: https://${CUSTOM_DOMAIN}/?token=${SECRET_TOKEN}`);
    } else {
      console.log(`⏳ Public URL: Connecting to Cloudflare Quick Tunnel (takes ~5-8s)...`);
    }
    console.log(`=============================================================\n`);
  });
})();
