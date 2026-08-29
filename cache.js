// model-router/cache.js
//
// The exact-match cache: same model + same messages + same params ->
// same cached response, by content hash. First and free - checked
// before the semantic cache (semanticCache.js), which is slower (an
// embedding call) and probabilistic (a similarity threshold, not an
// exact match). Connection is shared via redisClient.js.

const crypto = require('crypto');
const redis = require('./redisClient');

function buildCacheKey(payload) {
  const normalized = JSON.stringify({
    model: payload.model,
    messages: payload.messages,
    temperature: payload.temperature ?? 0.0,
    max_tokens: payload.max_tokens,
    tools: payload.tools,
    tool_choice: payload.tool_choice
  });
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `ROUTER:${payload.model}:${hash}`;
}

module.exports = {
  buildCacheKey,

  isConnected() {
    return redis.isConnected();
  },

  async get(payload) {
    if (!redis.isConnected()) return null;
    try {
      const cached = await redis.client.get(buildCacheKey(payload));
      return cached ? JSON.parse(cached) : null;
    } catch (err) {
      return null;
    }
  },

  async set(payload, response, ttlSeconds = 3600) {
    if (!redis.isConnected()) return false;
    try {
      await redis.client.set(buildCacheKey(payload), JSON.stringify(response), { EX: ttlSeconds });
      return true;
    } catch (err) {
      return false;
    }
  }
};
