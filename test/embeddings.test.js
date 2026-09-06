const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshEmbeddings(env) {
  delete process.env.OPENAI_API_KEY;
  delete process.env.SEMANTIC_CACHE_LOCAL_EMBEDDINGS;
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../embeddings')];
  return require('../embeddings');
}

test('isEnabled() is false with no OPENAI_API_KEY', () => {
  const embeddings = freshEmbeddings({});
  assert.equal(embeddings.isEnabled(), false);
});

test('isEnabled() is true once OPENAI_API_KEY is set', () => {
  const embeddings = freshEmbeddings({ OPENAI_API_KEY: 'sk-test-fake' });
  assert.equal(embeddings.isEnabled(), true);
});

test('embed() rejects clearly when disabled, without attempting a network call', async () => {
  const embeddings = freshEmbeddings({});
  await assert.rejects(() => embeddings.embed('hello'), /OPENAI_API_KEY not configured/);
});

// Step 22 (local embeddings, eval-gated) - the local backend is opt-in via
// SEMANTIC_CACHE_LOCAL_EMBEDDINGS, default OFF, OpenAI stays the default.

test('isEnabled() is true with SEMANTIC_CACHE_LOCAL_EMBEDDINGS=true, even without OPENAI_API_KEY (22.4)', () => {
  const embeddings = freshEmbeddings({ SEMANTIC_CACHE_LOCAL_EMBEDDINGS: 'true' });
  assert.equal(embeddings.isEnabled(), true);
});

test('activeBackend() is "local" only when the flag is on, "openai" otherwise (no silent fallback)', () => {
  assert.equal(freshEmbeddings({}).activeBackend(), 'openai');
  assert.equal(freshEmbeddings({ OPENAI_API_KEY: 'sk-test-fake' }).activeBackend(), 'openai');
  assert.equal(freshEmbeddings({ SEMANTIC_CACHE_LOCAL_EMBEDDINGS: 'true' }).activeBackend(), 'local');
});

test('the local backend is a DIFFERENT dimension than OpenAI (384 vs 1536 - proves no silent 1536 fallback)', () => {
  const embeddings = freshEmbeddings({});
  assert.equal(embeddings.LOCAL_EMBEDDING_DIMENSIONS, 384);
  assert.equal(embeddings.OPENAI_EMBEDDING_DIMENSIONS, 1536);
  assert.notEqual(embeddings.LOCAL_EMBEDDING_DIMENSIONS, embeddings.OPENAI_EMBEDDING_DIMENSIONS);
});

test('embedTimeoutMs() still honors EMBEDDING_TIMEOUT_MS (timeout contract preserved)', () => {
  process.env.EMBEDDING_TIMEOUT_MS = '1234';
  const embeddings = freshEmbeddings({});
  assert.equal(embeddings.embedTimeoutMs(), 1234);
  delete process.env.EMBEDDING_TIMEOUT_MS;
});
