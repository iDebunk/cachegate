const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshMetrics() {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-')), 'metrics.jsonl');
  process.env.METRICS_LOG_PATH = logPath;
  delete require.cache[require.resolve('../metrics')];
  return require('../metrics');
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('readRecent returns [] when no log file exists yet', async () => {
  const metrics = freshMetrics();
  const rows = await metrics.readRecent(null);
  assert.deepEqual(rows, []);
});

test('record() writes a line that readRecent() can read back, with a timestamp added', async () => {
  const metrics = freshMetrics();
  metrics.record(null, { provider: 'openai', latency_ms: 120, cost_usd: 0.001 });
  await flush();

  const rows = await metrics.readRecent(null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'openai');
  assert.ok(rows[0].timestamp, 'expected record() to stamp a timestamp');
});

test('a malformed line in the log is skipped, not fatal', async () => {
  const metrics = freshMetrics();
  metrics.record(null, { provider: 'openai', latency_ms: 10 });
  await flush();
  fs.appendFileSync(metrics.currentLogPath(), 'not valid json\n');
  metrics.record(null, { provider: 'anthropic', latency_ms: 20 });
  await flush();

  const rows = await metrics.readRecent(null);
  assert.equal(rows.length, 2);
});

test('currentLogPath() names a per-UTC-day file, and record() actually writes there', async () => {
  const metrics = freshMetrics();
  const today = new Date().toISOString().slice(0, 10);
  assert.match(metrics.currentLogPath(), new RegExp(`metrics-${today}\\.jsonl$`));

  metrics.record(null, { provider: 'openai' });
  await flush();
  assert.ok(fs.existsSync(metrics.currentLogPath()), "record() should write to today's rotated file");
});

test('listLogFiles() finds only files matching the rotation naming pattern, sorted ascending by date', async () => {
  const metrics = freshMetrics();
  fs.writeFileSync(path.join(metrics.DATA_DIR, 'metrics-2026-08-10.jsonl'), '');
  fs.writeFileSync(path.join(metrics.DATA_DIR, 'metrics-2026-08-01.jsonl'), '');
  fs.writeFileSync(path.join(metrics.DATA_DIR, 'not-a-metrics-file.txt'), '');

  const files = await metrics.listLogFiles();
  assert.deepEqual(files.map((f) => f.date), ['2026-08-01', '2026-08-10']);
});

test('readRecent() aggregates across multiple real day-files, newest data included first', async () => {
  const metrics = freshMetrics();
  fs.writeFileSync(
    path.join(metrics.DATA_DIR, 'metrics-2026-08-01.jsonl'),
    JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', provider: 'anthropic', tag: 'old' }) + '\n'
  );
  fs.writeFileSync(
    path.join(metrics.DATA_DIR, 'metrics-2026-08-02.jsonl'),
    JSON.stringify({ timestamp: '2026-08-02T00:00:00.000Z', provider: 'openai', tag: 'newer' }) + '\n'
  );

  const rows = await metrics.readRecent(null, 10);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.tag), ['old', 'newer']); // chronological order preserved
});

test('readRecent(limit) stops opening older files once enough rows are collected', async () => {
  const metrics = freshMetrics();
  fs.writeFileSync(
    path.join(metrics.DATA_DIR, 'metrics-2026-08-01.jsonl'),
    JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', tag: 'should-not-be-needed' }) + '\n'
  );
  fs.writeFileSync(
    path.join(metrics.DATA_DIR, 'metrics-2026-08-02.jsonl'),
    Array.from({ length: 5 }, (_, i) => JSON.stringify({ timestamp: '2026-08-02T00:00:00.000Z', tag: `row-${i}` })).join('\n') + '\n'
  );

  const rows = await metrics.readRecent(null, 5);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.tag.startsWith('row-')), 'the older file should not have been needed to satisfy limit:5');
});

test('pruneOlderThan() deletes only day-files strictly older than the cutoff, and is never called by anything else in this module', async () => {
  const metrics = freshMetrics();
  const oldPath = path.join(metrics.DATA_DIR, 'metrics-2026-01-01.jsonl');
  const recentPath = metrics.currentLogPath();
  fs.writeFileSync(oldPath, '{}\n');
  metrics.record(null, { provider: 'openai' });
  await flush();

  const deleted = await metrics.pruneOlderThan(30);
  assert.deepEqual(deleted, [oldPath]);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(recentPath), true, "pruneOlderThan should never touch today's file");
});

test('pruneScopedOlderThan() is a documented no-op on the JSONL file backend (scopes share per-day files)', async () => {
  const metrics = freshMetrics();
  metrics.record('tenant-a', { provider: 'openai' });
  await flush();

  // The file backend cannot excise one scope without rewriting the
  // shared append-only day files, so a scoped prune must delete nothing
  // (and warn) rather than silently drop other tenants' rows.
  const deleted = await metrics.pruneScopedOlderThan('tenant-a', 30);
  assert.deepEqual(deleted, []);
  // Nothing was deleted: the tenant-a row still reads back.
  const rows = await metrics.readRecent('tenant-a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'openai');
});

test('pruneScopedOlderThan() rejects on a null/undefined scope (fail-closed, not a silent no-op)', async () => {
  const metrics = freshMetrics();
  await assert.rejects(metrics.pruneScopedOlderThan(null, 30), /non-null scope/);
  await assert.rejects(metrics.pruneScopedOlderThan(undefined, 30), /non-null scope/);
});

test('providerStats() computes error rate and average latency per provider', async () => {
  const metrics = freshMetrics();
  metrics.record(null, { provider: 'openai', latency_ms: 100 });
  metrics.record(null, { provider: 'openai', latency_ms: 200 });
  metrics.record(null, { provider: 'openai', error: 'boom' });
  await flush();

  const stats = await metrics.providerStats(null);
  assert.equal(stats.openai.sampleSize, 3);
  assert.equal(stats.openai.errorRate, 1 / 3);
  assert.equal(stats.openai.avgLatencyMs, 150); // average of the two non-error latencies
});

test('providerStats() only considers the most recent windowSize entries', async () => {
  const metrics = freshMetrics();
  for (let i = 0; i < 5; i++) metrics.record(null, { provider: 'openai', error: 'boom' });
  for (let i = 0; i < 5; i++) metrics.record(null, { provider: 'openai', latency_ms: 50 });
  await flush();

  const stats = await metrics.providerStats(null, 5); // window covers only the second batch
  assert.equal(stats.openai.errorRate, 0);
  assert.equal(stats.openai.avgLatencyMs, 50);
});

test('classifyErrorType() reads Anthropic\'s own {error:{type}} shape (SDK message = "<status> <json>")', () => {
  const metrics = freshMetrics();
  const msg = '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}';
  assert.equal(metrics.classifyErrorType(msg), 'authentication_error');
});

test('classifyErrorType() reads OpenAI\'s own {error:{type,code}} shape', () => {
  const metrics = freshMetrics();
  const msg = '429 {"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}';
  assert.equal(metrics.classifyErrorType(msg), 'insufficient_quota');
});

test('classifyErrorType() reads an invalid-key error identified only by code, not type', () => {
  const metrics = freshMetrics();
  const msg = '401 {"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}';
  assert.equal(metrics.classifyErrorType(msg), 'authentication_error');
});

test('classifyErrorType() falls back to keyword matching when the message has no parseable JSON body', () => {
  const metrics = freshMetrics();
  assert.equal(metrics.classifyErrorType('connect ECONNREFUSED - the key looks invalid'), 'authentication_error');
  assert.equal(metrics.classifyErrorType('insufficient funds on this account'), 'insufficient_quota');
  assert.equal(metrics.classifyErrorType('429 rate limit exceeded, slow down'), 'rate_limit_error');
  assert.equal(metrics.classifyErrorType('connect ECONNREFUSED 127.0.0.1:4000'), 'unknown');
});

test('classifyErrorType() never throws on an empty/undefined message', () => {
  const metrics = freshMetrics();
  assert.equal(metrics.classifyErrorType(''), 'unknown');
  assert.equal(metrics.classifyErrorType(undefined), 'unknown');
});

test('providerStats() reports the MOST RECENT error\'s classified type, not an earlier one still in the window', async () => {
  const metrics = freshMetrics();
  metrics.record(null, {
    provider: 'anthropic',
    error: '429 {"type":"error","error":{"type":"rate_limit_error"}}',
    error_type: 'rate_limit_error'
  });
  metrics.record(null, { provider: 'anthropic', latency_ms: 500 }); // recovered in between
  metrics.record(null, {
    provider: 'anthropic',
    error: '401 {"type":"error","error":{"type":"authentication_error"}}',
    error_type: 'authentication_error'
  });
  await flush();

  const stats = await metrics.providerStats(null);
  assert.equal(stats.anthropic.lastErrorType, 'authentication_error');
  assert.ok(stats.anthropic.lastErrorAt, 'expected a timestamp on the last error');
});

test('providerStats() classifies on the fly for an older record written before error_type existed', async () => {
  const metrics = freshMetrics();
  // No error_type field at all - simulates a log line from before this
  // feature existed, still stored on disk after an upgrade.
  metrics.record(null, { provider: 'openai', error: '401 {"error":{"type":"authentication_error"}}' });
  await flush();

  const stats = await metrics.providerStats(null);
  assert.equal(stats.openai.lastErrorType, 'authentication_error');
});

test('providerStats() reports lastErrorType as null for a provider with no errors at all', async () => {
  const metrics = freshMetrics();
  metrics.record(null, { provider: 'openai', latency_ms: 100 });
  await flush();

  const stats = await metrics.providerStats(null);
  assert.equal(stats.openai.lastErrorType, null);
  assert.equal(stats.openai.lastErrorAt, null);
});

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function appendRaw(metrics, entry) {
  // Deliberately appended to TODAY's physical file regardless of the
  // entry's own (possibly historical) timestamp - this test is about
  // rangeSummary()'s PER-ROW timestamp filtering, not file rotation
  // (that has its own dedicated tests above). Today's file always
  // passes rangeSummary()'s file-level date filter for any days >= 0,
  // so the row-level filter is what's actually being exercised here.
  fs.appendFileSync(metrics.currentLogPath(), JSON.stringify(entry) + '\n');
}

test('rangeSummary() buckets by calendar day and excludes rows outside the window', async () => {
  const metrics = freshMetrics();
  appendRaw(metrics, { timestamp: isoDaysAgo(0), provider: 'openai', cost_usd: 0.01, cache_hit: false });
  appendRaw(metrics, { timestamp: isoDaysAgo(0), provider: 'openai', cost_usd: 0.02, cache_hit: true, cache_type: 'exact' });
  appendRaw(metrics, { timestamp: isoDaysAgo(1), provider: 'anthropic', cost_usd: 0.05, cache_hit: true, cache_type: 'semantic' });
  appendRaw(metrics, { timestamp: isoDaysAgo(30), provider: 'anthropic', cost_usd: 99, cache_hit: false }); // outside a 14-day window

  const summary = await metrics.rangeSummary(null, 14);
  assert.equal(summary.sample_size, 3);
  assert.equal(summary.total_cost_usd, 0.08);
  assert.equal(summary.daily.length, 2); // two distinct calendar days, the 30-day-old row excluded
  const todayBucket = summary.daily[summary.daily.length - 1];
  assert.equal(todayBucket.requests, 2);
  assert.equal(todayBucket.exact_hits, 1);
  assert.equal(todayBucket.misses, 1);
});

test('rangeSummary() reports exact/semantic/combined hit rate and error rate separately', async () => {
  const metrics = freshMetrics();
  metrics.record(null, { provider: 'openai', cost_usd: 0.01, cache_hit: false });
  metrics.record(null, { provider: 'openai', cost_usd: 0, cache_hit: true, cache_type: 'exact' });
  metrics.record(null, { provider: 'openai', cost_usd: 0, cache_hit: true, cache_type: 'semantic' });
  metrics.record(null, { provider: 'openai', error: 'boom' });
  await flush();

  const summary = await metrics.rangeSummary(null, 14);
  assert.equal(summary.sample_size, 4);
  assert.equal(summary.cache_hit_rate.exact, 0.25);
  assert.equal(summary.cache_hit_rate.semantic, 0.25);
  assert.equal(summary.cache_hit_rate.combined, 0.5);
  assert.equal(summary.error_rate, 0.25);
});

test('rangeSummary() computes per-provider cost, requests, error rate and avg latency', async () => {
  const metrics = freshMetrics();
  metrics.record(null, { provider: 'openai', cost_usd: 0.01, latency_ms: 100 });
  metrics.record(null, { provider: 'openai', cost_usd: 0.02, latency_ms: 300 });
  metrics.record(null, { provider: 'openai', error: 'boom' });
  metrics.record(null, { provider: 'anthropic', cost_usd: 0.5, latency_ms: 200 });
  await flush();

  const summary = await metrics.rangeSummary(null, 14);
  assert.equal(summary.by_provider.openai.requests, 3);
  assert.equal(summary.by_provider.openai.cost_usd, 0.03);
  assert.equal(summary.by_provider.openai.errorRate, 1 / 3);
  assert.equal(summary.by_provider.openai.avgLatencyMs, 200); // average of the two non-error latencies
  assert.equal(summary.by_provider.anthropic.requests, 1);
  assert.equal(summary.by_provider.anthropic.cost_usd, 0.5);
});

test('rangeSummary() on an empty log returns zeroed rates, not NaN or a crash', async () => {
  const metrics = freshMetrics();
  const summary = await metrics.rangeSummary(null, 14);
  assert.equal(summary.sample_size, 0);
  assert.equal(summary.cache_hit_rate.combined, 0);
  assert.equal(summary.error_rate, 0);
  assert.deepEqual(summary.daily, []);
  assert.deepEqual(summary.by_provider, {});
});

test('computeSavings() applies the per-model formula: avg miss cost × hits, summed across models', () => {
  const metrics = freshMetrics();
  const rows = [
    // model A: misses cost 0.01 and 0.03 (avg 0.02), one hit -> 0.02
    { timestamp: '2026-09-05T10:00:00.000Z', model: 'claude-haiku', cache_hit: false, cost_usd: 0.01 },
    { timestamp: '2026-09-05T11:00:00.000Z', model: 'claude-haiku', cache_hit: false, cost_usd: 0.03 },
    { timestamp: '2026-09-05T12:00:00.000Z', model: 'claude-haiku', cache_hit: true, cost_usd: 0 },
    // model B: separate, one miss 0.10, one hit -> 0.10
    { timestamp: '2026-09-05T13:00:00.000Z', model: 'claude-opus', cache_hit: false, cost_usd: 0.10 },
    { timestamp: '2026-09-05T14:00:00.000Z', model: 'claude-opus', cache_hit: true, cost_usd: 0 }
  ];
  assert.equal(metrics.computeSavings(rows).total, 0.12);
});

test('computeSavings() gives 0 for a model with hits but no recorded miss (never a cross-model average)', () => {
  const metrics = freshMetrics();
  const rows = [
    // opus has a miss; haiku has ONLY hits (no miss) - haiku contributes 0,
    // it must not borrow opus's miss cost (the cross-model-average trap).
    { timestamp: '2026-09-05T10:00:00.000Z', model: 'claude-opus', cache_hit: false, cost_usd: 0.10 },
    { timestamp: '2026-09-05T11:00:00.000Z', model: 'claude-haiku', cache_hit: true, cost_usd: 0 }
  ];
  assert.equal(metrics.computeSavings(rows).total, 0);
});

test('computeSavings() ignores error rows and model-less rows, and buckets per day', () => {
  const metrics = freshMetrics();
  const rows = [
    // an ERROR "miss" must not count toward the miss cost
    { timestamp: '2026-09-05T10:00:00.000Z', model: 'claude-haiku', cache_hit: false, cost_usd: 0.99, error: 'boom' },
    { timestamp: '2026-09-05T11:00:00.000Z', model: 'claude-haiku', cache_hit: false, cost_usd: 0.02 },
    { timestamp: '2026-09-05T12:00:00.000Z', model: 'claude-haiku', cache_hit: true, cost_usd: 0 },
    // no model -> skipped entirely
    { timestamp: '2026-09-05T13:00:00.000Z', provider: 'openai', cache_hit: false, cost_usd: 0.50 }
  ];
  const savings = metrics.computeSavings(rows);
  assert.equal(savings.total, 0.02); // avg of [0.02] (error excluded) × 1 hit
  assert.equal(savings.perDay.get('2026-09-05'), 0.02);
});

// Seams work (roadmap: engine/cloud "wrap it, don't fork it") - the two
// halves of the scope contract, regression-tested rather than just
// documented: a real scope isolates readers from every OTHER scope's
// rows, and the unscoped/global reader (scope === null/undefined) keeps
// seeing every row regardless of what any scoped caller ever wrote
// alongside it - the exact trap DeepSeek's cloud-side review flagged
// (E, roadmap doc): a naive "WHERE scope = null" filter would make
// global mode read NOTHING once any scoped row exists, not everything.
test('readRecent(scope) isolates one scope from another\'s recorded rows', async () => {
  const metrics = freshMetrics();
  metrics.record('tenant-a', { provider: 'openai', latency_ms: 1 });
  metrics.record('tenant-b', { provider: 'openai', latency_ms: 2 });
  await flush();

  const tenantA = await metrics.readRecent('tenant-a');
  const tenantB = await metrics.readRecent('tenant-b');
  assert.equal(tenantA.length, 1);
  assert.equal(tenantA[0].scope, 'tenant-a');
  assert.equal(tenantB.length, 1);
  assert.equal(tenantB[0].scope, 'tenant-b');
});

test('readRecent(null) - the global reader - sees every row, scoped and unscoped alike, not just rows with no scope', async () => {
  const metrics = freshMetrics();
  metrics.record(null, { provider: 'openai', latency_ms: 1 });
  metrics.record('tenant-a', { provider: 'openai', latency_ms: 2 });
  metrics.record('tenant-b', { provider: 'openai', latency_ms: 3 });
  await flush();

  const all = await metrics.readRecent(null);
  assert.equal(all.length, 3, 'global mode must read every row regardless of scope, not only unscoped ones');
});

test('providerStats(scope) and rangeSummary(scope) both respect the same isolation', async () => {
  const metrics = freshMetrics();
  metrics.record('tenant-a', { provider: 'openai', latency_ms: 100, cost_usd: 0.01 });
  metrics.record('tenant-b', { provider: 'openai', latency_ms: 900, cost_usd: 0.09 });
  await flush();

  const statsA = await metrics.providerStats('tenant-a');
  assert.equal(statsA.openai.avgLatencyMs, 100);

  const summaryB = await metrics.rangeSummary('tenant-b', 14);
  assert.equal(summaryB.by_provider.openai.cost_usd, 0.09);
  assert.equal(summaryB.sample_size, 1);
});
