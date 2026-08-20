#!/usr/bin/env node

/**
 * 🚀 Antigravity Remote Access Gateway
 * High-throughput remote proxy for Google Antigravity with Cloudflare Named Tunnels,
 * dynamic port discovery, and visual Git Inspector.
 *
 * Author: Artem Barinov
 * License: MIT
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

// -------------------------------------------------------------
// 1. Environment & Configuration
// -------------------------------------------------------------
const ENV_FILE = path.join(__dirname, '.env');

function loadEnv() {
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    lines.forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...rest] = line.split('=');
        if (key && rest.length) {
          process.env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    });
  }
}
loadEnv();

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

// Defaults
const SECRET_TOKEN = process.env.SECRET_TOKEN || crypto.randomBytes(8).toString('hex');
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || null;
const TUNNEL_NAME = process.env.TUNNEL_NAME || 'antigravity-tunnel';

// -------------------------------------------------------------
// 2. Cloudflare Named Tunnel Auto-Provisioning
// -------------------------------------------------------------
const CLOUDFLARED_DIR = path.join(os.homedir(), '.cloudflared');
const CERT_FILE = path.join(CLOUDFLARED_DIR, 'cert.pem');
const CONFIG_FILE = path.join(CLOUDFLARED_DIR, 'config.yml');

function ensureCloudflareConfig() {
  if (!CUSTOM_DOMAIN) return;

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
// 3. Modular Git Inspector (Imported from git-inspector.js)
// -------------------------------------------------------------
const {
  findGitRepos,
  executeGit,
  decodeGitOctalOnly,
  handleGitApi,
  renderGitUi,
  getInjectedDrawerSnippet
} = require('./git-inspector.js');

// -------------------------------------------------------------
// 4. Port Auto-Discovery & Zero-Leak Sockets
// -------------------------------------------------------------
function testPort(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: TARGET_HOST,
      port: port,
      path: '/',
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 1000
    }, (res) => {
      res.resume();
      resolve(true);
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
          cachedTargetPort = p;
          console.log(`[Auto-Discovery] 🎯 Verified active Antigravity backend on port: ${p}`);
        }
        return p;
      }
    }
  } catch (e) {}

  return null;
}

let cachedTargetPort = null;
let isDiscovering = false;
let lastRequestTime = Date.now();

setInterval(async () => {
  if (Date.now() - lastRequestTime > 120000 && cachedTargetPort) {
    return;
  }

  if (isDiscovering) return;
  isDiscovering = true;
  try {
    if (cachedTargetPort) {
      const stillAlive = await testPort(cachedTargetPort);
      if (!stillAlive) {
        cachedTargetPort = null;
        await probeAndFindPort();
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

// -------------------------------------------------------------
// 5. HTTP Proxy & Request Router
// -------------------------------------------------------------
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
    return renderGitUi(res, reqUrl);
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

  const headers = prepareUpstreamHeaders(req.headers, currentTargetPort);
  let proxyResEnded = false;

  const proxyReq = https.request({
    hostname: TARGET_HOST,
    port: currentTargetPort,
    path: req.url,
    method: req.method,
    headers: headers,
    agent: agent,
    rejectUnauthorized: false,
    timeout: 0
  }, (proxyRes) => {
    const respHeaders = { ...proxyRes.headers };
    delete respHeaders['transfer-encoding'];

    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    if (isHtml && proxyRes.statusCode === 200) {
      delete respHeaders['content-length'];
      delete respHeaders['content-encoding'];
      delete respHeaders['accept-ranges'];

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
        const drawerSnippet = getInjectedDrawerSnippet();
        if (body.includes('</body>')) {
          body = body.replace('</body>', `${drawerSnippet}</body>`);
        } else {
          body += drawerSnippet;
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

let tunnelProcess = null;
let quickTunnelUrl = null;

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
if (require.main === module) {
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
}

module.exports = {
  findGitRepos,
  executeGit,
  decodeGitOctalOnly,
  handleGitApi,
  renderGitUi,
  getInjectedDrawerSnippet,
  prepareUpstreamHeaders,
  parseCookies,
  isAuthenticated,
  handleAuthAndProxy,
  server,
  SECRET_TOKEN,
  LISTEN_PORT,
  CUSTOM_DOMAIN
};
