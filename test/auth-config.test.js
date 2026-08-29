const { test } = require('node:test');
const assert = require('node:assert/strict');

// server.js reads its env vars once at require time, so each case here
// resets env + require cache before requiring fresh.
function freshServer(env) {
  delete process.env.MODEL_ROUTER_INTERNAL_KEY;
  delete process.env.ALLOW_INSECURE_LOCAL_DEV;
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../server')];
  return require('../server');
}

test('isAuthConfigured() is false with neither key nor opt-in set', () => {
  const { isAuthConfigured } = freshServer({});
  assert.equal(isAuthConfigured(), false);
});

test('isAuthConfigured() is true once MODEL_ROUTER_INTERNAL_KEY is set', () => {
  const { isAuthConfigured } = freshServer({ MODEL_ROUTER_INTERNAL_KEY: 'some-key' });
  assert.equal(isAuthConfigured(), true);
});

test('isAuthConfigured() is true with the explicit insecure opt-in, even with no key', () => {
  const { isAuthConfigured } = freshServer({ ALLOW_INSECURE_LOCAL_DEV: 'true' });
  assert.equal(isAuthConfigured(), true);
});
