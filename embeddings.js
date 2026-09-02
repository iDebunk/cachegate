// model-router/embeddings.js
//
// The only embedding backend right now is OpenAI's - which means
// semantic caching needs an OPENAI_API_KEY configured even for a
// deployment that only ever talks to Anthropic for chat. That's a real
// constraint, not hidden: isEnabled() is what semanticCache.js checks
// before doing anything, and it degrades to "disabled" (not an error)
// when the key isn't set, same as the Redis cache does when REDIS_URL
// isn't set.

const { OpenAI } = require('openai');

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function isEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function embed(text) {
  if (!isEnabled()) {
    throw new Error('OPENAI_API_KEY not configured - embeddings unavailable');
  }
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  // A hard timeout per embedding call: these run on the hot request path
  // (semanticCache.js's findMatch/store, one or two per miss), so a hung
  // embedding provider must not be able to stall every chat request -
  // including ones that never touch embeddings at all if the semantic
  // cache is enabled. AbortSignal.timeout aborts the underlying fetch, and
  // the thrown error is caught by semanticCache.js's own try/catch, which
  // degrades to "skip semantic caching" rather than failing the request.
  const response = await getClient().embeddings.create(
    { model, input: text },
    { signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS) || 5000) }
  );
  return response.data[0].embedding;
}

module.exports = { isEnabled, embed };
