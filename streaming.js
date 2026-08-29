// model-router/streaming.js
//
// OpenAI-compatible SSE chunk framing, shared by both providers so
// server.js has exactly one wire format to write regardless of which
// provider actually answered - the provider adapters (chatStream()) do
// their own event-format translation and hand server.js plain text
// deltas plus a final usage/cost summary; this file turns that into the
// bytes that go on the wire.
//
// Scope for this increment: PLAIN TEXT CONTENT ONLY. Tool-call
// streaming (accumulating partial JSON arguments across chunks, one or
// more calls in flight at once) is a genuinely harder, separate
// problem - server.js rejects stream:true + tools with a clear error
// rather than attempt a half-working version of it.
//
// The final chunk carries extra fields (cost_usd, provider, cached,
// cache_type) beyond real OpenAI's wire format - the same deviation the
// non-streaming JSON response already makes. This proxy is
// OpenAI-COMPATIBLE in request/response SHAPE, not a byte-for-byte
// clone of OpenAI's actual API; MemoCode's own callers need the cost
// data, and no spec-compliant client chokes on unknown extra JSON
// fields it doesn't look for.

const crypto = require('crypto');

function chunkFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function doneFrame() {
  return 'data: [DONE]\n\n';
}

function genId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

function baseChunk(id, model, choice) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice]
  };
}

function roleChunk({ id, model }) {
  return chunkFrame(baseChunk(id, model, { index: 0, delta: { role: 'assistant' }, finish_reason: null }));
}

function deltaChunk({ id, model, content }) {
  return chunkFrame(baseChunk(id, model, { index: 0, delta: { content }, finish_reason: null }));
}

function finalChunk({ id, model, usage, cost_usd, provider, cached, cache_type }) {
  const frame = baseChunk(id, model, { index: 0, delta: {}, finish_reason: 'stop' });
  frame.usage = usage;
  frame.cost_usd = cost_usd;
  frame.provider = provider;
  frame.cached = !!cached;
  if (cache_type) frame.cache_type = cache_type;
  return chunkFrame(frame);
}

function errorFrame(message) {
  return chunkFrame({ error: { message } });
}

function startSse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

module.exports = { chunkFrame, doneFrame, genId, roleChunk, deltaChunk, finalChunk, errorFrame, startSse };
