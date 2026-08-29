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
  const response = await getClient().embeddings.create({ model, input: text });
  return response.data[0].embedding;
}

module.exports = { isEnabled, embed };
