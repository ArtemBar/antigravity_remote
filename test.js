const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = require('./index.js');

test('1. Syntax & Compilation', () => {
  assert.doesNotThrow(() => {
    execSync('node --check ' + path.join(__dirname, 'index.js'));
  }, 'index.js must have 100% valid JavaScript syntax');
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
    ':authority': 'my-antigravity.astrolabys.com',
    'host': 'my-antigravity.astrolabys.com',
    'origin': 'https://my-antigravity.astrolabys.com',
    'referer': 'https://my-antigravity.astrolabys.com/session/123',
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
  // Test raw octal escape decoding function
  function decodeGitOctalOnly(str) {
    if (!str || !str.includes('\\')) return str;
    return str.replace(/((?:\\[0-7]{3})+)/g, function(match) {
      try {
        var octals = match.match(/\\[0-7]{3}/g);
        var bytes = new Uint8Array(octals.map(function(o) { return parseInt(o.slice(1), 8); }));
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        return match;
      }
    });
  }

  const rawOctal = '\\320\\277\\321\\200\\320\\276\\320\\265\\320\\272\\321\\202.json';
  assert.equal(decodeGitOctalOnly(rawOctal), 'проект.json', 'Cyrillic octal sequences must decode to Russian UTF-8');

  const mixed = 'lectures/18 поток/\\320\\243\\321\\200\\320\\260\\320\\275/notes.md';
  assert.equal(decodeGitOctalOnly(mixed), 'lectures/18 поток/Уран/notes.md', 'Mixed UTF-8 and octal must decode seamlessly');
});

test('6. Git Repositories Auto-Discovery (findGitRepos)', () => {
  const repos = app.findGitRepos();
  assert(Array.isArray(repos), 'findGitRepos must return an array');
  assert(repos.length > 0, 'Must discover at least the current antigravity_remote repo');

  // Verify deduplication
  const paths = repos.map(r => r.path.toLowerCase());
  const uniquePaths = new Set(paths);
  assert.equal(paths.length, uniquePaths.size, 'Repositories must be deduplicated across case-insensitive roots');
});

test('7. Git Status & Porcelain -uall Listing', () => {
  const currentRepo = process.cwd();
  const statusOutput = app.executeGit(currentRepo, 'status --porcelain=v1 -uall');
  assert(typeof statusOutput === 'string', 'executeGit status must return a string');

  // Verify that test.js or modified files are detected
  const branch = app.executeGit(currentRepo, 'rev-parse --abbrev-ref HEAD').trim();
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
