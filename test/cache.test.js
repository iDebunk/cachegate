const { test } = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../cache');

test('buildCacheKey is deterministic for identical payloads', () => {
  const payload = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(cache.buildCacheKey(payload), cache.buildCacheKey({ ...payload }));
});

test('buildCacheKey differs when messages differ', () => {
  const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'bye' }] };
  assert.notEqual(cache.buildCacheKey(a), cache.buildCacheKey(b));
});

test('buildCacheKey differs when model differs, same messages', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const a = { model: 'gpt-4o-mini', messages };
  const b = { model: 'claude-haiku-4-5-20251001', messages };
  assert.notEqual(cache.buildCacheKey(a), cache.buildCacheKey(b));
});

test('buildCacheKey treats an unset temperature the same as 0.0 (documented default)', () => {
  const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], temperature: 0.0 };
  assert.equal(cache.buildCacheKey(a), cache.buildCacheKey(b));
});

test('isConnected() is false with no REDIS_URL configured', () => {
  // This test suite never sets REDIS_URL, matching the documented
  // graceful-degradation path (cache disabled, not crashed).
  assert.equal(cache.isConnected(), false);
});
