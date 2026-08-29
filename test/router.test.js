const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// metrics.js and router.js both read env vars once at require time, so
// each test gets a fresh, isolated metrics log by clearing the require
// cache and pointing METRICS_LOG_PATH at a throwaway temp file first.
function freshModules(metricsLogPath) {
  process.env.METRICS_LOG_PATH = metricsLogPath;
  delete require.cache[require.resolve('../metrics')];
  delete require.cache[require.resolve('../router')];
  const metrics = require('../metrics');
  const router = require('../router');
  return { metrics, router };
}

function tempLogPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-')), 'metrics.jsonl');
}

test('isVirtualModel only matches the router: prefix', () => {
  const { router } = freshModules(tempLogPath());
  assert.equal(router.isVirtualModel('router:fast-cheap'), true);
  assert.equal(router.isVirtualModel('gpt-4o-mini'), false);
  assert.equal(router.isVirtualModel('claude-sonnet-4-5-20250929'), false);
  assert.equal(router.isVirtualModel(undefined), false);
});

test('pickCandidate returns an error for an unknown tier', async () => {
  const { router } = freshModules(tempLogPath());
  const decision = await router.pickCandidate('router:does-not-exist');
  assert.ok(decision.error);
});

test('pickCandidate picks the cheaper candidate when both are healthy (no history)', async () => {
  const { router } = freshModules(tempLogPath());
  // gpt-4o-mini ($0.15/$0.60 per 1M) is cheaper than claude-haiku-4-5
  // ($0.80/$4.00 per 1M) at the fixed comparison token counts - see
  // router.js's COMPARISON_INPUT_TOKENS/OUTPUT_TOKENS.
  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.provider, 'openai');
  assert.equal(decision.model, 'gpt-4o-mini');
  assert.equal(decision.reason.allUnhealthy, false);
});

test('pickCandidate exposes the full ranked candidate list, in the same order as the top pick', async () => {
  const { router } = freshModules(tempLogPath());
  const decision = await router.pickCandidate('router:fast-cheap');
  assert.deepEqual(decision.rankedCandidates, [
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }
  ]);
  // The top pick is always the first entry - server.js's failover loop
  // relies on this to know which candidate it started with.
  assert.equal(decision.rankedCandidates[0].provider, decision.provider);
  assert.equal(decision.rankedCandidates[0].model, decision.model);
});

test('pickCandidate skips a candidate whose recent error rate is too high, even if cheaper', async () => {
  const logPath = tempLogPath();
  const { metrics, router } = freshModules(logPath);

  // Make openai (the cheaper candidate in router:fast-cheap) look
  // unhealthy: mostly errors in its recent history.
  for (let i = 0; i < 10; i++) {
    metrics.record({ provider: 'openai', error: 'simulated failure' });
  }
  metrics.record({ provider: 'anthropic', latency_ms: 500 });

  // Metrics writes go through a stream; give it a tick to flush before
  // reading the file back.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.provider, 'anthropic');
  assert.equal(decision.model, 'claude-haiku-4-5-20251001');
  assert.equal(decision.reason.allUnhealthy, false);
});

test('pickCandidate still returns a candidate when every option is unhealthy', async () => {
  const logPath = tempLogPath();
  const { metrics, router } = freshModules(logPath);

  for (let i = 0; i < 10; i++) {
    metrics.record({ provider: 'openai', error: 'simulated failure' });
    metrics.record({ provider: 'anthropic', error: 'simulated failure' });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.ok(decision.provider);
  assert.equal(decision.reason.allUnhealthy, true);
});

test('pickCandidate reports which strategy it used', async () => {
  const { router } = freshModules(tempLogPath());
  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.reason.strategy, 'cost'); // default, no ROUTER_STRATEGY set
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('ROUTER_STRATEGY=latency picks the fastest healthy candidate even when it costs more', async () => {
  const logPath = tempLogPath();
  process.env.ROUTER_STRATEGY = 'latency';
  const { metrics, router } = freshModules(logPath);

  // gpt-4o-mini is the cheaper candidate in router:fast-cheap, but make
  // it noticeably slower than claude-haiku here.
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'openai', latency_ms: 2000 });
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'anthropic', latency_ms: 100 });
  await flush();

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.provider, 'anthropic');
  assert.equal(decision.model, 'claude-haiku-4-5-20251001');
  assert.equal(decision.reason.strategy, 'latency');

  delete process.env.ROUTER_STRATEGY;
});

test('ROUTER_STRATEGY=latency falls back to cost as a tiebreaker when latency is equal (e.g. both unknown)', async () => {
  process.env.ROUTER_STRATEGY = 'latency';
  const { router } = freshModules(tempLogPath()); // no recorded latencies at all - both candidates are unknown

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.model, 'gpt-4o-mini'); // the cheaper of the two, same as the default cost strategy would pick

  delete process.env.ROUTER_STRATEGY;
});

test('ROUTER_STRATEGY=latency-guarded-cost excludes a candidate far slower than the fastest known one, even if cheaper', async () => {
  const logPath = tempLogPath();
  process.env.ROUTER_STRATEGY = 'latency-guarded-cost';
  const { metrics, router } = freshModules(logPath);

  // openai/gpt-4o-mini is the cheaper candidate, but 3000ms is far more
  // than 3x (the default guard multiplier) slower than anthropic's
  // 100ms - it should get excluded by the guard despite being cheaper.
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'openai', latency_ms: 3000 });
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'anthropic', latency_ms: 100 });
  await flush();

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.provider, 'anthropic');
  assert.equal(decision.reason.strategy, 'latency-guarded-cost');
  assert.equal(decision.reason.latencyGuardExcludedACandidate, true);

  delete process.env.ROUTER_STRATEGY;
});

test('ROUTER_STRATEGY=latency-guarded-cost keeps a candidate that is only modestly slower, and still picks by cost', async () => {
  const logPath = tempLogPath();
  process.env.ROUTER_STRATEGY = 'latency-guarded-cost';
  const { metrics, router } = freshModules(logPath);

  // 150ms is only 1.5x anthropic's 100ms - comfortably inside the
  // default 3x guard multiplier, so openai stays in the pool and wins
  // on cost as usual.
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'openai', latency_ms: 150 });
  for (let i = 0; i < 5; i++) metrics.record({ provider: 'anthropic', latency_ms: 100 });
  await flush();

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.model, 'gpt-4o-mini');
  assert.equal(decision.reason.latencyGuardExcludedACandidate, false);

  delete process.env.ROUTER_STRATEGY;
});

test('ROUTER_STRATEGY=latency-guarded-cost degrades to plain cost when there is no latency data yet', async () => {
  process.env.ROUTER_STRATEGY = 'latency-guarded-cost';
  const { router } = freshModules(tempLogPath()); // no history at all

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.model, 'gpt-4o-mini'); // nothing to guard against yet
  assert.equal(decision.reason.latencyGuardExcludedACandidate, false);

  delete process.env.ROUTER_STRATEGY;
});

test('an unrecognized ROUTER_STRATEGY value falls back to "cost" rather than erroring', async () => {
  process.env.ROUTER_STRATEGY = 'fastest-vibes';
  const { router } = freshModules(tempLogPath());

  const decision = await router.pickCandidate('router:fast-cheap');
  assert.equal(decision.reason.strategy, 'cost');
  assert.equal(decision.model, 'gpt-4o-mini');

  delete process.env.ROUTER_STRATEGY;
});
