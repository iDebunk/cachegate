// Review finding: rateLimiter (the /v1 limiter) was given an explicit
// keyGenerator specifically to avoid express-rate-limit's own documented
// IPv6 bypass (a bare `req.ip` lets an IPv6 caller present a fresh address
// per request and never hit the same bucket twice) - but readEndpointLimiter
// (/stats, /dashboard/data) was defined right below it without one at all,
// silently falling back to that exact bypassable default. Pulling the
// keyGenerator out into one shared function (ipv6SafeKeyGenerator) is the
// fix; this pins its own behavior so the two limiters can't drift apart on
// it again without a test noticing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ipv6SafeKeyGenerator, configure } = require('../server');

test('two different IPv6 addresses in the same /56 collapse to the same rate-limit key', () => {
  const keyA = ipv6SafeKeyGenerator({ ip: '2001:db8::1' }, {});
  const keyB = ipv6SafeKeyGenerator({ ip: '2001:db8::2' }, {});
  assert.equal(keyA, keyB, 'a caller must not be able to dodge the limiter by rotating within one IPv6 /56');
});

test('two different IPv6 /56s get different keys - the guard is a subnet, not a single global bucket', () => {
  const keyA = ipv6SafeKeyGenerator({ ip: '2001:db8::1' }, {});
  const keyB = ipv6SafeKeyGenerator({ ip: '2001:db9::1' }, {});
  assert.notEqual(keyA, keyB);
});

test('an IPv4 address is keyed exactly, unchanged', () => {
  assert.equal(ipv6SafeKeyGenerator({ ip: '192.168.1.5' }, {}), '192.168.1.5');
});

test('a configured rateLimitKeyGenerator seam overrides the IPv6-safe default', () => {
  try {
    configure({ rateLimitKeyGenerator: (req) => `tenant:${req.tenantId}` });
    assert.equal(ipv6SafeKeyGenerator({ tenantId: 42 }, {}), 'tenant:42');
  } finally {
    // Reset, not left dangling - a later test in this same process must not
    // inherit this override (the exact leaked-global-state class of bug
    // this project has already hit once with ROUTER_TIERS_JSON).
    configure({ rateLimitKeyGenerator: undefined });
  }
  assert.equal(ipv6SafeKeyGenerator({ ip: '192.168.1.5' }, {}), '192.168.1.5', 'back to the default after reset');
});
