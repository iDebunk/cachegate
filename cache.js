// model-router/cache.js
//
// The exact-match cache: same model + same messages + same params ->
// same cached response, by content hash. First and free - checked
// before the semantic cache (semanticCache.js), which is slower (an
// embedding call) and probabilistic (a similarity threshold, not an
// exact match). Connection is shared via redisClient.js.

const crypto = require('crypto');
const redis = require('./redisClient');

// `scope` (seams work, roadmap: engine/cloud "wrap it, don't fork it"):
// an opaque, caller-supplied isolation key - a tenant id, a namespace,
// whatever a wrapping deployment needs two callers to never share a
// cache entry over. null/undefined (every call in this codebase today)
// means exactly what it always has: one global cache, no isolation -
// scope is omitted from both the key prefix AND the hashed payload in
// that case, so an unconfigured deployment's cache keys are BYTE-
// IDENTICAL to before this parameter existed (no cache invalidation on
// upgrade). When a caller does pass a scope, it's folded into both the
// prefix and the hash (not the prefix alone) - so two scopes are
// isolated even if the caller's own scope-naming convention were ever
// guessed or leaked; a compromised/guessed prefix alone can't be walked
// into another scope's cached content.
function buildCacheKey(scope, payload) {
  const normalized = JSON.stringify({
    ...(scope != null ? { scope } : {}),
    model: payload.model,
    messages: payload.messages,
    temperature: payload.temperature ?? 0.0,
    max_tokens: payload.max_tokens,
    tools: payload.tools,
    tool_choice: payload.tool_choice,
    // response_format changes the SHAPE of the answer (json_object vs
    // plain text), so it must participate in the key too - otherwise a
    // cached plain-text response could be served to a json_object caller
    // (or vice versa). openai.js forwards it (see its own chat()); this
    // file used to omit it, making an "exact" hit not always exact.
    response_format: payload.response_format
  });
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const prefix = scope != null ? `ROUTER:${scope}:` : 'ROUTER:';
  return `${prefix}${payload.model}:${hash}`;
}

module.exports = {
  buildCacheKey,

  isConnected() {
    return redis.isConnected();
  },

  async get(scope, payload) {
    if (!redis.isConnected()) return null;
    try {
      const cached = await redis.client.get(buildCacheKey(scope, payload));
      return cached ? JSON.parse(cached) : null;
    } catch (err) {
      return null;
    }
  },

  async set(scope, payload, response, ttlSeconds = 3600) {
    if (!redis.isConnected()) return false;
    try {
      await redis.client.set(buildCacheKey(scope, payload), JSON.stringify(response), { EX: ttlSeconds });
      return true;
    } catch (err) {
      return false;
    }
  }
};
