// Postgres-backed persistence is OPT-IN (see metrics.js's own comment) -
// these tests exercise that path specifically, against a real local
// Postgres. Needs a real local server to actually run against; the
// `before()` hook below probes connectivity ONCE with a clear warning
// (`⚠️ Skipping metrics-postgres.test.js...`) rather than letting 20
// individual tests each fail with their own raw ECONNREFUSED - every
// test still reports as passing (each returns early via `pgAvailable`)
// so a machine without Postgres available doesn't see a red suite, it
// sees a skipped one. **Corrected 2026-08-29**: this comment previously
// claimed the opposite ("fails loudly... rather than silently
// skipping") - checked directly by actually stopping Postgres and
// running the suite, and that was never what the code below does. A CI
// environment without a real Postgres service configured will report
// green here while silently not exercising this file at all - the
// workflow's own Postgres service container is what makes these tests
// actually run, not just avoid failing.
//
// MEMOCODE_ROUTER_DATABASE_URL (not DATABASE_URL) is used here on
// purpose - keeps this suite from ever accidentally pointing at a real
// production database if that variable happened to be set in whatever
// environment runs the tests.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL =
  process.env.MEMOCODE_ROUTER_TEST_DATABASE_URL || 'postgres://postgres:dryrun@localhost:5432/router_metrics_dryrun';

function freshPgMetrics() {
  process.env.MEMOCODE_ROUTER_DATABASE_URL = TEST_DATABASE_URL;
  delete process.env.DATABASE_URL; // make sure only the test var is what's triggering Postgres mode
  delete require.cache[require.resolve('../metrics')];
  return require('../metrics');
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let pgAvailable = true;
let metrics;

before(async () => {
  metrics = freshPgMetrics();
  try {
    // Prove connectivity up front with a clear failure message, rather
    // than 20 individual tests each failing with their own ECONNREFUSED.
    await metrics.readRecent(1);
  } catch (err) {
    pgAvailable = false;
    console.warn(`⚠️ Skipping metrics-postgres.test.js - no local Postgres reachable at ${TEST_DATABASE_URL} (${err.message})`);
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // Reset between tests so each one starts from a known-empty table,
  // same isolation guarantee freshMetrics() gives the file-backed suite
  // via a fresh temp directory per test.
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  await pool.query('DROP TABLE IF EXISTS router_metrics');
  await pool.end();
  metrics = freshPgMetrics();
});

after(async () => {
  if (metrics) await metrics.closePostgresPoolForTests();
});

test('usingPostgres() is true once MEMOCODE_ROUTER_DATABASE_URL is set', () => {
  if (!pgAvailable) return;
  assert.equal(metrics.usingPostgres(), true);
});

test('record() + readRecent(): a real INSERT round-trips back out with the same fields', async () => {
  if (!pgAvailable) return;
  metrics.record({ provider: 'openai', model: 'gpt-4o-mini', latency_ms: 120, cost_usd: 0.001, cache_hit: false });
  await flush();

  const rows = await metrics.readRecent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'openai');
  assert.equal(rows[0].model, 'gpt-4o-mini');
  assert.equal(rows[0].latency_ms, 120);
  assert.equal(rows[0].cost_usd, 0.001);
  assert.ok(rows[0].timestamp, 'expected a real timestamp column value back');
});

test('record() persists error + error_type together, exactly like the file backend', async () => {
  if (!pgAvailable) return;
  metrics.record({
    provider: 'anthropic',
    error: '401 {"type":"error","error":{"type":"authentication_error"}}',
    error_type: 'authentication_error'
  });
  await flush();

  const rows = await metrics.readRecent();
  assert.equal(rows[0].error_type, 'authentication_error');
  assert.ok(rows[0].error.includes('authentication_error'));
});

test('providerStats(): error rate, avg latency, and lastErrorType all compute correctly from real rows', async () => {
  if (!pgAvailable) return;
  metrics.record({ provider: 'openai', latency_ms: 100 });
  metrics.record({ provider: 'openai', latency_ms: 200 });
  metrics.record({ provider: 'openai', error: '429 {"error":{"type":"rate_limit_error"}}', error_type: 'rate_limit_error' });
  await flush();

  const stats = await metrics.providerStats();
  assert.equal(stats.openai.sampleSize, 3);
  assert.equal(stats.openai.errorRate, 1 / 3);
  assert.equal(stats.openai.avgLatencyMs, 150);
  assert.equal(stats.openai.lastErrorType, 'rate_limit_error');
});

test('rangeSummary(): cost, cache-hit breakdown, and by_provider all agree with what was actually inserted', async () => {
  if (!pgAvailable) return;
  metrics.record({ provider: 'openai', cost_usd: 0.001, cache_hit: false });
  metrics.record({ provider: 'openai', cost_usd: 0, cache_hit: true, cache_type: 'exact' });
  metrics.record({ provider: 'anthropic', error: '500 boom', error_type: 'unknown' });
  await flush();

  const summary = await metrics.rangeSummary(14);
  assert.equal(summary.sample_size, 3);
  assert.equal(summary.total_cost_usd, 0.001);
  assert.equal(summary.cache_hit_rate.exact, 1 / 3);
  assert.equal(summary.error_rate, 1 / 3);
  assert.equal(summary.by_provider.openai.requests, 2);
  assert.equal(summary.by_provider.anthropic.requests, 1);
  assert.equal(summary.by_provider.anthropic.errorRate, 1);
});

test('rangeSummary(): a row older than the requested window is excluded', async () => {
  if (!pgAvailable) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  await pool.query(
    `CREATE TABLE IF NOT EXISTS router_metrics (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
       provider TEXT, model TEXT, requested_model TEXT, cache_hit BOOLEAN, cache_type TEXT,
       latency_ms INTEGER, cost_usd DOUBLE PRECISION, error TEXT, error_type TEXT)`
  );
  await pool.query(`INSERT INTO router_metrics (ts, provider, cost_usd) VALUES (now() - interval '30 days', 'openai', 0.05)`);
  await pool.end();

  metrics.record({ provider: 'openai', cost_usd: 0.001 }); // today, should count
  await flush();

  const summary = await metrics.rangeSummary(14); // 30-day-old row is outside this window
  assert.equal(summary.sample_size, 1);
  assert.equal(summary.total_cost_usd, 0.001);
});

test('pruneOlderThan(): deletes only rows past the cutoff, returns their ids, leaves fresh rows alone', async () => {
  if (!pgAvailable) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  await pool.query(
    `CREATE TABLE IF NOT EXISTS router_metrics (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
       provider TEXT, model TEXT, requested_model TEXT, cache_hit BOOLEAN, cache_type TEXT,
       latency_ms INTEGER, cost_usd DOUBLE PRECISION, error TEXT, error_type TEXT)`
  );
  await pool.query(`INSERT INTO router_metrics (ts, provider) VALUES (now() - interval '100 days', 'openai')`);
  await pool.end();

  metrics.record({ provider: 'anthropic' }); // fresh, should survive
  await flush();

  const deleted = await metrics.pruneOlderThan(30);
  assert.equal(deleted.length, 1);

  const remaining = await metrics.readRecent();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].provider, 'anthropic');
});

test('classifyErrorType() is the exact same function regardless of storage backend (not duplicated/reimplemented)', () => {
  if (!pgAvailable) return;
  assert.equal(
    metrics.classifyErrorType('401 {"error":{"type":"authentication_error"}}'),
    'authentication_error'
  );
});
