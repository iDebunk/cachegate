const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// tracing.js uses @opentelemetry/api, whose default (SDK-not-initialized)
// tracer is a no-op. These tests exercise exactly that inert path - the
// helpers must be safe no-ops that return fn's result and never throw when
// the SDK is absent (OTEL_ENABLED unset). The real span/export path is
// gated behind OTEL_ENABLED + OTEL_EXPORTER_OTLP_ENDPOINT and needs a live
// collector, which is out of scope for unit tests.
const tracing = require('../tracing');

test('initTracing is a safe no-op when OTEL_ENABLED is unset', () => {
  delete process.env.OTEL_ENABLED;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  assert.doesNotThrow(() => tracing.initTracing());
});

test('withSpan returns fn result (no-op tracer)', async () => {
  const result = await tracing.withSpan('cache.exact', { trace_id: 'abc' }, async () => 42);
  assert.equal(result, 42);
});

test('withRootSpan returns fn result (no-op tracer)', async () => {
  const result = await tracing.withRootSpan('gpt-4o-mini', { trace_id: 'abc' }, async () => 'ok');
  assert.equal(result, 'ok');
});

test('withSpan propagates a thrown error (no-op tracer)', async () => {
  await assert.rejects(
    () => tracing.withSpan('dispatch', {}, async () => { throw new Error('boom'); }),
    /boom/
  );
});

test('withRootSpan propagates a thrown error (no-op tracer)', async () => {
  await assert.rejects(
    () => tracing.withRootSpan('root', {}, async () => { throw new Error('boom'); }),
    /boom/
  );
});

// Step 36.1: trace_id + joined_trace_id are first-class metrics fields on the
// JSONL backend (the file backend just serializes the entry verbatim, so a
// record carrying trace_id reads it back unchanged).
function freshMetrics(logPath) {
  process.env.METRICS_LOG_PATH = logPath;
  delete require.cache[require.resolve('../metrics')];
  return require('../metrics');
}

test('trace_id and joined_trace_id survive the record -> readRecent round-trip (JSONL)', async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-id-test-')), 'metrics.jsonl');
  const metrics = freshMetrics(logPath);
  metrics.record(null, {
    provider: 'openai',
    model: 'gpt-4o-mini',
    cache_hit: false,
    coalesced: true,
    trace_id: 'trace-joiner-1',
    joined_trace_id: 'trace-leader-1'
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the write stream flush
  const rows = await metrics.readRecent(null, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trace_id, 'trace-joiner-1');
  assert.equal(rows[0].joined_trace_id, 'trace-leader-1');
});

test('a record with no trace_id reads back without the field (fail-open for old rows)', async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-id-test-')), 'metrics.jsonl');
  const metrics = freshMetrics(logPath);
  metrics.record(null, { provider: 'openai', model: 'gpt-4o-mini', cache_hit: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = await metrics.readRecent(null, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trace_id, undefined);
  assert.equal(rows[0].joined_trace_id, undefined);
});
