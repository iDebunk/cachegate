// Review finding: metrics.js's Postgres pool used a hardcoded
// { rejectUnauthorized: false } - TLS encrypted the connection but never
// verified WHO it was talking to, with no way to opt into real
// verification even with the right CA in hand. pgSslConfig() is the fix;
// these pin its behavior directly - no live Postgres needed, it only
// builds the config object a caller passes to `pg`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pgSslConfig } = require('../metrics');

function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test('localhost and 127.0.0.1 connection strings get no TLS at all', () => {
  assert.equal(pgSslConfig('postgres://user:pass@localhost:5432/db'), false);
  assert.equal(pgSslConfig('postgres://user:pass@127.0.0.1:5432/db'), false);
});

test('a falsy connection string gets no TLS', () => {
  assert.equal(pgSslConfig(undefined), false);
  assert.equal(pgSslConfig(''), false);
});

test('default (nothing configured) is secure: rejectUnauthorized true, no custom CA', () => {
  withEnv({ PGSSL_CA: undefined, PGSSL_CA_PATH: undefined, PGSSL_INSECURE: undefined }, () => {
    const ssl = pgSslConfig('postgres://user:pass@some-host.example.com:5432/db');
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.ca, undefined, 'no PGSSL_CA/PGSSL_CA_PATH set - must not invent a CA');
  });
});

test('PGSSL_CA supplies the CA content directly, still verified', () => {
  withEnv({ PGSSL_CA: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----', PGSSL_CA_PATH: undefined, PGSSL_INSECURE: undefined }, () => {
    const ssl = pgSslConfig('postgres://user:pass@some-host.example.com:5432/db');
    assert.equal(ssl.rejectUnauthorized, true);
    assert.match(ssl.ca, /FAKE/);
  });
});

test('PGSSL_CA_PATH reads the CA from a file, still verified', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgssl-')), 'ca.pem');
  fs.writeFileSync(tmp, '-----BEGIN CERTIFICATE-----\nFROM_FILE\n-----END CERTIFICATE-----');
  withEnv({ PGSSL_CA: undefined, PGSSL_CA_PATH: tmp, PGSSL_INSECURE: undefined }, () => {
    const ssl = pgSslConfig('postgres://user:pass@some-host.example.com:5432/db');
    assert.equal(ssl.rejectUnauthorized, true);
    assert.match(ssl.ca, /FROM_FILE/);
  });
});

test('PGSSL_CA_PATH pointing at a missing file fails loud, not silently unverified', () => {
  withEnv({ PGSSL_CA: undefined, PGSSL_CA_PATH: '/does/not/exist.pem', PGSSL_INSECURE: undefined }, () => {
    assert.throws(() => pgSslConfig('postgres://user:pass@some-host.example.com:5432/db'), /PGSSL_CA_PATH/);
  });
});

test('PGSSL_CA takes priority over PGSSL_CA_PATH when both are set', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pgssl-')), 'ca.pem');
  fs.writeFileSync(tmp, '-----BEGIN CERTIFICATE-----\nFROM_FILE\n-----END CERTIFICATE-----');
  withEnv({ PGSSL_CA: 'INLINE_WINS', PGSSL_CA_PATH: tmp, PGSSL_INSECURE: undefined }, () => {
    const ssl = pgSslConfig('postgres://user:pass@some-host.example.com:5432/db');
    assert.equal(ssl.ca, 'INLINE_WINS');
  });
});

test('PGSSL_INSECURE=true is the explicit, loud escape hatch back to the old behavior', () => {
  const warn = console.warn;
  const seen = [];
  console.warn = (msg) => seen.push(String(msg));
  try {
    withEnv({ PGSSL_CA: undefined, PGSSL_CA_PATH: undefined, PGSSL_INSECURE: 'true' }, () => {
      const ssl = pgSslConfig('postgres://user:pass@some-host.example.com:5432/db');
      assert.deepEqual(ssl, { rejectUnauthorized: false });
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(seen.length, 1, 'going insecure must always print a warning, never silently');
  assert.match(seen[0], /PGSSL_INSECURE/);
});

test('anything other than the exact string "true" for PGSSL_INSECURE is treated as off', () => {
  for (const value of ['TRUE', '1', 'yes', ' true ']) {
    withEnv({ PGSSL_CA: undefined, PGSSL_CA_PATH: undefined, PGSSL_INSECURE: value }, () => {
      const ssl = pgSslConfig('postgres://user:pass@some-host.example.com:5432/db');
      assert.equal(ssl.rejectUnauthorized, true, `expected ${JSON.stringify(value)} to NOT enable insecure mode`);
    });
  }
});
