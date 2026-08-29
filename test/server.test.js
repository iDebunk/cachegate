const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// server.js reads MODEL_ROUTER_INTERNAL_KEY / METRICS_LOG_PATH once at
// require time, so set env before requiring, and use a throwaway
// metrics file per test run so this suite never touches the real one.
process.env.MODEL_ROUTER_INTERNAL_KEY = 'test-internal-key';
process.env.METRICS_LOG_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-')),
  'metrics.jsonl'
);
// No provider keys set - tests below never exercise an actual provider
// call (that needs live API keys and real spend, and is out of scope
// for this suite; see README's "Where this leaves things").

const { app } = require('../server');

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function request(server, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, ...options },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /health is public and reports routing tiers', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(server, { method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'healthy');
  assert.ok(Array.isArray(res.body.routing_tiers));
  assert.ok(res.body.routing_tiers.includes('router:fast-cheap'));
  assert.equal(res.body.routing_strategy, 'cost'); // no ROUTER_STRATEGY set in this test suite - default applies
});

test('POST /v1/chat/completions without a key is rejected', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    { method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' } },
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }
  );
  assert.equal(res.status, 401);
});

test('POST /v1/chat/completions with the wrong key is rejected', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' }
    },
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }
  );
  assert.equal(res.status, 401);
});

test('POST /v1/chat/completions with the right key but missing fields returns 400', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' }
    },
    { model: 'gpt-4o-mini' } // messages missing
  );
  assert.equal(res.status, 400);
});

test('POST /v1/chat/completions with stream:true AND tools is rejected - tool-call streaming is out of scope', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' }
    },
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'do_thing' } }]
    }
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /stream/i);
  assert.match(res.body.error, /tools/i);
});

test('POST /v1/chat/completions with stream:true (no tools) attempts real dispatch - missing provider key is still a clean JSON 500, not a broken stream', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' }
    },
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }
  );
  // No OPENAI_API_KEY is set in this test suite (see the header comment) -
  // the missing-key check happens before SSE headers are ever written,
  // so this is a normal JSON error response, not a broken/partial stream.
  assert.equal(res.status, 500);
  assert.match(res.body.error, /OPENAI_API_KEY/);
});

test('POST /v1/chat/completions with an unsupported model name returns 400', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' }
    },
    { model: 'llama-3-70b', messages: [{ role: 'user', content: 'hi' }] }
  );
  assert.equal(res.status, 400);
});

test('POST /v1/chat/completions with a body over JSON_BODY_LIMIT returns a clean JSON error, not a stack trace', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  // Security-review finding (2026-08-29): before the catch-all error
  // handler existed, this scenario fell through to Express's own
  // default handler - a raw HTML page containing the full stack trace
  // and this server's absolute filesystem paths. Regression-guards
  // both the JSON shape and the absence of anything stack-trace-shaped.
  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' }
    },
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'a'.repeat(3 * 1024 * 1024) }] }
  );
  assert.equal(res.status, 413);
  assert.equal(typeof res.body, 'object'); // JSON, not an HTML string
  assert.equal(res.body.error, 'Request body too large.');
  assert.ok(!JSON.stringify(res.body).includes('node_modules')); // no stack trace/filesystem paths leaked
});

test('an unauthenticated request with an oversized body still gets a plain 401, not a body-size error - auth runs before parsing', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    { method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' } },
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'a'.repeat(3 * 1024 * 1024) }] }
  );
  assert.equal(res.status, 401);
});

test('responses never carry an X-Powered-By header', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(server, { method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  // request() only returns {status, body} - check via a raw request for headers.
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method: 'GET', path: '/health' },
      (rawRes) => {
        assert.equal(rawRes.headers['x-powered-by'], undefined);
        rawRes.resume();
        rawRes.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.end();
  });
});

test('POST /v1/chat/completions with an unknown routing tier returns 400', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' }
    },
    { model: 'router:does-not-exist', messages: [{ role: 'user', content: 'hi' }] }
  );
  assert.equal(res.status, 400);
});

test('GET /stats requires the internal key and returns aggregate shape', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const unauthed = await request(server, { method: 'GET', path: '/stats' });
  assert.equal(unauthed.status, 401);

  const authed = await request(server, {
    method: 'GET',
    path: '/stats',
    headers: { Authorization: 'Bearer test-internal-key' }
  });
  assert.equal(authed.status, 200);
  assert.ok('sample_size' in authed.body);
  assert.ok('cache_hit_rate' in authed.body);
  assert.ok('by_provider' in authed.body);
});

test('GET /dashboard/data requires the internal key and returns the range-summary shape', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const unauthed = await request(server, { method: 'GET', path: '/dashboard/data' });
  assert.equal(unauthed.status, 401);

  const authed = await request(server, {
    method: 'GET',
    path: '/dashboard/data?days=7',
    headers: { Authorization: 'Bearer test-internal-key' }
  });
  assert.equal(authed.status, 200);
  assert.equal(authed.body.days, 7);
  assert.ok('sample_size' in authed.body);
  assert.ok('cache_hit_rate' in authed.body);
  assert.ok('error_rate' in authed.body);
  assert.ok(Array.isArray(authed.body.daily));
  assert.ok('by_provider' in authed.body);
  assert.deepEqual(authed.body.provider_alerts, [], 'a healthy deployment should report no alerts');
});

test('GET /dashboard/data surfaces provider_alerts once a provider has a recent classified error', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const metrics = require('../metrics');
  metrics.record({
    provider: 'anthropic',
    error: '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}',
    error_type: 'authentication_error'
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the write stream flush

  const authed = await request(server, {
    method: 'GET',
    path: '/dashboard/data',
    headers: { Authorization: 'Bearer test-internal-key' }
  });
  assert.equal(authed.status, 200);
  assert.equal(authed.body.provider_alerts.length, 1);
  assert.equal(authed.body.provider_alerts[0].provider, 'anthropic');
  assert.equal(authed.body.provider_alerts[0].error_type, 'authentication_error');
  assert.ok(authed.body.provider_alerts[0].last_error_at);
});

test('GET /dashboard/data clamps an out-of-range days value instead of erroring', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const tooMany = await request(server, {
    method: 'GET',
    path: '/dashboard/data?days=99999',
    headers: { Authorization: 'Bearer test-internal-key' }
  });
  assert.equal(tooMany.status, 200);
  assert.equal(tooMany.body.days, 90);

  const zero = await request(server, {
    method: 'GET',
    path: '/dashboard/data?days=0',
    headers: { Authorization: 'Bearer test-internal-key' }
  });
  assert.equal(zero.status, 200);
  assert.equal(zero.body.days, 1);
});

test('GET /dashboard is public and serves the dashboard page', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(server, { method: 'GET', path: '/dashboard' });
  assert.equal(res.status, 200);
  assert.match(res.body, /Cost Dashboard/);
});

// Deliberately LAST in this file: neither provider key is set anywhere
// in this suite (see the top of this file), so a virtual-model request
// here always exhausts the failover loop and records a classified
// error for BOTH candidates - exactly the kind of write the earlier
// provider_alerts tests above assume nothing else has made yet. This
// exists to prove the failover loop actually runs end-to-end through
// the real HTTP route wiring (failover.js + router.js's
// rankedCandidates + dispatchToProvider) and fails cleanly with one
// response, not a crash or a hang, without needing a live provider
// call to do it - it just has to run after everything that depends on
// a clean alert slate, not before.
test('POST /v1/chat/completions with a virtual model tries every candidate via failover, then fails cleanly', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(
    server,
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' }
    },
    { model: 'router:fast-cheap', messages: [{ role: 'user', content: 'hi' }] }
  );
  assert.equal(res.status, 502);
  assert.ok(res.body.error);
});
