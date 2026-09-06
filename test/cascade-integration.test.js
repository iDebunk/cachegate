const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// cascade.js reads CASCADE_ENABLED once at require time, and server.js (which
// requires cascade.js) is itself required once at the top of server.test.js -
// so a per-test `process.env.CASCADE_ENABLED = 'true'` there has no effect on
// already-cached module behavior. This is its own file, mirroring
// server.test.js's own precedent (env vars set before the top-level
// `require('../server')`, no real Redis needed - see that file's own
// comment), so CASCADE_ENABLED is actually live when server.js's route
// handler reaches cascade.tryWithCascade.
process.env.CASCADE_ENABLED = 'true';
process.env.MODEL_ROUTER_INTERNAL_KEY = 'cascade-integration-test-key';
process.env.METRICS_LOG_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-integration-test-')),
  'metrics.jsonl'
);

const { app, configure } = require('../server');
const metrics = require('../metrics');
const openaiProvider = require('../providers/openai');
const anthropicProvider = require('../providers/anthropic');

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

test('cascade: the escalated-away candidate is scored quality_score 0.5, never 1.0, even with no earlier failover', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const originalOpenaiBuildClient = openaiProvider.buildClient;
  const originalOpenaiChat = openaiProvider.chat;
  const originalAnthropicBuildClient = anthropicProvider.buildClient;
  const originalAnthropicChat = anthropicProvider.chat;

  openaiProvider.buildClient = () => ({ __fake: true });
  openaiProvider.chat = async (client, payload) => ({
    provider: 'openai',
    model: payload.model,
    content: 'a low-confidence guess',
    usage: { input_tokens: 1, output_tokens: 1 },
    cost_usd: 0.001,
    latency_ms: 1,
    // Very low per-token probability (logprob = ln(0.01)) -> confidence
    // exp(mean(logprobs)) = 0.01, well below the 0.5 default threshold.
    raw: { choices: [{ logprobs: { content: [{ token: 'x', logprob: Math.log(0.01) }] } }] }
  });
  anthropicProvider.buildClient = () => ({ __fake: true });
  anthropicProvider.chat = async (client, payload) => ({
    provider: 'anthropic',
    model: payload.model,
    content: 'a confident answer',
    usage: { input_tokens: 1, output_tokens: 1 },
    cost_usd: 0.002,
    latency_ms: 1
  });
  t.after(() => {
    openaiProvider.buildClient = originalOpenaiBuildClient;
    openaiProvider.chat = originalOpenaiChat;
    anthropicProvider.buildClient = originalAnthropicBuildClient;
    anthropicProvider.chat = originalAnthropicChat;
  });

  const defaultResolveProviderKey = (scope, provider) =>
    (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || null;
  t.after(() => configure({ resolveProviderKey: defaultResolveProviderKey }));
  configure({ resolveProviderKey: async () => 'fake-key' });

  const before = await metrics.readRecent(null, 1000);

  const res = await request(
    server,
    { method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cascade-integration-test-key' } },
    { model: 'router:fast-cheap', messages: [{ role: 'user', content: 'cascade quality_score test' }] }
  );

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.cascaded, true, 'expected the low-confidence openai attempt to be escalated');

  const after = await metrics.readRecent(null, 1000);
  const newRows = after.slice(before.length);
  const escalatedAwayRow = newRows.find((r) => r.provider === 'openai');
  const acceptedRow = newRows.find((r) => r.provider === 'anthropic');
  assert.ok(escalatedAwayRow, 'expected a metrics row for the rejected openai attempt');
  assert.ok(acceptedRow, 'expected a metrics row for the accepted anthropic attempt');
  assert.equal(
    escalatedAwayRow.quality_score,
    0.5,
    'a low-confidence rejection alone must score 0.5, never a perfect 1.0, regardless of failover'
  );
  assert.equal(acceptedRow.quality_score, 1.0);
  assert.equal(acceptedRow.cascaded, true);
});
