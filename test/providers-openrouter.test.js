// providers/openrouter.test.js - offline. No API key, no network.
//
// The property worth guarding here is the one that would be invisible in
// review: when OpenRouter's price for a model is not known, cost must be null
// and NEVER 0. This router routes to the cheapest healthy candidate, so a
// silent zero would make every unpriced model look free and win every
// comparison - the exact opposite of the product's promise.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const openrouter = require('../providers/openrouter');

function close(actual, expected, message) {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, got ${actual}`);
}

test('isOpenRouterModel accepts vendor/model ids and the explicit prefix, and nothing else', () => {
  assert.equal(openrouter.isOpenRouterModel('deepseek/deepseek-chat'), true);
  assert.equal(openrouter.isOpenRouterModel('anthropic/claude-sonnet-4.5'), true);
  assert.equal(openrouter.isOpenRouterModel('openrouter/deepseek/deepseek-chat'), true);
  // Direct-provider ids must NOT be captured by the aggregator
  assert.equal(openrouter.isOpenRouterModel('gpt-4o-mini'), false);
  assert.equal(openrouter.isOpenRouterModel('claude-sonnet-4-5-20250929'), false);
  assert.equal(openrouter.isOpenRouterModel(undefined), false);
});

test('normalizeModel strips the explicit prefix so the wire id stays valid', () => {
  assert.equal(openrouter.normalizeModel('openrouter/deepseek/deepseek-chat'), 'deepseek/deepseek-chat');
  assert.equal(openrouter.normalizeModel('deepseek/deepseek-chat'), 'deepseek/deepseek-chat');
});

test('estimateCost is null before any pricing is loaded - never 0', () => {
  openrouter.setPricingTable(null);
  assert.equal(openrouter.estimateCost('deepseek/deepseek-chat', 1_000_000, 0), null);
});

test('setPricingTable converts per-token strings into USD per million', () => {
  openrouter.setPricingTable([
    { id: 'deepseek/deepseek-chat', pricing: { prompt: '0.0000002', completion: '0.0000008' } },
    { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
    { id: 'no-pricing-at-all' }
  ]);
  close(openrouter.estimateCost('deepseek/deepseek-chat', 1_000_000, 0), 0.2, 'input per 1M');
  close(openrouter.estimateCost('deepseek/deepseek-chat', 0, 1_000_000), 0.8, 'output per 1M');
  close(openrouter.estimateCost('free/model', 1_000_000, 1_000_000), 0, 'a genuinely free model prices at 0');
  assert.equal(openrouter.estimateCost('unknown/model', 1000, 1000), null, 'an unpriced model stays null');
});

test('estimateCost follows an openrouter/-prefixed id through to the table', () => {
  openrouter.setPricingTable([{ id: 'deepseek/deepseek-chat', pricing: { prompt: '0.0000002', completion: '0.0000008' } }]);
  close(openrouter.estimateCost('openrouter/deepseek/deepseek-chat', 1_000_000, 0), 0.2, 'prefixed id');
});

test('refreshPricing loads the catalog from the models endpoint and caches it', async () => {
  openrouter.setPricingTable(null);
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.ok(String(url).endsWith('/models'), `unexpected url ${url}`);
    return { ok: true, json: async () => ({ data: [{ id: 'meta/llama-3-70b', pricing: { prompt: '0.0000005', completion: '0.000001' } }] }) };
  };

  await openrouter.refreshPricing({ fetchImpl, force: true });
  close(openrouter.estimateCost('meta/llama-3-70b', 1_000_000, 0), 0.5, 'loaded from the endpoint');

  // Second call inside the TTL must not hit the network again.
  await openrouter.refreshPricing({ fetchImpl });
  assert.equal(calls, 1, 'the catalog is cached, not refetched per request');
});

test('a failed pricing fetch leaves dispatch working and cost unknown', async () => {
  openrouter.setPricingTable(null);
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await openrouter.refreshPricing({ fetchImpl, force: true });
  assert.equal(openrouter.estimateCost('deepseek/deepseek-chat', 1000, 1000), null, 'still unknown, not fabricated');
});

test('attributionHeaders sends only what the operator configured', () => {
  assert.deepEqual(openrouter.attributionHeaders({}), {});
  assert.deepEqual(
    openrouter.attributionHeaders({ OPENROUTER_SITE_URL: 'https://example.test', OPENROUTER_SITE_NAME: 'Cachegate' }),
    { 'HTTP-Referer': 'https://example.test', 'X-Title': 'Cachegate' }
  );
  // Half-configured is still valid: one header, no invented second one.
  assert.deepEqual(openrouter.attributionHeaders({ OPENROUTER_SITE_NAME: 'Cachegate' }), { 'X-Title': 'Cachegate' });
});

test('chat prefers the billed cost OpenRouter reports over our own estimate', async () => {
  openrouter.setPricingTable([{ id: 'deepseek/deepseek-chat', pricing: { prompt: '0.0000002', completion: '0.0000008' } }]);
  const client = {
    chat: {
      completions: {
        create: async () => ({
          provider: 'Together',
          choices: [{ message: { content: 'ok', tool_calls: undefined } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0.123456 }
        })
      }
    }
  };

  const result = await openrouter.chat(client, { model: 'deepseek/deepseek-chat', messages: [] });
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.cost_usd, 0.123456, 'the billed amount wins over our table');
  assert.equal(result.upstream_provider, 'Together', 'the upstream that actually served it is surfaced');
});

test('chat falls back to the local table when no billed cost is returned', async () => {
  openrouter.setPricingTable([{ id: 'deepseek/deepseek-chat', pricing: { prompt: '0.0000002', completion: '0.0000008' } }]);
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }
        })
      }
    }
  };
  const result = await openrouter.chat(client, { model: 'deepseek/deepseek-chat', messages: [] });
  close(result.cost_usd, 1.0, 'table-derived cost');
});

test('applyStreamChunk captures the billed cost from the final chunk', () => {
  const state = { content: '', inputTokens: 0, outputTokens: 0, billedCost: null, cachedInputTokens: 0 };
  openrouter.applyStreamChunk(state, { choices: [{ delta: { content: 'a' } }] }, () => {});
  openrouter.applyStreamChunk(state, {
    choices: [],
    usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.0042, prompt_tokens_details: { cached_tokens: 30 } }
  }, () => {});

  assert.equal(state.content, 'a');
  assert.equal(state.inputTokens, 50);
  assert.equal(state.billedCost, 0.0042);
  assert.equal(state.cachedInputTokens, 30);
});
