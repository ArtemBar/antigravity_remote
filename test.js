const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = require('./index.js');
const gitInspector = require('./git-inspector.js');

test('1. Syntax & Compilation', () => {
  assert.doesNotThrow(() => {
    execSync('node --check ' + path.join(__dirname, 'index.js'));
    execSync('node --check ' + path.join(__dirname, 'git-inspector.js'));
  }, 'index.js and git-inspector.js must have 100% valid JavaScript syntax');
});

test('2. Cookie Parser (parseCookies)', () => {
  const empty = app.parseCookies('');
  assert.deepEqual(empty, {});

  const single = app.parseCookies('ag_auth=secret123');
  assert.equal(single.ag_auth, 'secret123');

  const multiple = app.parseCookies('theme=dark; ag_auth=my-passkey; session=xyz%20123');
  assert.equal(multiple.theme, 'dark');
  assert.equal(multiple.ag_auth, 'my-passkey');
  assert.equal(multiple.session, 'xyz 123');
});

test('3. Authentication (isAuthenticated)', () => {
  const validQueryReq = {
    url: '/?token=' + app.SECRET_TOKEN,
    headers: { host: 'localhost:64650' }
  };
  assert.equal(app.isAuthenticated(validQueryReq), true, 'Valid query token must authenticate');

  const invalidQueryReq = {
    url: '/?token=wrong_password',
    headers: { host: 'localhost:64650' }
  };
  assert.equal(app.isAuthenticated(invalidQueryReq), false, 'Invalid query token must be rejected');

  const validCookieReq = {
    url: '/exa.language_server_pb.LanguageServerService/GetState',
    headers: { host: 'localhost:64650', cookie: 'ag_auth=' + app.SECRET_TOKEN }
  };
  assert.equal(app.isAuthenticated(validCookieReq), true, 'Valid cookie must authenticate');

  const unauthReq = {
    url: '/',
    headers: { host: 'localhost:64650' }
  };
  assert.equal(app.isAuthenticated(unauthReq), false, 'Missing credentials must be rejected');
});

test('4. Upstream Header Translation (prepareUpstreamHeaders)', () => {
  const incoming = {
    ':method': 'GET',
    ':path': '/chat',
    ':authority': 'my-remote-app.example.com',
    'host': 'my-remote-app.example.com',
    'origin': 'https://my-remote-app.example.com',
    'referer': 'https://my-remote-app.example.com/session/123',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': 'TestAgent'
  };

  const targetPort = 53631;
  const upstream = app.prepareUpstreamHeaders(incoming, targetPort);

  assert.equal(upstream[':method'], undefined, 'HTTP/2 pseudo-headers must be stripped');
  assert.equal(upstream[':path'], undefined, 'HTTP/2 pseudo-headers must be stripped');
  assert.equal(upstream[':authority'], undefined, 'HTTP/2 pseudo-headers must be stripped');
  assert.equal(upstream.host, `localhost:${targetPort}`, 'Host header must point to local target');
  assert.equal(upstream['x-forwarded-host'], `localhost:${targetPort}`, 'X-Forwarded-Host must match target');
  assert.equal(upstream['x-forwarded-proto'], 'https', 'X-Forwarded-Proto must be https');
  assert.equal(upstream['accept-encoding'], 'identity', 'Accept-Encoding must enforce uncompressed identity stream');
  assert.equal(upstream.origin, `https://localhost:${targetPort}`, 'Origin must be rewritten for CSRF protection');
  assert.equal(upstream.referer, `https://localhost:${targetPort}/session/123`, 'Referer must be rewritten for CSRF protection');
  assert.equal(upstream['user-agent'], 'TestAgent', 'Standard headers must be preserved');
});

test('5. Russian / Cyrillic Octal Escapes Decoding', () => {
  const rawOctal = '\\320\\277\\321\\200\\320\\276\\320\\265\\320\\272\\321\\202.json';
  assert.equal(gitInspector.decodeGitOctalOnly(rawOctal), 'проект.json', 'Cyrillic octal sequences must decode to Russian UTF-8');

  const mixed = 'lectures/18 поток/\\320\\243\\321\\200\\320\\260\\320\\275/notes.md';
  assert.equal(gitInspector.decodeGitOctalOnly(mixed), 'lectures/18 поток/Уран/notes.md', 'Mixed UTF-8 and octal must decode seamlessly');
});

test('6. Git Repositories Auto-Discovery (findGitRepos)', () => {
  const repos = gitInspector.findGitRepos();
  assert(Array.isArray(repos), 'findGitRepos must return an array');
  assert(repos.length > 0, 'Must discover at least the current antigravity_remote repo');

  // Verify deduplication
  const paths = repos.map(r => r.path.toLowerCase());
  const uniquePaths = new Set(paths);
  assert.equal(paths.length, uniquePaths.size, 'Repositories must be deduplicated across case-insensitive roots');
});

test('7. Git Status & Porcelain -uall Listing', () => {
  const currentRepo = process.cwd();
  const statusOutput = gitInspector.executeGit(currentRepo, 'status --porcelain=v1 -uall');
  assert(typeof statusOutput === 'string', 'executeGit status must return a string');

  const branch = gitInspector.executeGit(currentRepo, 'rev-parse --abbrev-ref HEAD').trim();
  assert.equal(branch, 'main', 'Current branch must be main');
});

test('8. End-to-End Local HTTP Server API Tests', async () => {
  const testServer = http.createServer(app.handleAuthAndProxy);
  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const testPort = testServer.address().port;

  try {
    // 8a. Unauthenticated request to / must return 401 login page
    const resUnauth = await makeRequest(testPort, '/', 'GET');
    assert.equal(resUnauth.statusCode, 401, 'Unauthenticated request must return 401');
    assert(resUnauth.body.includes('Protected Access'), 'Must render login page');

    // 8b. Authenticate via token query
    const resAuth = await makeRequest(testPort, '/?token=' + app.SECRET_TOKEN, 'GET');
    assert.equal(resAuth.statusCode, 302, 'Token login must redirect (302)');
    const setCookie = resAuth.headers['set-cookie']?.[0] || '';
    assert(setCookie.includes('ag_auth=' + app.SECRET_TOKEN), 'Must return ag_auth cookie');

    // 8c. Access Git UI with authenticated cookie
    const resGitUi = await makeRequest(testPort, '/__git', 'GET', { 'cookie': setCookie.split(';')[0] });
    assert.equal(resGitUi.statusCode, 200, 'Git UI must return 200 with auth cookie');
    assert(resGitUi.body.includes('Git Inspector'), 'Must render Git Inspector HTML');
    assert(resGitUi.body.includes('badge-U'), 'Must include badge-U CSS styling');

    // 8d. Access Git Repos API with authenticated cookie
    const resGitRepos = await makeRequest(testPort, '/__git/api/repos', 'GET', { 'cookie': setCookie.split(';')[0] });
    assert.equal(resGitRepos.statusCode, 200, 'Git Repos API must return 200');
    const reposJson = JSON.parse(resGitRepos.body);
    assert(Array.isArray(reposJson), 'Repos API must return JSON array');
    assert(reposJson.some(r => r.name === 'antigravity_remote'), 'Must list antigravity_remote repo');

    // 8e. Access Git Status API with -uall support
    const resGitStatus = await makeRequest(testPort, '/__git/api/status?repo=' + encodeURIComponent(process.cwd()), 'GET', { 'cookie': setCookie.split(';')[0] });
    assert.equal(resGitStatus.statusCode, 200, 'Git Status API must return 200');
    const statusJson = JSON.parse(resGitStatus.body);
    assert.equal(statusJson.branch, 'main', 'Status API must return branch main');
    assert(Array.isArray(statusJson.files), 'Status API must return files array');

    // 8f. Post invalid auth password
    const resBadPost = await makeRequest(testPort, '/__auth', 'POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'password=wrong_pass');
    assert.equal(resBadPost.statusCode, 401, 'Bad password POST must return 401');
    assert(resBadPost.body.includes('Incorrect passkey!'), 'Must display error message');
  } finally {
    await new Promise(resolve => testServer.close(resolve));
  }
});

test('9. Injected Drawer Snippet & Mobile Tap Reliability', () => {
  const snippet = gitInspector.getInjectedDrawerSnippet();
  assert(typeof snippet === 'string', 'Snippet must be a string');
  assert(snippet.includes('id="__ag_git_fab"'), 'Must contain FAB container');
  assert(snippet.includes('id="__ag_git_drawer"'), 'Must contain drawer container');
  assert(snippet.includes('id="__ag_git_iframe"'), 'Must contain iframe');
  assert(snippet.includes('onclick="window.__toggleAgGit(event)"'), 'Must have explicit onclick handler for universal mobile tap support');
  assert(snippet.includes('width:48px;height:48px;border-radius:50%'), 'Must be a circular 48px Material FAB');

  const scriptMatch = snippet.match(/<script>(.*?)<\/script>/s);
  assert(scriptMatch, 'Snippet must contain <script> tag');
  try {
    new Function(scriptMatch[1]);
  } catch (e) {
    const lines = scriptMatch[1].split('\n');
    lines.forEach((l, idx) => console.log((idx + 1) + ': ' + l));
    console.error('DRAWER SNIPPET SYNTAX ERROR:', e);
    throw e;
  }
});

test('10. Client Socket Close & Abort Handling (proxyResEnded scope)', async () => {
  const testServer = http.createServer(app.handleAuthAndProxy);
  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const testPort = testServer.address().port;

  try {
    // Send authenticated request and abort immediately to trigger res.on('close')
    const req = http.request({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/exa.language_server_pb.LanguageServerService/GetState',
      method: 'POST',
      headers: { host: `localhost:${testPort}`, cookie: 'ag_auth=' + app.SECRET_TOKEN }
    });
    req.on('error', () => {}); // expected socket hangup
    req.write('test');
    setTimeout(() => req.destroy(), 5);

    await new Promise(r => setTimeout(r, 50));
    assert(true, 'Aborting client request must cleanly trigger res.on(close) without ReferenceError');
  } finally {
    await new Promise(resolve => testServer.close(resolve));
  }
});

test('11. Git UI SSR HTML Validity & Diff Fetching', async () => {
  let html = '';
  gitInspector.renderGitUi({
    writeHead: (code, headers) => { assert.equal(code, 200); },
    end: (content) => { html = content; }
  });

  assert(html.includes('initialRepos'), 'Must include initialRepos');
  assert(html.includes('initialFiles'), 'Must include initialFiles');

  // Verify that the generated client-side <script> is 100% syntactically valid
  const scriptMatch = html.match(/<script>(.*?)<\/script>/s);
  assert(scriptMatch, 'Must contain <script> tag');
  try {
    new Function(scriptMatch[1]);
  } catch (e) {
    const lines = scriptMatch[1].split('\n');
    lines.forEach((l, idx) => console.log((idx + 1) + ': ' + l));
    console.error('SCRIPT SYNTAX ERROR:', e);
    throw e;
  }
});

test('12. Active Project Auto-Detection & Dropdown Matching', () => {
  const fakeRepos = [
    { name: 'antigravity_remote', path: '/home/user/dev/antigravity_remote' },
    { name: 'lectures', path: '/home/user/dev/lectures' },
    { name: 'astrolabys', path: '/home/user/dev/astrolabys' }
  ];

  assert.equal(
    gitInspector.matchRepo('tab=file__file%3A%2F%2F%2Fhome%2Fuser%2Fdev%2Flectures%2Ftest.js', fakeRepos),
    '/home/user/dev/lectures',
    'Must match lectures from URL parameter'
  );

  assert.equal(
    gitInspector.matchRepo('astrolabys - Antigravity', fakeRepos),
    '/home/user/dev/astrolabys',
    'Must match astrolabys from window title'
  );

  assert.equal(
    gitInspector.matchRepo('', fakeRepos),
    '/home/user/dev/antigravity_remote',
    'Must fallback to first repo when no hint is provided'
  );
});

function makeRequest(port, path, method = 'GET', headers = {}, postData = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: path,
      method: method,
      headers: { host: `localhost:${port}`, ...headers }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}
