// model-router/providers/openai.js
const { OpenAI } = require('openai');

function buildClient(apiKey) {
  return new OpenAI({ apiKey });
}

function estimateCost(model, inputTokens, outputTokens) {
  // Approximate pricing per 1M tokens
  const rates = {
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4o': { input: 2.5, output: 10.0 }
  };
  const rate = rates[model] || { input: 2.5, output: 10.0 };
  return ((inputTokens * rate.input) + (outputTokens * rate.output)) / 1_000_000;
}

async function chat(client, payload) {
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
  const inputTokens = response.usage.prompt_tokens;
  const outputTokens = response.usage.completion_tokens;
  const costUsd = estimateCost(payload.model, inputTokens, outputTokens);

  return {
    provider: 'openai',
    model: payload.model,
    latency_ms: latencyMs,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: costUsd,
    content: choice.message.content || '',
    tool_calls: choice.message.tool_calls,
    raw: response
  };
}

/**
 * Pure state-accumulation for one OpenAI streaming chunk - factored out
 * from chatStream() so the usage/cost extraction is directly
 * unit-testable with canned chunks, no live API needed. Mutates `state`
 * ({content, inputTokens, outputTokens}) and calls onDelta() with each
 * new piece of assistant text.
 *
 * OpenAI only includes `usage` on a final, choice-less chunk, and only
 * when the request explicitly asked for it (`stream_options:
 * {include_usage: true}`, set in chatStream() below) - without that
 * flag a streamed OpenAI response has NO usage data at all, which would
 * silently make cost_usd wrong (stuck at 0) for every streamed OpenAI
 * call. Requesting it explicitly is required, not optional, for the
 * cost tracking this whole project is built around to stay honest.
 */
function applyStreamChunk(state, chunk, onDelta) {
  const choice = chunk.choices && chunk.choices[0];
  if (choice && choice.delta && choice.delta.content) {
    state.content += choice.delta.content;
    onDelta(choice.delta.content);
  }
  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens;
    state.outputTokens = chunk.usage.completion_tokens;
  }
}

/**
 * Streaming counterpart to chat(). Scope: plain text content only - no
 * tools/tool_choice forwarded (server.js rejects stream:true + tools
 * before this is ever called; see streaming.js for why).
 */
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

  const state = { content: '', inputTokens: 0, outputTokens: 0 };
  for await (const chunk of stream) {
    applyStreamChunk(state, chunk, onDelta || (() => {}));
  }

  const latencyMs = Date.now() - start;
  const costUsd = estimateCost(payload.model, state.inputTokens, state.outputTokens);

  return {
    provider: 'openai',
    model: payload.model,
    latency_ms: latencyMs,
    usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens },
    cost_usd: costUsd,
    content: state.content,
    tool_calls: undefined
  };
}

module.exports = { buildClient, chat, chatStream, applyStreamChunk, estimateCost };
