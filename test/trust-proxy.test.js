// R3, from the four-repo review (2026-09-10): `trust proxy` must be configurable, and its default must
// be secure rather than convenient.
//
// The regression this pins: it was hardcoded to `1`. That is correct for Cachegate Cloud's single-hop
// topology and WRONG for the topology this repo's own README documents (`docker run -p 4000:4000`, no
// proxy). There, `1` tells express to trust X-Forwarded-For, which is client-controlled, so any caller
// can present a fresh IP on every request and the per-IP limiter on the key-holding routes is defeated
// - fail-OPEN, silent, and exactly the sort of thing nobody notices until it is exploited.
//
// `false` behind a real proxy is fail-CLOSED and loud: the limiter keys globally, one env var away
// from correct. So the default is false, every other security decision in server.js already fails
// closed, and an unparseable value refuses to boot rather than guessing at limiter scope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTrustProxy } = require('../server');

test('unset means NO proxy assumed - never 1', () => {
  const warn = console.warn;
  console.warn = () => {}; // the Render-only warning is not the subject here
  try {
    assert.equal(resolveTrustProxy(undefined), false);
    assert.equal(resolveTrustProxy(''), false);
    assert.equal(resolveTrustProxy('   '), false);
  } finally {
    console.warn = warn;
  }
});

test('every off spelling is off, not merely falsy', () => {
  for (const value of ['false', 'FALSE', 'False', '0', 'off', 'OFF', 'no', ' false ']) {
    assert.equal(resolveTrustProxy(value), false, `expected ${JSON.stringify(value)} to mean off`);
  }
});

test('the Render warning fires only where a proxy is actually present', () => {
  const warn = console.warn;
  const seen = [];
  console.warn = (msg) => seen.push(String(msg));
  try {
    delete process.env.RENDER;
    delete process.env.RENDER_EXTERNAL_URL;
    resolveTrustProxy(undefined);
    assert.equal(seen.length, 0, 'no warning in the topology where false is the correct answer');

    process.env.RENDER = 'true';
    resolveTrustProxy(undefined);
    assert.equal(seen.length, 1, 'a proxied deployment with TRUST_PROXY unset must be told');
    assert.match(seen[0], /TRUST_PROXY/);
  } finally {
    delete process.env.RENDER;
    console.warn = warn;
  }
});

test('true and a hop count keep their real types', () => {
  assert.equal(resolveTrustProxy('true'), true);
  assert.equal(resolveTrustProxy('TRUE'), true);
  assert.equal(resolveTrustProxy('2'), 2);
  assert.equal(resolveTrustProxy('0'), false, '0 is documented as off, and express reads it the same way');
});

test('a proxy list or the express keywords are accepted, for real multi-hop topologies', () => {
  assert.deepEqual(resolveTrustProxy('loopback'), ['loopback']);
  assert.deepEqual(resolveTrustProxy('uniquelocal'), ['uniquelocal']);
  assert.deepEqual(resolveTrustProxy('10.0.0.1/8, 172.16.0.0/12'), ['10.0.0.1/8', '172.16.0.0/12']);
});

test('an unparseable value REFUSES TO BOOT instead of guessing at limiter scope', () => {
  assert.throws(() => resolveTrustProxy('yes please'), /TRUST_PROXY/);
  assert.throws(() => resolveTrustProxy('proxy.example.com'), /TRUST_PROXY/);
  assert.throws(() => resolveTrustProxy('1 2'), /TRUST_PROXY/);
});
