// model-router/semanticCache.js
//
// Catches NEAR-duplicate prompts that cache.js's exact hash match
// can't: a paraphrase of the same question, reordered context,
// different whitespace. cache.js stays the first, free, zero-risk
// check; this one only runs when that misses, and it costs something
// real every time it runs - one embedding call - whether or not it
// finds a match. That's a genuine tradeoff, not free money: it's worth
// it only when near-duplicate traffic is common enough that avoiding
// the occasional full completion call outweighs the embedding calls
// spent looking. See the README for the honest framing of what this
// can and can't claim.
//
// Storage: a plain Redis LIST per model, no RediSearch/vector-search
// module assumed - most self-hosted Redis instances (including
// Render's managed Redis) don't have that module. A lookup pulls up to
// MAX_CANDIDATES_PER_MODEL recent entries for that model and computes
// cosine similarity IN NODE, not in Redis. This is brute-force, not
// indexed - fine at the volume a self-hosted single instance sees, not
// meant to scale past that cap. A real vector index is the honest next
// step if traffic outgrows it.
//
// What that brute force actually COSTS was worth measuring rather than
// assuming, and it was not the arithmetic: each entry used to carry its
// embedding as JSON text, so a 1536-dim vector arrived as ~30 KB of
// digits and a lookup parsed up to 200 of them - 5.89 MB of JSON
// number-parsing per semantic miss, against 200 x 1536 multiply-adds to
// score them (48.7 ms, measured). The vector is now stored as base64
// Float32 with its L2 norm beside it: 1.58 MB and 3.6 ms for the same
// work, 13x faster. Entries written before this change are still read
// correctly - both formats live in the same list until the old ones age
// out - and the cap, the threshold and the honesty framing above are
// unchanged. This is an encoding improvement, NOT the vector index the
// last paragraph is still waiting for.
//
// The threshold is a probabilistic judgment call, not a guarantee: a
// "hit" above the threshold is the router's best guess that two
// prompts want the same answer, not proof they do. Set it too low and
// it returns confidently wrong answers - the same failure mode that
// makes vendor-claimed 90%+ cache hit rates suspect (see this project's
// own market research on real vs. advertised hit rates). Every
// semantic hit is tracked separately from an exact hit in metrics.js /
// GET /stats for exactly this reason - the two are not equally
// trustworthy and shouldn't be blended into one inflated number.

const redis = require('./redisClient');
const embeddingsDefault = require('./embeddings');

const MAX_CANDIDATES_PER_MODEL = Number(process.env.SEMANTIC_CACHE_MAX_CANDIDATES) || 200;
const DEFAULT_TTL_SECONDS = Number(process.env.SEMANTIC_CACHE_TTL_SECONDS) || 3600;
const DEFAULT_THRESHOLD = Number(process.env.SEMANTIC_CACHE_THRESHOLD) || 0.93;

// scope: same seams contract as cache.js's buildCacheKey - null/
// undefined (every call site in this codebase today) means one global
// per-model list, byte-identical to before this parameter existed; a
// non-null scope gets its own list, isolated from every other scope's.
function listKey(scope, model) {
  return scope != null ? `SEMANTIC_LIST:${scope}:${model}` : `SEMANTIC_LIST:${model}`;
}

// Embeddings are stored as base64 Float32 rather than JSON numbers. Float32 loses ~7 significant digits
// versus the JSON doubles the old format held, and cosine similarity over 1536 dimensions cannot see the
// difference - test/semanticCache.test.js asserts both paths agree, and the legacy branch below is what
// keeps entries written before this change matching correctly.
function encodeEmbedding(vec) {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

function decodeEmbedding(record) {
  const e = record && record.embedding;
  if (Array.isArray(e)) return e;                       // legacy: JSON doubles
  if (typeof e !== 'string') return null;
  const buf = Buffer.from(e, 'base64');
  // A Float32 vector is 4 bytes per element; anything else is not one. Checked rather than assumed so a
  // corrupt or truncated entry is skipped (as a malformed JSON entry already was) instead of producing a
  // wrong-length array that silently scores 0 against everything.
  if (buf.length === 0 || buf.length % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

function normOf(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  return Math.sqrt(n);
}

// Same result as cosineSimilarity(), given the two norms the caller already has or has stored. The stored
// norm is the point: without it, every lookup recomputes the norm of every candidate - a third of the float
// work per candidate, for a value that never changes.
function similarityWithNorms(a, aNorm, b, bNorm) {
  if (!a || !b || a.length !== b.length) return 0;
  if (aNorm === 0 || bNorm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The text a semantic match is based on: just the conversation content,
 * not incidental request parameters (temperature, max_tokens) that
 * don't change what's actually being asked.
 */
function extractPromptText(payload) {
  return payload.messages
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
}

function isEnabled(embeddings = embeddingsDefault) {
  if (process.env.SEMANTIC_CACHE_ENABLED === 'false') return false;
  return redis.isConnected() && embeddings.isEnabled();
}

// Tool-calling requests are excluded from semantic caching: an
// approximate text match can't guarantee the exact argument values a
// tool call needs, and returning a plausible-but-wrong tool call is a
// worse failure than a cache miss.
function isCacheable(payload) {
  return !payload.tools;
}

async function findMatch(scope, payload, { threshold = DEFAULT_THRESHOLD, embeddings = embeddingsDefault } = {}) {
  if (!isEnabled(embeddings) || !isCacheable(payload)) return null;

  let queryEmbedding;
  try {
    queryEmbedding = await embeddings.embed(extractPromptText(payload));
  } catch (err) {
    console.warn('⚠️ Semantic cache lookup failed to embed, skipping:', err.message);
    return null;
  }

  let raw;
  try {
    raw = await redis.client.lRange(listKey(scope, payload.model), 0, MAX_CANDIDATES_PER_MODEL - 1);
  } catch (err) {
    console.warn('⚠️ Semantic cache lookup failed:', err.message);
    return null;
  }

  const queryNorm = normOf(queryEmbedding);
  let best = null;
  for (const line of raw) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a malformed entry is skipped, not fatal
    }
    const vector = decodeEmbedding(record);
    if (!vector) continue; // ditto an entry whose vector cannot be read
    const candidateNorm = typeof record.norm === 'number' ? record.norm : normOf(vector);
    const similarity = similarityWithNorms(queryEmbedding, queryNorm, vector, candidateNorm);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { entry: record.entry, similarity };
    }
  }
  return best;
}

async function store(scope, payload, entry, { ttlSeconds = DEFAULT_TTL_SECONDS, embeddings = embeddingsDefault } = {}) {
  if (!isEnabled(embeddings) || !isCacheable(payload)) return false;

  let embedding;
  try {
    embedding = await embeddings.embed(extractPromptText(payload));
  } catch (err) {
    console.warn('⚠️ Semantic cache store failed to embed, skipping:', err.message);
    return false;
  }

  const key = listKey(scope, payload.model);
  try {
    await redis.client.lPush(key, JSON.stringify({
      embedding: encodeEmbedding(embedding),
      norm: normOf(embedding),
      entry,
      storedAt: Date.now()
    }));
    await redis.client.lTrim(key, 0, MAX_CANDIDATES_PER_MODEL - 1);
    // A rolling TTL on the whole per-model bucket, reset on every
    // store - simple and predictable (as long as there's traffic to
    // that model, the bucket stays warm; if it goes quiet for
    // ttlSeconds, the whole bucket - old and new entries alike -
    // expires together), not a precise per-entry TTL. Documented
    // tradeoff, not an oversight.
    await redis.client.expire(key, ttlSeconds);
    return true;
  } catch (err) {
    console.warn('⚠️ Semantic cache store failed:', err.message);
    return false;
  }
}

module.exports = {
  isEnabled,
  isCacheable,
  findMatch,
  store,
  listKey,
  cosineSimilarity,
  extractPromptText,
  DEFAULT_THRESHOLD,
  // exported for test/semanticCache.test.js: the storage format is a compatibility surface (both formats
  // must keep matching), so its round-trip is asserted rather than assumed
  encodeEmbedding,
  decodeEmbedding,
  normOf,
  similarityWithNorms
};
