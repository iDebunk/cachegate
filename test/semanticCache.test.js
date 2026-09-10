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

// ── storage format (2026-09-10) ────────────────────────────────────────────────
// The vector moved from JSON numbers to base64 Float32, and the norm is stored with it. Both formats must
// keep matching from the same list, because every cache in the wild still holds the old one - these tests
// exist so a future change to the encoding cannot silently stop reading what is already stored.
test('encodeEmbedding()/decodeEmbedding() round-trip within Float32 precision', () => {
  const original = Array.from({ length: 1536 }, (_, i) => Math.sin(i) * 0.5 + 0.25);
  const decoded = semanticCache.decodeEmbedding({ embedding: semanticCache.encodeEmbedding(original) });

  assert.ok(decoded instanceof Float32Array, 'decode returns a typed array, not a plain array');
  assert.equal(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    // Float32 keeps ~7 significant digits; anything looser would hide a real encoding bug.
    assert.ok(Math.abs(decoded[i] - original[i]) < 1e-6, `element ${i} drifted: ${decoded[i]} vs ${original[i]}`);
  }
});

test('decodeEmbedding() still reads the legacy JSON-array format', () => {
  const legacy = [0.5, -0.25, 1];
  assert.deepEqual(semanticCache.decodeEmbedding({ embedding: legacy }), legacy);
});

test('decodeEmbedding() returns null for anything that is not a vector', () => {
  assert.equal(semanticCache.decodeEmbedding({}), null);
  assert.equal(semanticCache.decodeEmbedding({ embedding: null }), null);
  assert.equal(semanticCache.decodeEmbedding({ embedding: 42 }), null);
  // A base64 string that is not a whole number of 4-byte floats must be rejected, not read as a short
  // vector - a wrong-length vector would score 0 against everything and look like a miss.
  const threeBytes = Buffer.from([1, 2, 3]).toString('base64');
  assert.equal(semanticCache.decodeEmbedding({ embedding: threeBytes }), null);
});

test('similarityWithNorms() agrees with cosineSimilarity() on the same vectors', () => {
  const a = [0.3, -0.7, 0.2, 0.9, -0.1];
  const b = [0.6, 0.4, -0.5, 0.2, 0.8];
  const viaNorms = semanticCache.similarityWithNorms(a, semanticCache.normOf(a), b, semanticCache.normOf(b));
  assert.ok(Math.abs(viaNorms - semanticCache.cosineSimilarity(a, b)) < 1e-12, `${viaNorms} vs ${semanticCache.cosineSimilarity(a, b)}`);
});

test('store() writes the new format, and a lookup still matches it', async () => {
  const model = 'router-test-model-newformat';
  const payload = { model, messages: [{ role: 'user', content: 'how do I reset my password' }] };
  const entry = { provider: 'openai', model, content: 'new format answer' };

  await semanticCache.store(null, payload, entry, { embeddings: fakeEmbeddings });

  const stored = await redisClient.client.lRange(`SEMANTIC_LIST:${model}`, 0, 0);
  assert.equal(stored.length, 1);
  const record = JSON.parse(stored[0]);
  assert.equal(typeof record.embedding, 'string', 'the vector is stored as an encoded string');
  assert.equal(typeof record.norm, 'number', 'and its norm is stored beside it');

  const match = await semanticCache.findMatch(null, payload, { embeddings: fakeEmbeddings });
  assert.ok(match, 'a match must still be found for an entry in the new format');
  assert.equal(match.entry.content, entry.content);
});

test('a LEGACY entry already in the list still matches (the upgrade is not a cache flush)', async () => {
  const model = 'router-test-model-legacyentry';
  const payload = { model, messages: [{ role: 'user', content: 'how do I reset my password' }] };

  // Write the OLD shape by hand: a plain JSON number array, no stored norm - exactly what is sitting in
  // every cache that existed before this change.
  const vector = await fakeEmbed(semanticCache.extractPromptText(payload));
  await redisClient.client.lPush(
    `SEMANTIC_LIST:${model}`,
    JSON.stringify({ embedding: vector, entry: { provider: 'openai', model, content: 'legacy answer' }, storedAt: Date.now() })
  );

  const match = await semanticCache.findMatch(null, payload, { embeddings: fakeEmbeddings });
  assert.ok(match, 'the legacy entry must still be found');
  assert.equal(match.entry.content, 'legacy answer');
  assert.ok(match.similarity > 0.99, `expected near-1 similarity against the legacy vector, got ${match.similarity}`);
});

test('a malformed vector is skipped, and the good entry beside it still wins', async () => {
  const model = 'router-test-model-mixed';
  const payload = { model, messages: [{ role: 'user', content: 'how do I reset my password' }] };

  await redisClient.client.lPush(`SEMANTIC_LIST:${model}`, '{"embedding":"not-a-vector","entry":{"content":"corrupt"}}');
  await redisClient.client.lPush(`SEMANTIC_LIST:${model}`, 'this is not json at all');
  await semanticCache.store(null, payload, { provider: 'openai', model, content: 'good answer' }, { embeddings: fakeEmbeddings });

  const match = await semanticCache.findMatch(null, payload, { embeddings: fakeEmbeddings });
  assert.ok(match, 'the valid entry must still match despite its neighbours');
  assert.equal(match.entry.content, 'good answer');
});
