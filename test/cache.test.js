const { test } = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../cache');
const redisClient = require('../redisClient');

test('buildCacheKey is deterministic for identical payloads', () => {
  const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(cache.buildCacheKey(null, payload), cache.buildCacheKey(null, { ...payload }));
});

test('buildCacheKey differs when messages differ', () => {
  const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'bye' }] };
  assert.notEqual(cache.buildCacheKey(null, a), cache.buildCacheKey(null, b));
});

test('buildCacheKey differs when model differs, same messages', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const a = { model: 'gpt-4o-mini', messages };
  const b = { model: 'claude-haiku-4-5-20251001', messages };
  assert.notEqual(cache.buildCacheKey(null, a), cache.buildCacheKey(null, b));
});

test('buildCacheKey treats an unset temperature the same as 0.0 (documented default)', () => {
  const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], temperature: 0.0 };
  assert.equal(cache.buildCacheKey(null, a), cache.buildCacheKey(null, b));
});

// Seams work (roadmap: engine/cloud "wrap it, don't fork it") - scope is
// an opt-in isolation key, not a required concept. These pin the two
// halves of that contract down as regression tests, not just prose.
test('buildCacheKey with no scope is byte-identical to the key shape this project has always produced', () => {
  const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const key = cache.buildCacheKey(null, payload);
  const hash = require('crypto').createHash('sha256').update(JSON.stringify({
    model: 'gpt-4o-mini',
    messages: payload.messages,
    temperature: 0.0,
    max_tokens: undefined,
    tools: undefined,
    tool_choice: undefined,
    response_format: undefined
  })).digest('hex');
  assert.equal(key, `ROUTER:gpt-4o-mini:${hash}`);
});

test('buildCacheKey folds a real scope into both the prefix and the hashed payload - not the prefix alone', () => {
  const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const unscoped = cache.buildCacheKey(null, payload);
  const scopedA = cache.buildCacheKey('tenant-a', payload);
  const scopedB = cache.buildCacheKey('tenant-b', payload);
  assert.ok(scopedA.startsWith('ROUTER:tenant-a:'));
  assert.notEqual(scopedA, unscoped);
  assert.notEqual(scopedA, scopedB);
  // The hash segment itself must differ too, not just the prefix - a
  // leaked/guessed prefix naming convention alone can't be walked into
  // another scope's content.
  const hashOf = (key) => key.split(':').pop();
  assert.notEqual(hashOf(scopedA), hashOf(scopedB));
  assert.notEqual(hashOf(scopedA), hashOf(unscoped));
});

test('isConnected() is false with no REDIS_URL configured', () => {
  // This test suite never sets REDIS_URL, matching the documented
  // graceful-degradation path (cache disabled, not crashed).
  assert.equal(cache.isConnected(), false);
});

// The actual bug this regression-tests (reliability review, 2026-09-02):
// node-redis v4's `isOpen` stays true through the ENTIRE automatic-
// reconnect loop after a live connection drops - it does not mean "a
// command can execute right now," `isReady` does. isConnected() used to
// read isOpen, so a Redis outage left every cache read/write queueing
// commands on a dead socket instead of failing open immediately. This
// overrides the two getters directly on the shared client instance
// (real node-redis getters, not a mock) to reproduce the exact state a
// live outage puts the client in - connected/reconnecting (isOpen: true)
// but unable to serve a command (isReady: false) - without needing a
// real Redis server to actually go down.
test('isConnected() tracks isReady, not isOpen - so a reconnecting-after-drop client reports NOT connected', (t) => {
  const originalIsOpen = Object.getOwnPropertyDescriptor(redisClient.client, 'isOpen');
  const originalIsReady = Object.getOwnPropertyDescriptor(redisClient.client, 'isReady');
  t.after(() => {
    // Restore whichever shape each property had before (own property vs.
    // inherited from the class prototype) so this test can't leak state
    // into any test that runs after it.
    if (originalIsOpen) Object.defineProperty(redisClient.client, 'isOpen', originalIsOpen);
    else delete redisClient.client.isOpen;
    if (originalIsReady) Object.defineProperty(redisClient.client, 'isReady', originalIsReady);
    else delete redisClient.client.isReady;
  });

  Object.defineProperty(redisClient.client, 'isOpen', { get: () => true, configurable: true });
  Object.defineProperty(redisClient.client, 'isReady', { get: () => false, configurable: true });

  assert.equal(redisClient.client.isOpen, true); // the exact state that used to read as "connected"
  assert.equal(cache.isConnected(), false); // must fail open instead
});
