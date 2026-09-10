// model-router/providers/openrouter.js
//
// OpenRouter is an aggregator: one OpenAI-compatible endpoint in front of many
// vendors, addressed by `vendor/model` ids (e.g. `deepseek/deepseek-chat`,
// `anthropic/claude-sonnet-4.5`). Two things make it different from the direct
// providers in this directory:
//
//   1. ATTRIBUTION HEADERS. Requests may carry HTTP-Referer and X-Title so the
//      app shows up correctly in OpenRouter's own dashboard. They are optional
//      on the wire, so they are only sent when configured - inventing a
//      referer for someone's deployment would be worse than omitting it.
//
//   2. PRICING CANNOT BE A CONSTANT TABLE HERE. providers/openai.js hardcodes
//      two rates and providers/deepseek.js a handful, which is defensible for a
//      vendor with a handful of models. OpenRouter fronts hundreds, and their
//      prices change without a release of this project - a hardcoded table
//      would rot into wrong money silently, which is the one failure mode this
//      project's cost tracking exists to prevent. So the catalog is fetched
//      from OpenRouter's own /models endpoint and cached in-process.
//
//      WHEN PRICING IS UNKNOWN, cost is null - NEVER 0. A zero would be read as
//      "free" by anything that sorts candidates by cost, and this router's whole
//      pitch is routing to the cheapest healthy provider; a silent zero would
//      route everything to whichever model we failed to price. Callers must
//      treat null as "unknown, do not compare" (see providers/index.js).
const { OpenAI } = require('openai');

const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MODELS_PATH = '/models';
const PRICING_TTL_MS = Number(process.env.OPENROUTER_PRICING_TTL_MS) || 6 * 60 * 60 * 1000;

// model id -> { input, output } in USD per 1M tokens. Populated by
// refreshPricing() (network) or setPricingTable() (tests / a pinned table).
let pricingTable = null;
let pricingFetchedAt = 0;

/**
 * OpenRouter's documented optional attribution headers, from the environment.
 * A pure function so the "only send what was configured" rule is testable
 * without constructing an SDK client.
 */
function attributionHeaders(env = process.env) {
  const headers = {};
  if (env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL;
  if (env.OPENROUTER_SITE_NAME) headers['X-Title'] = env.OPENROUTER_SITE_NAME;
  return headers;
}

function buildClient(apiKey) {
  const headers = attributionHeaders();

  return new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    defaultHeaders: Object.keys(headers).length ? headers : undefined,
    timeout: Number(process.env.OPENROUTER_TIMEOUT_MS) || 60000
  });
}

// `vendor/model`, optionally written as `openrouter/vendor/model` so a caller
// can be explicit. Anything else is not an OpenRouter id.
function isOpenRouterModel(model) {
  if (typeof model !== 'string') return false;
  if (model.startsWith('openrouter/')) return true;
  return /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model);
}

function normalizeModel(model) {
  return typeof model === 'string' && model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
}

/** OpenRouter reports per-token prices as strings; convert to per-1M USD. */
function toPerMillion(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

function setPricingTable(entries) {
  // setPricingTable(null) resets to "price unknown" - what a test, or a caller
  // forcing a refresh, needs. An empty object would instead be a loaded-but-
  // empty table, which reads as "every model is unpriced" rather than "not
  // loaded yet" and would make the null-vs-zero distinction untestable.
  if (!entries) { pricingTable = null; pricingFetchedAt = 0; return null; }
  const table = {};
  for (const e of entries || []) {
    const id = e && (e.id || e.model);
    if (!id || !e.pricing) continue;
    const input = toPerMillion(e.pricing.prompt ?? e.pricing.input);
    const output = toPerMillion(e.pricing.completion ?? e.pricing.output);
    if (input === null) continue;
    table[id] = { input, output: output === null ? input : output };
  }
  pricingTable = table;
  pricingFetchedAt = Date.now();
  return table;
}

async function refreshPricing({ fetchImpl, force = false } = {}) {
  if (!force && pricingTable && (Date.now() - pricingFetchedAt) < PRICING_TTL_MS) return pricingTable;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return pricingTable;
  try {
    const res = await doFetch(`${BASE_URL}${MODELS_PATH}`);
    if (!res || !res.ok) return pricingTable;
    const body = await res.json();
    setPricingTable(body && body.data);
  } catch {
    // A pricing fetch failure must never break dispatch - the request itself
    // does not need prices. Cost comes back null and is reported as unknown.
  }
  return pricingTable;
}

/**
 * USD for one call, or null when the model's price is not known yet.
 * (null, not 0 - see the header.)
 */
function estimateCost(model, inputTokens, outputTokens) {
  if (!pricingTable) return null;
  const rate = pricingTable[normalizeModel(model)];
  if (!rate) return null;
  return (((inputTokens || 0) * rate.input) + ((outputTokens || 0) * rate.output)) / 1_000_000;
}

function usageFrom(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    // Some upstreams behind OpenRouter report their own cache tiers. Passed
    // through when present, never invented when absent.
    ...(typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      && { cached_input_tokens: usage.prompt_tokens_details.cached_tokens })
  };
}

async function chat(client, payload, options = {}) {
  const request = {
    model: normalizeModel(payload.model),
    messages: payload.messages,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.0,
    max_tokens: payload.max_tokens || 1024,
    ...(payload.tools && { tools: payload.tools }),
    ...(payload.tool_choice && { tool_choice: payload.tool_choice }),
    ...(payload.response_format && { response_format: payload.response_format }),
    // Ask for the upstream provider's identity + cost accounting in the same
    // response, so the dashboard can attribute spend per vendor.
    usage: { include: true },
    ...(options.requestLogprobs && { logprobs: true, top_logprobs: 1 })
  };

  const start = Date.now();
  const response = await client.chat.completions.create(request);
  const latencyMs = Date.now() - start;

  const choice = response.choices[0];
  const usage = usageFrom(response.usage);
  // Prefer OpenRouter's own accounting when it sends it: it is the billed
  // amount, including any provider-specific pricing we did not model.
  const billed = typeof response.usage?.cost === 'number' ? response.usage.cost : null;
  const costUsd = billed !== null ? billed : estimateCost(payload.model, usage.input_tokens, usage.output_tokens);

  return {
    provider: 'openrouter',
    model: payload.model,
    latency_ms: latencyMs,
    usage,
    cost_usd: costUsd,
    content: choice.message.content || '',
    tool_calls: choice.message.tool_calls,
    // Which upstream actually served it (OpenRouter routes among several).
    upstream_provider: response.provider || undefined,
    raw: response
  };
}

function applyStreamChunk(state, chunk, onDelta) {
  const choice = chunk.choices && chunk.choices[0];
  if (choice && choice.delta && choice.delta.content) {
    state.content += choice.delta.content;
    onDelta(choice.delta.content);
  }
  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens || 0;
    state.outputTokens = chunk.usage.completion_tokens || 0;
    if (typeof chunk.usage.cost === 'number') state.billedCost = chunk.usage.cost;
    if (typeof chunk.usage.prompt_tokens_details?.cached_tokens === 'number') {
      state.cachedInputTokens = chunk.usage.prompt_tokens_details.cached_tokens;
    }
  }
}

async function chatStream(client, payload, { onDelta, signal } = {}) {
  const request = {
    model: normalizeModel(payload.model),
    messages: payload.messages,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.0,
    max_tokens: payload.max_tokens || 1024,
    stream: true,
    stream_options: { include_usage: true },
    usage: { include: true }
  };

  const start = Date.now();
  const stream = await client.chat.completions.create(request, signal ? { signal } : undefined);

  const state = { content: '', inputTokens: 0, outputTokens: 0, billedCost: null, cachedInputTokens: 0 };
  for await (const chunk of stream) {
    applyStreamChunk(state, chunk, onDelta || (() => {}));
  }

  const latencyMs = Date.now() - start;
  const usage = usageFrom({
    prompt_tokens: state.inputTokens,
    completion_tokens: state.outputTokens,
    ...(state.cachedInputTokens ? { prompt_tokens_details: { cached_tokens: state.cachedInputTokens } } : {})
  });
  const costUsd = state.billedCost !== null ? state.billedCost : estimateCost(payload.model, usage.input_tokens, usage.output_tokens);

  return {
    provider: 'openrouter',
    model: payload.model,
    latency_ms: latencyMs,
    usage,
    cost_usd: costUsd,
    content: state.content,
    tool_calls: undefined
  };
}

module.exports = {
  buildClient, chat, chatStream, applyStreamChunk, estimateCost,
  isOpenRouterModel, normalizeModel, refreshPricing, setPricingTable, attributionHeaders, BASE_URL
};
