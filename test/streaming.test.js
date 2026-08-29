const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const streaming = require('../streaming');
const anthropicProvider = require('../providers/anthropic');
const openaiProvider = require('../providers/openai');

// ---------- pure SSE frame-building tests (no network, no Redis) ----------

test('roleChunk/deltaChunk/finalChunk/doneFrame produce valid "data: <json>\\n\\n" SSE lines', () => {
  const id = 'chatcmpl-test';
  const role = streaming.roleChunk({ id, model: 'gpt-4o-mini' });
  assert.match(role, /^data: /);
  assert.match(role, /\n\n$/);
  const roleJson = JSON.parse(role.slice('data: '.length).trim());
  assert.equal(roleJson.choices[0].delta.role, 'assistant');
  assert.equal(roleJson.object, 'chat.completion.chunk');

  const delta = streaming.deltaChunk({ id, model: 'gpt-4o-mini', content: 'Hello' });
  const deltaJson = JSON.parse(delta.slice('data: '.length).trim());
  assert.equal(deltaJson.choices[0].delta.content, 'Hello');
  assert.equal(deltaJson.choices[0].finish_reason, null);

  const final = streaming.finalChunk({
    id, model: 'gpt-4o-mini', usage: { input_tokens: 5, output_tokens: 3 },
    cost_usd: 0.001, provider: 'openai', cached: false
  });
  const finalJson = JSON.parse(final.slice('data: '.length).trim());
  assert.equal(finalJson.choices[0].finish_reason, 'stop');
  assert.equal(finalJson.cost_usd, 0.001);
  assert.equal(finalJson.provider, 'openai');
  assert.equal(finalJson.cached, false);
  assert.equal(finalJson.cache_type, undefined); // omitted, not set to a falsy placeholder

  assert.equal(streaming.doneFrame(), 'data: [DONE]\n\n');
});

test('finalChunk includes cache_type only when a cache_type was actually given', () => {
  const withType = streaming.finalChunk({ id: 'x', model: 'm', cached: true, cache_type: 'semantic' });
  assert.match(withType, /"cache_type":"semantic"/);

  const withoutType = streaming.finalChunk({ id: 'x', model: 'm', cached: false });
  assert.doesNotMatch(withoutType, /cache_type/);
});

test('errorFrame carries the message in an { error } shape distinguishable from a normal chunk', () => {
  const frame = streaming.errorFrame('upstream timed out');
  const json = JSON.parse(frame.slice('data: '.length).trim());
  assert.equal(json.error.message, 'upstream timed out');
  assert.equal(json.choices, undefined);
});

test('genId() produces unique ids', () => {
  const ids = new Set([streaming.genId(), streaming.genId(), streaming.genId()]);
  assert.equal(ids.size, 3);
});

// ---------- pure stream-event accumulator tests (no network) ----------

test('anthropic applyStreamEvent accumulates text deltas and final usage from a realistic event sequence', () => {
  const state = { content: '', inputTokens: 0, outputTokens: 0 };
  const deltas = [];
  const onDelta = (t) => deltas.push(t);

  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } },
    { type: 'content_block_stop' },
    { type: 'message_delta', usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ];
  events.forEach((e) => anthropicProvider.applyStreamEvent(state, e, onDelta));

  assert.equal(state.content, 'Hello, world');
  assert.equal(state.inputTokens, 12);
  assert.equal(state.outputTokens, 4);
  assert.deepEqual(deltas, ['Hello', ', world']);
});

test('anthropic applyStreamEvent ignores non-text content block deltas', () => {
  const state = { content: '', inputTokens: 0, outputTokens: 0 };
  anthropicProvider.applyStreamEvent(state, { type: 'message_start', message: { usage: { input_tokens: 1 } } }, () => {});
  anthropicProvider.applyStreamEvent(state, { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } }, () => {
    throw new Error('onDelta should not fire for a non-text delta');
  });
  assert.equal(state.content, '');
});

test('openai applyStreamChunk accumulates text deltas and only reads usage from the choice-less final chunk', () => {
  const state = { content: '', inputTokens: 0, outputTokens: 0 };
  const deltas = [];
  const onDelta = (t) => deltas.push(t);

  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }
  ];
  chunks.forEach((c) => openaiProvider.applyStreamChunk(state, c, onDelta));

  assert.equal(state.content, 'Hi there');
  assert.equal(state.inputTokens, 8);
  assert.equal(state.outputTokens, 2);
  assert.deepEqual(deltas, ['Hi', ' there']);
});

test('openai applyStreamChunk does nothing dangerous on a chunk with no choices and no usage', () => {
  const state = { content: '', inputTokens: 0, outputTokens: 0 };
  assert.doesNotThrow(() => openaiProvider.applyStreamChunk(state, { choices: [] }, () => {}));
  assert.equal(state.content, '');
});

// ---------- real end-to-end SSE test, through an ephemeral Redis-backed cache ----------
// (mirrors semanticCache.test.js's self-contained pattern - no external
// service assumed, no live provider API call needed since this only
// exercises the cached-hit replay path)

let redisProcess;
let redisClient;
let cache;
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
  process.env.MODEL_ROUTER_INTERNAL_KEY = 'stream-test-key';
  process.env.METRICS_LOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-test-')), 'metrics.jsonl');

  redisProcess = spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForRedisReady(redisProcess);

  redisClient = require('../redisClient');
  await redisClient.ready;
  cache = require('../cache');
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

function postSse(server, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stream-test-key' }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('a streamed request that hits the exact cache replays the cached content as SSE, not a JSON body', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'stream cache replay test' }] };
  await cache.set(payload, {
    provider: 'openai',
    model: 'gpt-4o-mini',
    content: 'Hello from cache',
    usage: { input_tokens: 5, output_tokens: 3 }
  });

  const res = await postSse(server, { ...payload, stream: true });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.match(res.body, /"delta":\{"role":"assistant"\}/);
  assert.match(res.body, /"content":"Hello from cache"/);
  assert.match(res.body, /"cached":true/);
  assert.match(res.body, /"cache_type":"exact"/);
  assert.match(res.body, /"finish_reason":"stop"/);
  assert.match(res.body, /data: \[DONE\]\n\n$/);
});

test('a streamed request that misses every cache with no provider key configured still gets a clean JSON error, not a broken stream', async (t) => {
  const server = await listen();
  t.after(() => server.close());

  const res = await postSse(server, {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'definitely not cached ' + Math.random() }],
    stream: true
  });

  // No OPENAI_API_KEY is set anywhere in this test run, and the
  // missing-key check runs before SSE headers are written.
  assert.equal(res.status, 500);
  assert.notEqual(res.headers['content-type'], 'text/event-stream');
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error, /OPENAI_API_KEY/);
});
