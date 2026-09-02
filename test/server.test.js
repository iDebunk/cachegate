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

test('GET /health is public and minimal - no provider/routing configuration leaked', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(server, { method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'healthy');
  assert.ok('redis_connected' in res.body);
  assert.ok('semantic_cache_enabled' in res.body);
  // Security-review finding (2026-09-02): this is a PUBLIC, unauthenticated
  // route - which providers have a key configured and the internal routing
  // tiers/strategy must not be readable by anyone who can reach it.
  assert.ok(!('providers' in res.body));
  assert.ok(!('routing_tiers' in res.body));
  assert.ok(!('routing_strategy' in res.body));
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
  // Moved here from the now-public-and-minimal GET /health (security-review
  // finding, 2026-09-02) - this route already requires the internal key.
  assert.ok(Array.isArray(authed.body.routing_tiers));
  assert.ok(authed.body.routing_tiers.includes('router:fast-cheap'));
  assert.equal(authed.body.routing_strategy, 'cost'); // no ROUTER_STRATEGY set in this test suite - default applies
  assert.deepEqual(authed.body.providers, { anthropic: false, openai: false }); // no provider keys set in this test suite
});

// Reliability review (2026-09-02): this route's own body used to be one
// unguarded async block - a metrics-store failure (a Postgres blip, on
// the DATABASE_URL-backed deployment render.yaml wires) was an unhandled
// promise rejection Express 4 never routes to the error middleware,
// crashing the whole process instead of just this one request.
test('GET /stats returns a clean 500, not a crash, when the metrics store fails', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const metrics = require('../metrics');
  const original = metrics.readRecent;
  metrics.readRecent = () => Promise.reject(new Error('simulated Postgres outage'));
  t.after(() => { metrics.readRecent = original; });

  const authed = await request(server, {
    method: 'GET',
    path: '/stats',
    headers: { Authorization: 'Bearer test-internal-key' }
  });
  assert.equal(authed.status, 500);
  assert.ok(authed.body.error);
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
  metrics.record(null, {
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

// Same reliability-review fix as GET /stats above, applied to this
// route's own metrics.rangeSummary call.
test('GET /dashboard/data returns a clean 500, not a crash, when the metrics store fails', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const metrics = require('../metrics');
  const original = metrics.rangeSummary;
  metrics.rangeSummary = () => Promise.reject(new Error('simulated Postgres outage'));
  t.after(() => { metrics.rangeSummary = original; });

  const authed = await request(server, {
    method: 'GET',
    path: '/dashboard/data',
    headers: { Authorization: 'Bearer test-internal-key' }
  });
  assert.equal(authed.status, 500);
  assert.ok(authed.body.error);
});

test('GET /dashboard is public and serves the dashboard page', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await request(server, { method: 'GET', path: '/dashboard' });
  assert.equal(res.status, 200);
  assert.match(res.body, /Cost Dashboard/);
});

// Reliability review (2026-09-02): router.js already degrades a
// metrics-store failure to cost-only ranking internally (see
// router.test.js), so this route's own catch around
// router.pickCandidate should be unreachable in practice today - but an
// unguarded await there was itself a process-crash vector under Express
// 4, so it's guarded regardless of whether anything currently reaches
// it. Forces pickCandidate to reject directly (a cause neither this test
// nor the real code needs to name) and confirms a clean 500, never a
// crash or a hang. The mocked pickCandidate never reaches
// dispatchToProvider, so this writes no metrics and can't affect the
// alert-state assumptions of the "deliberately LAST" test below.
test('POST /v1/chat/completions with a virtual model returns a clean 500, not a crash, when the routing decision itself throws', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const router = require('../router');
  const original = router.pickCandidate;
  router.pickCandidate = () => Promise.reject(new Error('simulated routing failure'));
  t.after(() => { router.pickCandidate = original; });

  const res = await request(
    server,
    { method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' } },
    { model: 'router:fast-cheap', messages: [{ role: 'user', content: 'hi' }] }
  );
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
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

// Regression test for the seams gap PR #77 fixed: resolveProviderKey
// must be awaitable, not just callable - a real per-scope key lookup
// (Cachegate Cloud's own BYOK: a Postgres fetch + decrypt) is a
// Promise, not a plain value. This drives an ACTUAL async resolver
// (a real Promise, deliberately not resolved on the same tick - see
// the setImmediate below) through a real HTTP POST to /v1, all the way
// to the provider client construction, and proves the resolved key is
// what reaches it - not undefined, not a stringified Promise object,
// which is exactly what a sync-only `await`-free call site would have
// produced. anthropicProvider.buildClient/chat are patched rather than
// hitting a real provider (this suite makes no live provider calls -
// see the file-level comment at the top), but the patch only replaces
// the provider SDK boundary; every layer above it (server.js's routing,
// the seam, the client-construction call sites PR #77 touched) is real.
//
// Deliberately placed LAST, after the failover test above: it's the
// first test in this file to actually populate server.js's own
// module-level anthropicClient cache with a *client* (every earlier
// test either uses no provider key at all, or a virtual model that
// exhausts failover before ever reaching getAnthropicClient) - nothing
// later in this file depends on that cache being empty.
test('an ASYNC resolveProviderKey (the real BYOK shape) is awaited, and its resolved key reaches the provider client', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const anthropicProvider = require('../providers/anthropic');
  const originalBuildClient = anthropicProvider.buildClient;
  const originalChat = anthropicProvider.chat;
  let capturedKey;
  anthropicProvider.buildClient = (apiKey) => {
    capturedKey = apiKey;
    return { __fakeClientFromAsyncResolver: true };
  };
  anthropicProvider.chat = async (client, payload) => {
    // Proves the exact client buildClient constructed (from the async-
    // resolved key) is what actually reaches chat() - not some other,
    // stale, or default-path client.
    assert.equal(client && client.__fakeClientFromAsyncResolver, true, 'expected the async resolver\'s own client to reach chat()');
    return {
      provider: 'anthropic',
      model: payload.model,
      content: 'stubbed response - proves the seam, not a real API call',
      usage: { input_tokens: 1, output_tokens: 1 },
      cost_usd: 0,
      latency_ms: 1
    };
  };
  t.after(() => {
    anthropicProvider.buildClient = originalBuildClient;
    anthropicProvider.chat = originalChat;
  });

  const { configure } = require('../server');
  const defaultResolveProviderKey = (scope, provider) =>
    (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || null;
  configure({
    resolveProviderKey: async (scope, provider) => {
      // A genuine async boundary (not resolved on the same tick) - the
      // exact shape a real DB fetch + decrypt has, and the shape a
      // missing `await` at any call site would silently break (the
      // resolved value would arrive as a pending Promise, not a string,
      // and `!(await ...)` would need the await to see the real value).
      await new Promise((resolve) => setImmediate(resolve));
      return provider === 'anthropic' ? 'async-resolved-fake-anthropic-key' : null;
    }
  });
  t.after(() => configure({ resolveProviderKey: defaultResolveProviderKey }));

  const res = await request(
    server,
    { method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' } },
    { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] }
  );

  assert.equal(res.status, 200, `expected a clean 200 through the stubbed provider boundary, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(
    capturedKey,
    'async-resolved-fake-anthropic-key',
    'the async resolver\'s resolved key must reach buildClient() - not undefined, not "[object Promise]"'
  );
});
