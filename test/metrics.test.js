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
  const rows = await metrics.readRecent();
  assert.deepEqual(rows, []);
});

test('record() writes a line that readRecent() can read back, with a timestamp added', async () => {
  const metrics = freshMetrics();
  metrics.record({ provider: 'openai', latency_ms: 120, cost_usd: 0.001 });
  await flush();

  const rows = await metrics.readRecent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'openai');
  assert.ok(rows[0].timestamp, 'expected record() to stamp a timestamp');
});

test('a malformed line in the log is skipped, not fatal', async () => {
  const metrics = freshMetrics();
  metrics.record({ provider: 'openai', latency_ms: 10 });
  await flush();
  fs.appendFileSync(metrics.currentLogPath(), 'not valid json\n');
  metrics.record({ provider: 'anthropic', latency_ms: 20 });
  await flush();

  const rows = await metrics.readRecent();
  assert.equal(rows.length, 2);
});

test('currentLogPath() names a per-UTC-day file, and record() actually writes there', async () => {
  const metrics = freshMetrics();
  const today = new Date().toISOString().slice(0, 10);
  assert.match(metrics.currentLogPath(), new RegExp(`metrics-${today}\\.jsonl$`));

  metrics.record({ provider: 'openai' });
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

  const rows = await metrics.readRecent(10);
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

  const rows = await metrics.readRecent(5);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.tag.startsWith('row-')), 'the older file should not have been needed to satisfy limit:5');
});

test('pruneOlderThan() deletes only day-files strictly older than the cutoff, and is never called by anything else in this module', async () => {
  const metrics = freshMetrics();
  const oldPath = path.join(metrics.DATA_DIR, 'metrics-2026-01-01.jsonl');
  const recentPath = metrics.currentLogPath();
  fs.writeFileSync(oldPath, '{}\n');
  metrics.record({ provider: 'openai' });
  await flush();

  const deleted = await metrics.pruneOlderThan(30);
  assert.deepEqual(deleted, [oldPath]);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(recentPath), true, "pruneOlderThan should never touch today's file");
});

test('providerStats() computes error rate and average latency per provider', async () => {
  const metrics = freshMetrics();
  metrics.record({ provider: 'openai', latency_ms: 100 });
  metrics.record({ provider: 'openai', latency_ms: 200 });
  metrics.record({ provider: 'openai', error: 'boom' });
  await flush();

  const stats = await metrics.providerStats();
  assert.equal(stats.openai.sampleSize, 3);
  assert.equal(stats.openai.errorRate, 1 / 3);
  assert.equal(stats.openai.avgLatencyMs, 150); // average of the two non-error latencies
});

test('providerStats() only considers the most recent windowSize entries', async () => {
  const metrics = freshMetrics();
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'openai', error: 'boom' });
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'openai', latency_ms: 50 });
  await flush();

  const stats = await metrics.providerStats(5); // window covers only the second batch
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
  metrics.record({
    provider: 'anthropic',
    error: '429 {"type":"error","error":{"type":"rate_limit_error"}}',
    error_type: 'rate_limit_error'
  });
  metrics.record({ provider: 'anthropic', latency_ms: 500 }); // recovered in between
  metrics.record({
    provider: 'anthropic',
    error: '401 {"type":"error","error":{"type":"authentication_error"}}',
    error_type: 'authentication_error'
  });
  await flush();

  const stats = await metrics.providerStats();
  assert.equal(stats.anthropic.lastErrorType, 'authentication_error');
  assert.ok(stats.anthropic.lastErrorAt, 'expected a timestamp on the last error');
});

test('providerStats() classifies on the fly for an older record written before error_type existed', async () => {
  const metrics = freshMetrics();
  // No error_type field at all - simulates a log line from before this
  // feature existed, still stored on disk after an upgrade.
  metrics.record({ provider: 'openai', error: '401 {"error":{"type":"authentication_error"}}' });
  await flush();

  const stats = await metrics.providerStats();
  assert.equal(stats.openai.lastErrorType, 'authentication_error');
});

test('providerStats() reports lastErrorType as null for a provider with no errors at all', async () => {
  const metrics = freshMetrics();
  metrics.record({ provider: 'openai', latency_ms: 100 });
  await flush();

  const stats = await metrics.providerStats();
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

  const summary = await metrics.rangeSummary(14);
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
  metrics.record({ provider: 'openai', cost_usd: 0.01, cache_hit: false });
  metrics.record({ provider: 'openai', cost_usd: 0, cache_hit: true, cache_type: 'exact' });
  metrics.record({ provider: 'openai', cost_usd: 0, cache_hit: true, cache_type: 'semantic' });
  metrics.record({ provider: 'openai', error: 'boom' });
  await flush();

  const summary = await metrics.rangeSummary(14);
  assert.equal(summary.sample_size, 4);
  assert.equal(summary.cache_hit_rate.exact, 0.25);
  assert.equal(summary.cache_hit_rate.semantic, 0.25);
  assert.equal(summary.cache_hit_rate.combined, 0.5);
  assert.equal(summary.error_rate, 0.25);
});

test('rangeSummary() computes per-provider cost, requests, error rate and avg latency', async () => {
  const metrics = freshMetrics();
  metrics.record({ provider: 'openai', cost_usd: 0.01, latency_ms: 100 });
  metrics.record({ provider: 'openai', cost_usd: 0.02, latency_ms: 300 });
  metrics.record({ provider: 'openai', error: 'boom' });
  metrics.record({ provider: 'anthropic', cost_usd: 0.5, latency_ms: 200 });
  await flush();

  const summary = await metrics.rangeSummary(14);
  assert.equal(summary.by_provider.openai.requests, 3);
  assert.equal(summary.by_provider.openai.cost_usd, 0.03);
  assert.equal(summary.by_provider.openai.errorRate, 1 / 3);
  assert.equal(summary.by_provider.openai.avgLatencyMs, 200); // average of the two non-error latencies
  assert.equal(summary.by_provider.anthropic.requests, 1);
  assert.equal(summary.by_provider.anthropic.cost_usd, 0.5);
});

test('rangeSummary() on an empty log returns zeroed rates, not NaN or a crash', async () => {
  const metrics = freshMetrics();
  const summary = await metrics.rangeSummary(14);
  assert.equal(summary.sample_size, 0);
  assert.equal(summary.cache_hit_rate.combined, 0);
  assert.equal(summary.error_rate, 0);
  assert.deepEqual(summary.daily, []);
  assert.deepEqual(summary.by_provider, {});
});
