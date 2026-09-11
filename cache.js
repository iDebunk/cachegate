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

// Prompt canonicalization (Phase 2, step 21) - normalizes ONLY what gets
// HASHED, never what is sent to the provider (buildCacheKey receives the
// payload, but the provider call in server.js uses payload.messages raw).
// Two prompts that differ only by whitespace/case-of-structure/literal
// values must hash to the SAME key. Conservative by design: a false-
// positive collapse (two prompts that actually want different answers
// sharing one key) is worse than a miss, so this folds only surface-level
// variation, never meaning.
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    // Canonical field order (role, content first) so {role,content} and
    // {content,role} hash identically; any other fields (name,
    // tool_call_id, ...) keep their original relative order after that.
    const out = { role: m.role, content: normalizeContent(m.content) };
    for (const key of Object.keys(m)) {
      if (key !== 'role' && key !== 'content') out[key] = m[key];
    }
    return out;
  });
}

function normalizeContent(content) {
  if (typeof content === 'string') return normalizeText(content);
  if (Array.isArray(content)) return content.map(normalizeContent);
  return content;
}

// Conservative canonical form of one text block: NFC unicode, structural
// punctuation folding, whitespace collapse, then literal slotting. Email
// and URL slotting are unconditional (an incidental identifier really does
// want the same answer). Number and date slotting are env-gated, default
// OFF (CACHE_KEY_SLOT_NUMBERS=true to opt in) - a number or date is very
// often THE substance of the answer, and on an EXACT cache (no similarity
// threshold, a guaranteed match) that's a correctness bug, not a tuning
// knob (Phase 2 step 21, reviewed 2026-09-06). Slotting order is
// most-specific first (URL -> email -> date -> number) so a longer token
// isn't half-consumed by a shorter pattern.
function normalizeText(text) {
  const base = String(text)
    .normalize('NFC')
    .replace(/\u00A0/g, ' ') // non-breaking space
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // curly double quotes
    .replace(/[\u2013\u2014]/g, '-') // en/em dash
    .replace(/\u2026/g, '...') // ellipsis
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '<var>') // URLs
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<var>'); // emails

  if (process.env.CACHE_KEY_SLOT_NUMBERS === 'true') {
    return base
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<var>') // ISO dates
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '<var>') // slash dates
      .replace(/\b\d+(?:\.\d+)?\b/g, '<var>'); // numbers
  }
  return base;
}

// The fields that change the SHAPE of an answer rather than its content, defined ONCE because two
// paths consume them: buildCacheKey folds them into the exact-cache key, and semanticCache.js stores
// them beside an entry and refuses a hit across a mismatch. Adding them one at a time is precisely how
// the two paths drifted apart - this key learned about response_format and the semantic path never did
// - so the list lives in one place and both call it.
//
// temperature is deliberately ABSENT: it already participates in the exact key with a real numeric
// default (`?? 0.0`), and semantic matching is approximate by design, so gating on it there would
// mostly lower the hit rate for callers who leave it at the default. seed IS here: it is a determinism
// contract, not a sampling hint.
//
// Key ORDER matters - it is part of the serialization the hash is taken over - and it is kept
// identical to the inline field list this replaced. JSON.stringify drops undefined values, so a payload
// with no seed produces a byte-identical key and the change does not flush the cache.
function shapeFields(payload) {
  return {
    tools: payload.tools,
    tool_choice: payload.tool_choice,
    response_format: payload.response_format,
    seed: payload.seed
  };
}

function buildCacheKey(scope, payload) {
  const canonicalMessages = normalizeMessages(payload.messages);
  if (process.env.CACHE_KEY_DEBUG) {
    // Traceable, not silent (step 21.2): a false-positive collision can be
    // reconstructed by re-running normalizeMessages on the original - this
    // opt-in log line just makes it visible without that extra step.
    console.log('[cache] canonical messages:', JSON.stringify(canonicalMessages));
  }
  const normalized = JSON.stringify({
    ...(scope != null ? { scope } : {}),
    model: payload.model,
    messages: canonicalMessages,
    temperature: payload.temperature ?? 0.0,
    max_tokens: payload.max_tokens,
    ...shapeFields(payload)
  });
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const prefix = scope != null ? `ROUTER:${scope}:` : 'ROUTER:';
  return `${prefix}${payload.model}:${hash}`;
}

module.exports = {
  buildCacheKey,
  shapeFields,
  normalizeMessages,
  normalizeText,

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
