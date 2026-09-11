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

// Step 21 (prompt canonicalization) - buildCacheKey now hashes a
// canonical form of `messages`, so surface-level variation no longer
// splits one logical prompt into many cache keys.

test('buildCacheKey folds whitespace and field-order variation into one key (21.1)', () => {
  const base = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Summarize this document for me' }] };
  const variants = [
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '  Summarize this document for me  ' }] },
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Summarize   this\tdocument\nfor me' }] },
    { model: 'gpt-4o-mini', messages: [{ content: 'Summarize this document for me', role: 'user' }] }
  ];
  for (const v of variants) {
    assert.equal(cache.buildCacheKey(null, base), cache.buildCacheKey(null, v));
  }
});

test('buildCacheKey folds structural punctuation (curly quotes/dashes) to ASCII (21.1)', () => {
  const curly = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What is \u201Chello\u201D \u2014 really?' }] };
  const ascii = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What is "hello" - really?' }] };
  assert.equal(cache.buildCacheKey(null, curly), cache.buildCacheKey(null, ascii));
});

test('buildCacheKey slots email literals so templated paraphrases share a key (21.2)', () => {
  const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Summarize john@x.com email' }] };
  const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Summarize jane@y.com email' }] };
  assert.equal(cache.buildCacheKey(null, a), cache.buildCacheKey(null, b));
});

test('buildCacheKey does NOT slot numbers/dates by default (21.2 - gated OFF, Claude review 2026-09-06)', () => {
  delete process.env.CACHE_KEY_SLOT_NUMBERS;
  const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What happened on 2024-01-15?' }] };
  const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What happened on 2024-03-22?' }] };
  assert.notEqual(cache.buildCacheKey(null, a), cache.buildCacheKey(null, b));
  const c = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Give me 5 examples' }] };
  const d = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Give me 3 examples' }] };
  assert.notEqual(cache.buildCacheKey(null, c), cache.buildCacheKey(null, d));
});

test('buildCacheKey slots numbers/dates only when CACHE_KEY_SLOT_NUMBERS=true (21.2)', () => {
  process.env.CACHE_KEY_SLOT_NUMBERS = 'true';
  try {
    const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What happened on 2024-01-15?' }] };
    const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What happened on 2024-03-22?' }] };
    assert.equal(cache.buildCacheKey(null, a), cache.buildCacheKey(null, b));
    const c = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Give me 5 examples' }] };
    const d = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Give me 3 examples' }] };
    assert.equal(cache.buildCacheKey(null, c), cache.buildCacheKey(null, d));
  } finally {
    delete process.env.CACHE_KEY_SLOT_NUMBERS;
  }
});

test('buildCacheKey still differs for genuinely different prompts (no over-collapse)', () => {
  const a = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Summarize this document' }] };
  const b = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Translate this document' }] };
  assert.notEqual(cache.buildCacheKey(null, a), cache.buildCacheKey(null, b));
});

test('buildCacheKey still differs when tools or response_format differ (21.3 - no regression)', () => {
  const base = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const withTools = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f' } }] };
  const withJson = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } };
  assert.notEqual(cache.buildCacheKey(null, base), cache.buildCacheKey(null, withTools));
  assert.notEqual(cache.buildCacheKey(null, base), cache.buildCacheKey(null, withJson));
});

test('normalizeMessages returns a NEW array and never mutates the payload messages (21.1)', () => {
  const messages = [{ role: 'user', content: '  hi  ' }];
  const payload = { model: 'gpt-4o-mini', messages };
  cache.buildCacheKey(null, payload);
  // the raw messages sent to the provider are untouched, non-canonicalized
  assert.deepEqual(payload.messages, [{ role: 'user', content: '  hi  ' }]);
  // and normalizeMessages is pure: new array, canonical copy, input intact
  const canonical = cache.normalizeMessages(messages);
  assert.notEqual(canonical, messages);
  assert.equal(canonical[0].content, 'hi');
  assert.deepEqual(canonical, cache.normalizeMessages(messages));
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

// --- R4 (review 2026-09-10): the slotting measurement -------------------------------------------
// Decides whether URL/email literal slotting earns its keep, and prices the number/date gate without
// turning it on. The measurement must not change what the key DOES, so this also guards the refactor
// that made the slotting rules one shared list (the key tests above remain the regression guard for
// the output; these cover the reporting).
const cacheMod = require('../cache');

test('slottingFlags() reports the unconditional rules that fire', () => {
  const f = cacheMod.slottingFlags([
    { role: 'user', content: 'see https://example.com/a and write to me@example.com' }
  ]);
  assert.equal(f.url, 1, 'a URL fires the url rule');
  assert.equal(f.email, 1, 'an address fires the email rule');
});

test('slottingFlags() reports GATED rules even while the gate is off', () => {
  const saved = process.env.CACHE_KEY_SLOT_NUMBERS;
  delete process.env.CACHE_KEY_SLOT_NUMBERS;
  try {
    const f = cacheMod.slottingFlags([{ role: 'user', content: 'on 2026-09-10 there were 42 items' }]);
    assert.equal(f.date, 1, 'the date rule must be visible, so the decision can be priced without enabling it');
    assert.equal(f.number, 1, 'same for numbers');
    assert.equal(f.numbers_gate, 0, 'and the gate state is reported beside it');
  } finally {
    if (saved === undefined) delete process.env.CACHE_KEY_SLOT_NUMBERS;
    else process.env.CACHE_KEY_SLOT_NUMBERS = saved;
  }
});

test('slottingFlags() reports the gate ON when it is set, and matches no rule in plain prose', () => {
  const saved = process.env.CACHE_KEY_SLOT_NUMBERS;
  process.env.CACHE_KEY_SLOT_NUMBERS = 'true';
  try {
    const on = cacheMod.slottingFlags([{ role: 'user', content: 'plain prose, nothing special here' }]);
    assert.equal(on.numbers_gate, 1);
    assert.equal(on.url + on.email + on.date + on.number, 0, 'plain prose must fire nothing');
  } finally {
    if (saved === undefined) delete process.env.CACHE_KEY_SLOT_NUMBERS;
    else process.env.CACHE_KEY_SLOT_NUMBERS = saved;
  }
});

test('the number/date gate still changes the KEY, and only when enabled', () => {
  const saved = process.env.CACHE_KEY_SLOT_NUMBERS;
  const payload = { model: 'gpt-4o', messages: [{ role: 'user', content: 'answer for 2026-09-10' }] };
  try {
    delete process.env.CACHE_KEY_SLOT_NUMBERS;
    const off = cacheMod.buildCacheKey(null, payload);
    process.env.CACHE_KEY_SLOT_NUMBERS = 'true';
    const on = cacheMod.buildCacheKey(null, payload);
    assert.notEqual(off, on, 'enabling the gate must change the key for a dated prompt');
  } finally {
    if (saved === undefined) delete process.env.CACHE_KEY_SLOT_NUMBERS;
    else process.env.CACHE_KEY_SLOT_NUMBERS = saved;
  }
});
