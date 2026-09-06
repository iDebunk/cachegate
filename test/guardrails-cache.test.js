const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Verifies the other half of the PII-redaction wiring's stated purpose
// (server.js, step 25 joint wiring): redacted content is what actually
// gets written to the exact cache, not the raw original. That needs a
// REAL, connected Redis - server.test.js's redisClient singleton never
// connects (REDIS_URL isn't set there), so this is its own file with
// its own throwaway Redis instance, mirroring streaming.test.js's exact
// pattern (spawn on a free port, set REDIS_URL, wait for ready, THEN
// require server.js - the connect-or-not decision in redisClient.js's
// module-level IIFE happens once, at require time).

let redisProcess;
let redisClient;
let app;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForRedisReady(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('redis-server did not become ready in time')), 10_000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Ready to accept connections')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on('error', reject);
  });
}

before(async () => {
  const redisPort = await getFreePort();
  process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
  process.env.MODEL_ROUTER_INTERNAL_KEY = 'guardrails-cache-test-key';
  process.env.METRICS_LOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-cache-test-')), 'metrics.jsonl');

  redisProcess = spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForRedisReady(redisProcess);

  redisClient = require('../redisClient');
  await redisClient.ready;
  app = require('../server').app;
});

after(async () => {
  try { await redisClient.client.quit(); } catch { /* already closed */ }
  if (redisProcess) redisProcess.kill();
});

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

test('with GUARDRAILS_PII_REDACTION=true, an identical follow-up request hits the exact cache on the REDACTED key - the provider is dispatched to only once', async (t) => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  t.after(() => delete process.env.GUARDRAILS_PII_REDACTION);
  const server = await listen();
  t.after(() => server.close());

  const anthropicProvider = require('../providers/anthropic');
  const originalBuildClient = anthropicProvider.buildClient;
  const originalChat = anthropicProvider.chat;
  let dispatchCount = 0;
  anthropicProvider.buildClient = () => ({ __fake: true });
  anthropicProvider.chat = async (client, payload) => {
    dispatchCount += 1;
    return { provider: 'anthropic', model: payload.model, content: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0, latency_ms: 1 };
  };
  t.after(() => { anthropicProvider.buildClient = originalBuildClient; anthropicProvider.chat = originalChat; });

  const { configure } = require('../server');
  t.after(() => configure({ resolveProviderKey: (scope, provider) => (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || null }));
  configure({ resolveProviderKey: async (scope, provider) => (provider === 'anthropic' ? 'fake-key' : null) });

  const body = { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'Email me at jane@example.com please.' }] };
  const opts = { method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer guardrails-cache-test-key' } };

  const first = await request(server, opts, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(dispatchCount, 1);

  const second = await request(server, opts, body);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.cached, true, 'expected the second identical request to hit the exact cache');
  assert.equal(dispatchCount, 1, 'the cached hit must not trigger a second provider dispatch');
});

test('with GUARDRAILS_PII_REDACTION=true, two DIFFERENT emails that redact to the same placeholder share one cache entry - proves the cache key is built from the REDACTED text, not the original', async (t) => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  t.after(() => delete process.env.GUARDRAILS_PII_REDACTION);
  const server = await listen();
  t.after(() => server.close());

  const anthropicProvider = require('../providers/anthropic');
  const originalBuildClient = anthropicProvider.buildClient;
  const originalChat = anthropicProvider.chat;
  let dispatchCount = 0;
  anthropicProvider.buildClient = () => ({ __fake: true });
  anthropicProvider.chat = async (client, payload) => {
    dispatchCount += 1;
    return { provider: 'anthropic', model: payload.model, content: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0, latency_ms: 1 };
  };
  t.after(() => { anthropicProvider.buildClient = originalBuildClient; anthropicProvider.chat = originalChat; });

  const { configure } = require('../server');
  t.after(() => configure({ resolveProviderKey: (scope, provider) => (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || null }));
  configure({ resolveProviderKey: async (scope, provider) => (provider === 'anthropic' ? 'fake-key' : null) });

  const opts = { method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer guardrails-cache-test-key' } };

  // A sentence template distinct from the other test in this file - both
  // tests share one live Redis instance for the whole file, so reusing
  // a template that redacts identically to another test's would collide
  // on the same cache entry and give a false pass/fail here.
  const first = await request(server, opts, { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'My contact address is alice@example.com, thanks.' }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(dispatchCount, 1);

  // A DIFFERENT original email - only identical after redaction.
  const second = await request(server, opts, { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'My contact address is carol@other-domain.org, thanks.' }] });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.cached, true, 'two originals that redact identically should share the exact-cache entry');
  assert.equal(dispatchCount, 1, 'the second (different-but-redacts-the-same) request must not trigger its own dispatch');
});
