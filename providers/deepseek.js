// model-router/providers/deepseek.js
//
// DeepSeek speaks the OpenAI wire format, so this is the `openai` SDK pointed
// at DeepSeek's own base URL - no second HTTP client, no hand-rolled fetch.
// What is NOT identical is the money: DeepSeek bills input in two tiers
// (cache hit vs cache miss) and every rate has a PEAK and an OFF-PEAK value,
// so a single flat rate table - the shape providers/openai.js can get away
// with - would misprice most requests. Both facts come from the vendor's own
// pages, read 2026-09-10:
//   base URL + models + rates: api-docs.deepseek.com/quick_start/pricing
//   usage fields:              api-docs.deepseek.com/guides/kv_cache
//
// The review that prompted this file said "DeepSeek features incredibly cheap
// API calls and aggressive server-side prompt caching" and told the reader to
// "parse cached_tokens from DeepSeek's usage response blocks". The second half
// is wrong in a way that would have silently zeroed the savings: DeepSeek does
// not report OpenAI's nested prompt_tokens_details.cached_tokens, it reports a
// flat prompt_cache_hit_tokens / prompt_cache_miss_tokens pair. Cached input
// here is ~50x cheaper than a miss, so getting that mapping wrong is the
// difference between an accurate cost dashboard and a decorative one.
const { OpenAI } = require('openai');

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

// USD per 1M tokens, PEAK rates. Off-peak is exactly half (vendor's own note:
// "Off-peak rates are half of the peak rates"). Peak = 01:00-04:00 and
// 06:00-10:00 UTC, Monday through Friday; everything else is off-peak.
const PEAK_RATES = {
  'deepseek-flash':                 { hit: 0.006, miss: 0.30, output: 1.20 },
  'deepseek-v4-pro':                { hit: 0.044, miss: 1.32, output: 3.96 },
  // Legacy names the API still accepts. The vendor states these are served by
  // V4.1-Flash and BILLED AT THE FLASH PRICE, so they must not fall through to
  // a "unknown model" default with different numbers.
  'deepseek-v4-flash':              { hit: 0.006, miss: 0.30, output: 1.20 },
  'deepseek-v4-flash-vision-exp':   { hit: 0.006, miss: 0.30, output: 1.20 }
};
// `deepseek-v4-pro` is being retired: from 2026-09-14 requests to it are routed
// to V4.1-Flash and billed as Flash. Until that date the pro rate is real, so
// both are priced and the switch happens on the vendor's side, not ours.
const DEFAULT_RATE = PEAK_RATES['deepseek-flash'];

function isPeak(now = new Date()) {
  const day = now.getUTCDay();            // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function rateFor(model, now = new Date()) {
  const base = PEAK_RATES[model] || DEFAULT_RATE;
  return isPeak(now) ? base : { hit: base.hit / 2, miss: base.miss / 2, output: base.output / 2 };
}

/**
 * Cost for one call. Input tokens are SPLIT, not uniform: `cacheHitTokens` of
 * them were served from DeepSeek's disk cache at the hit rate, the remainder at
 * the miss rate. Getting this wrong is not a rounding error - at Flash's peak
 * rates a fully-cached 1M-token input costs $0.006 instead of $0.30.
 *
 * The 3-argument form (no options) is kept working for callers that have no
 * cache data: it prices everything as a miss, which is the conservative
 * (never-understate) direction for a cost dashboard.
 *
 * `now` is injectable so tests can pin the billing window instead of passing
 * or failing depending on what time of day the suite runs.
 */
function estimateCost(model, inputTokens, outputTokens, { cacheHitTokens = 0, now = new Date() } = {}) {
  const rate = rateFor(model, now);
  const hit = Math.max(0, Math.min(cacheHitTokens || 0, inputTokens || 0));
  const miss = Math.max(0, (inputTokens || 0) - hit);
  return ((hit * rate.hit) + (miss * rate.miss) + ((outputTokens || 0) * rate.output)) / 1_000_000;
}

function buildClient(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    // DeepSeek requires no extra headers; the SDK's defaults are fine.
    timeout: Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60000
  });
}

function usageFrom(usage = {}) {
  const input = usage.prompt_tokens || 0;
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = typeof usage.prompt_cache_miss_tokens === 'number'
    ? usage.prompt_cache_miss_tokens
    : Math.max(0, input - hit);
  return { input_tokens: input, output_tokens: usage.completion_tokens || 0, cache_hit_tokens: hit, cache_miss_tokens: miss };
}

async function chat(client, payload, options = {}) {
  const request = {
    model: payload.model,
    messages: payload.messages,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.0,
    max_tokens: payload.max_tokens || 1024,
    ...(payload.tools && { tools: payload.tools }),
    ...(payload.tool_choice && { tool_choice: payload.tool_choice }),
    ...(payload.response_format && { response_format: payload.response_format })
  };

  const start = Date.now();
  const response = await client.chat.completions.create(request);
  const latencyMs = Date.now() - start;

  const choice = response.choices[0];
  const usage = usageFrom(response.usage);
  const costUsd = estimateCost(payload.model, usage.input_tokens, usage.output_tokens, { cacheHitTokens: usage.cache_hit_tokens });

  return {
    provider: 'deepseek',
    model: payload.model,
    latency_ms: latencyMs,
    usage,
    cost_usd: costUsd,
    content: choice.message.content || '',
    // Thinking-mode models (the default for the current models) return their
    // chain separately. Passed through instead of dropped so a caller can see
    // it, but NOT concatenated into `content` - that would corrupt every
    // consumer that treats content as the answer.
    reasoning_content: choice.message.reasoning_content,
    tool_calls: choice.message.tool_calls,
    raw: response
  };
}

/**
 * Pure state-accumulation for one streamed chunk, factored out for the same
 * reason as providers/openai.js's: usage/cost extraction is then unit-testable
 * against canned chunks with no live API.
 *
 * DeepSeek only sends `usage` on the final chunk, and only when the request
 * asked for it (`stream_options.include_usage`, set in chatStream below) -
 * without that flag a streamed call carries no usage at all and the cost
 * tracking this project is built around would sit at zero while looking fine.
 */
function applyStreamChunk(state, chunk, onDelta) {
  const choice = chunk.choices && chunk.choices[0];
  if (choice && choice.delta) {
    if (choice.delta.content) {
      state.content += choice.delta.content;
      onDelta(choice.delta.content);
    }
    if (choice.delta.reasoning_content) state.reasoningContent = (state.reasoningContent || '') + choice.delta.reasoning_content;
  }
  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens || 0;
    state.outputTokens = chunk.usage.completion_tokens || 0;
    state.cacheHitTokens = chunk.usage.prompt_cache_hit_tokens || 0;
    state.cacheMissTokens = chunk.usage.prompt_cache_miss_tokens;
  }
}

async function chatStream(client, payload, { onDelta, signal } = {}) {
  const request = {
    model: payload.model,
    messages: payload.messages,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.0,
    max_tokens: payload.max_tokens || 1024,
    stream: true,
    stream_options: { include_usage: true }
  };

  const start = Date.now();
  const stream = await client.chat.completions.create(request, signal ? { signal } : undefined);

  const state = { content: '', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, reasoningContent: '' };
  for await (const chunk of stream) {
    applyStreamChunk(state, chunk, onDelta || (() => {}));
  }

  const latencyMs = Date.now() - start;
  const usage = usageFrom({
    prompt_tokens: state.inputTokens,
    completion_tokens: state.outputTokens,
    prompt_cache_hit_tokens: state.cacheHitTokens,
    ...(typeof state.cacheMissTokens === 'number' && { prompt_cache_miss_tokens: state.cacheMissTokens })
  });
  const costUsd = estimateCost(payload.model, usage.input_tokens, usage.output_tokens, { cacheHitTokens: usage.cache_hit_tokens });

  return {
    provider: 'deepseek',
    model: payload.model,
    latency_ms: latencyMs,
    usage,
    cost_usd: costUsd,
    content: state.content,
    reasoning_content: state.reasoningContent || undefined,
    tool_calls: undefined
  };
}

module.exports = { buildClient, chat, chatStream, applyStreamChunk, estimateCost, isPeak, rateFor, BASE_URL };
