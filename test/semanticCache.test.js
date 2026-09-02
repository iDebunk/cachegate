// Exercises the real storage/lookup machinery (list writes, trimming,
// cosine-similarity scoring) against an actual Redis instance, not a
// mock - this test file spins up its own throwaway redis-server for
// the duration of the run so `npm test` stays self-contained. It never
// calls a real embedding API: a deterministic fake embedder is injected
// via the `embeddings` option both findMatch() and store() accept, so
// the similarity math is genuinely exercised without needing
// OPENAI_API_KEY or network access.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');

let redisProcess;
let redisClient;
let semanticCache;
let cache;

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

// A small fixed-dimension deterministic "embedding": each word maps to
// a pseudo-random but stable vector slot via a simple hash, so two
// texts sharing words end up with similar vectors and unrelated texts
// don't - enough to exercise cosine-similarity thresholding
// meaningfully without a real embedding model.
function fakeEmbed(text) {
  const dims = 32;
  const vec = new Array(dims).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    vec[h % dims] += 1;
  }
  return Promise.resolve(vec);
}

const fakeEmbeddings = { isEnabled: () => true, embed: fakeEmbed };

before(async () => {
  const port = await getFreePort();
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  redisProcess = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForRedisReady(redisProcess);

  redisClient = require('../redisClient');
  await redisClient.ready;
  semanticCache = require('../semanticCache');
  cache = require('../cache');
});

after(async () => {
  try { await redisClient.client.quit(); } catch { /* already closed */ }
  if (redisProcess) redisProcess.kill();
});

test('isEnabled() is true once Redis is connected and embeddings report enabled', () => {
  assert.equal(semanticCache.isEnabled(fakeEmbeddings), true);
});

test('isEnabled() is false when embeddings are disabled, even with Redis connected', () => {
  assert.equal(semanticCache.isEnabled({ isEnabled: () => false }), false);
});

test('the exact-match cache (cache.js) still works over the same shared connection', async () => {
  const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'shared connection check' }] };
  assert.equal(await cache.get(null, payload), null);
  await cache.set(null, payload, { provider: 'openai', model: 'gpt-4o-mini', content: 'ok' });
  const hit = await cache.get(null, payload);
  assert.equal(hit.content, 'ok');
});

test('findMatch() returns null when nothing has been stored yet', async () => {
  const payload = { model: 'router-test-model-empty', messages: [{ role: 'user', content: 'is anyone there' }] };
  const result = await semanticCache.findMatch(null, payload, { embeddings: fakeEmbeddings });
  assert.equal(result, null);
});

test('store() then findMatch() with the identical prompt finds a match (similarity ~1)', async () => {
  const model = 'router-test-model-identical';
  const payload = { model, messages: [{ role: 'user', content: 'how do I reset my password' }] };
  const entry = { provider: 'openai', model, content: 'Go to Settings > Security > Reset password.' };

  const stored = await semanticCache.store(null, payload, entry, { embeddings: fakeEmbeddings });
  assert.equal(stored, true);

  const match = await semanticCache.findMatch(null, payload, { embeddings: fakeEmbeddings });
  assert.ok(match, 'expected a match for the identical prompt');
  assert.equal(match.entry.content, entry.content);
  assert.ok(match.similarity > 0.99, `expected near-1 similarity, got ${match.similarity}`);
});

test('findMatch() does not match an unrelated prompt under the same model', async () => {
  const model = 'router-test-model-unrelated';
  const stored = { model, messages: [{ role: 'user', content: 'how do I reset my password' }] };
  await semanticCache.store(null, stored, { provider: 'openai', model, content: 'reset password steps' }, { embeddings: fakeEmbeddings });

  const unrelated = { model, messages: [{ role: 'user', content: 'what is the weather in Tokyo tomorrow' }] };
  const match = await semanticCache.findMatch(null, unrelated, { embeddings: fakeEmbeddings, threshold: 0.93 });
  assert.equal(match, null);
});

test('findMatch()/store() skip tool-calling requests entirely (never cached, never matched)', async () => {
  const model = 'router-test-model-tools';
  const payload = {
    model,
    messages: [{ role: 'user', content: 'call the tool' }],
    tools: [{ type: 'function', function: { name: 'do_thing' } }]
  };
  const stored = await semanticCache.store(null, payload, { provider: 'openai', model, content: 'x' }, { embeddings: fakeEmbeddings });
  assert.equal(stored, false);

  const match = await semanticCache.findMatch(null, payload, { embeddings: fakeEmbeddings });
  assert.equal(match, null);
});

test('scope isolates semantic lists: two scopes never see each other\'s stored entries', async () => {
  const model = 'router-test-model-scoped';
  const payload = { model, messages: [{ role: 'user', content: 'how do I reset my password' }] };
  const entry = { provider: 'openai', model, content: 'tenant-a answer' };

  await semanticCache.store('tenant-a', payload, entry, { embeddings: fakeEmbeddings });

  const sameTenant = await semanticCache.findMatch('tenant-a', payload, { embeddings: fakeEmbeddings });
  assert.ok(sameTenant, 'expected tenant-a to see its own stored entry');

  const otherTenant = await semanticCache.findMatch('tenant-b', payload, { embeddings: fakeEmbeddings });
  assert.equal(otherTenant, null, 'tenant-b must not see tenant-a\'s entry');

  const global = await semanticCache.findMatch(null, payload, { embeddings: fakeEmbeddings });
  assert.equal(global, null, 'the unscoped/global list must not see a scoped entry either');
});

test('per-model list is trimmed to SEMANTIC_CACHE_MAX_CANDIDATES', async () => {
  const originalMax = process.env.SEMANTIC_CACHE_MAX_CANDIDATES;
  process.env.SEMANTIC_CACHE_MAX_CANDIDATES = '3';
  delete require.cache[require.resolve('../semanticCache')];
  const scopedSemanticCache = require('../semanticCache');

  const model = 'router-test-model-trim';
  for (let i = 0; i < 5; i++) {
    await scopedSemanticCache.store(
      null,
      { model, messages: [{ role: 'user', content: `distinct prompt number ${i}` }] },
      { provider: 'openai', model, content: `answer ${i}` },
      { embeddings: fakeEmbeddings }
    );
  }

  const length = await redisClient.client.lLen(`SEMANTIC_LIST:${model}`);
  assert.equal(length, 3);

  if (originalMax === undefined) delete process.env.SEMANTIC_CACHE_MAX_CANDIDATES;
  else process.env.SEMANTIC_CACHE_MAX_CANDIDATES = originalMax;
});

test('cosineSimilarity() is 1 for identical vectors and 0 for orthogonal ones', () => {
  assert.equal(semanticCache.cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(semanticCache.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(semanticCache.cosineSimilarity([1, 0], [0, 0]), 0); // zero vector is defined as no similarity, not NaN
});
