const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshEmbeddings(env) {
  delete process.env.OPENAI_API_KEY;
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
