// model-router/providers/anthropic.js
const { Anthropic } = require('@anthropic-ai/sdk');

function buildClient(apiKey) {
  return new Anthropic({ apiKey });
}

function estimateCost(model, inputTokens, outputTokens) {
  // Approximate pricing per 1M tokens — update as Anthropic changes rates
  const rates = {
    'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
    'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
    'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0 }
  };
  const rate = rates[model] || { input: 3.0, output: 15.0 };
  return ((inputTokens * rate.input) + (outputTokens * rate.output)) / 1_000_000;
}

async function chat(client, payload) {
  const systemMessage = payload.messages.find(m => m.role === 'system');
  const userMessages = payload.messages.filter(m => m.role !== 'system');

  const request = {
    model: payload.model,
    max_tokens: payload.max_tokens || 1024,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.0,
    messages: userMessages,
    ...(systemMessage && { system: systemMessage.content }),
    ...(payload.tools && { tools: payload.tools }),
    ...(payload.tool_choice && { tool_choice: payload.tool_choice })
  };

  const start = Date.now();
  const response = await client.messages.create(request);
  const latencyMs = Date.now() - start;

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd = estimateCost(payload.model, inputTokens, outputTokens);

  const toolCall = response.content.find(c => c.type === 'tool_use');
  const textContent = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');

  return {
    provider: 'anthropic',
    model: payload.model,
    latency_ms: latencyMs,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: costUsd,
    content: textContent,
    tool_calls: toolCall ? [toolCall] : undefined,
    raw: response
  };
}

/**
 * Pure state-accumulation for one Anthropic streaming event - factored
 * out from chatStream() so the trickiest part (pulling usage/cost data
 * out of a stream instead of one final response object) is directly
 * unit-testable with canned events, no live API needed. Mutates
 * `state` ({content, inputTokens, outputTokens}) and calls onDelta()
 * with each new piece of assistant text.
 */
function applyStreamEvent(state, event, onDelta) {
  if (event.type === 'message_start') {
    state.inputTokens = event.message.usage.input_tokens;
    state.outputTokens = event.message.usage.output_tokens || 0;
  } else if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
    state.content += event.delta.text;
    onDelta(event.delta.text);
  } else if (event.type === 'message_delta' && event.usage) {
    // Anthropic reports output_tokens progressively here; the last one
    // received before message_stop is the final total.
    state.outputTokens = event.usage.output_tokens;
  }
}

/**
 * Streaming counterpart to chat(). Scope: plain text content only - no
 * tools/tool_choice forwarded (server.js rejects stream:true + tools
 * before this is ever called; see streaming.js for why).
 */
async function chatStream(client, payload, { onDelta, signal } = {}) {
  const systemMessage = payload.messages.find(m => m.role === 'system');
  const userMessages = payload.messages.filter(m => m.role !== 'system');

  const request = {
    model: payload.model,
    max_tokens: payload.max_tokens || 1024,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.0,
    messages: userMessages,
    ...(systemMessage && { system: systemMessage.content }),
    stream: true
  };

  const start = Date.now();
  const stream = await client.messages.create(request, signal ? { signal } : undefined);

  const state = { content: '', inputTokens: 0, outputTokens: 0 };
  for await (const event of stream) {
    applyStreamEvent(state, event, onDelta || (() => {}));
  }

  const latencyMs = Date.now() - start;
  const costUsd = estimateCost(payload.model, state.inputTokens, state.outputTokens);

  return {
    provider: 'anthropic',
    model: payload.model,
    latency_ms: latencyMs,
    usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens },
    cost_usd: costUsd,
    content: state.content,
    tool_calls: undefined
  };
}

module.exports = { buildClient, chat, chatStream, applyStreamEvent, estimateCost };
