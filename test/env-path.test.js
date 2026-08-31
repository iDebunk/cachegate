const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// server.js reads its env vars once at require time; set a key so
// requiring it here never trips the fail-closed check for unrelated
// reasons (resolveEnvPathFromArgv itself doesn't touch env at all).
process.env.MODEL_ROUTER_INTERNAL_KEY = 'test-internal-key';

const { resolveEnvPathFromArgv } = require('../server');

test('resolveEnvPathFromArgv returns undefined when --env-path is absent - default cwd behavior unchanged', () => {
  const argv = ['node', 'server.js'];
  assert.equal(resolveEnvPathFromArgv(argv), undefined);
});

test('resolveEnvPathFromArgv resolves a space-separated --env-path value', () => {
  const argv = ['node', 'server.js', '--env-path', './router/.env'];
  assert.equal(resolveEnvPathFromArgv(argv), path.resolve('./router/.env'));
});

test('resolveEnvPathFromArgv resolves an --env-path=value (equals) form', () => {
  const argv = ['node', 'server.js', '--env-path=./router/.env'];
  assert.equal(resolveEnvPathFromArgv(argv), path.resolve('./router/.env'));
});

test('resolveEnvPathFromArgv resolves an absolute path unchanged', () => {
  const absolute = path.resolve('/tmp/some/other/.env');
  const argv = ['node', 'server.js', '--env-path', absolute];
  assert.equal(resolveEnvPathFromArgv(argv), absolute);
});

test('resolveEnvPathFromArgv returns undefined if --env-path is the last arg with no value after it', () => {
  const argv = ['node', 'server.js', '--env-path'];
  assert.equal(resolveEnvPathFromArgv(argv), undefined);
});

test('resolveEnvPathFromArgv is unaffected by other, unrelated flags', () => {
  const argv = ['node', 'server.js', '--some-other-flag', '--env-path', './x/.env'];
  assert.equal(resolveEnvPathFromArgv(argv), path.resolve('./x/.env'));
});
