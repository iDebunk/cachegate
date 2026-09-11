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
// The answer-shape definition is shared with the exact cache ON PURPOSE: the two paths diverged once -
// cache.js keyed response_format and this file never did - and a field added to one of them silently
// stops being enforced by the other. No cycle: cache.js does not require this file.
const { shapeFields } = require('./cache');

// The shape of a request that demands nothing about the answer's form: no response_format, no tools,
// no tool_choice, no seed. The semantic shape gate uses it to decide whether an entry carrying no
// recorded shape may still be served - see the gate in findMatch.
const SHAPE_OF_NEUTRAL = JSON.stringify(shapeFields({}));

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
//
// response_format is NOT excluded, it is FILTERED (see findMatch): the
// answer is still worth caching, it just may not be served to a caller
// who asked for a different shape. Excluding it outright would throw away
// hit rate to solve a matching problem.
function isCacheable(payload) {
  return !payload.tools;
}

async function findMatch(scope, payload, { threshold = DEFAULT_THRESHOLD, embeddings = embeddingsDefault } = {}) {
  if (!isEnabled(embeddings) || !isCacheable(payload)) return null;

  // The shape this request needs. A semantic match is approximate about the PROMPT, never about the
  // answer's shape: a json_object caller served a cached plain-text answer fails to parse it, which
  // surfaces as an upstream outage rather than a cache miss. Same reasoning that excludes tool calls.
  const shape = JSON.stringify(shapeFields(payload));

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
  let shapeSkipped = 0;
  for (const line of raw) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a malformed entry is skipped, not fatal
    }
    // Shape gate. Refuse a candidate that cannot PROVE the shape matches.
    //
    // The asymmetry is deliberate, and it reconciles two requirements that both have to hold:
    //   * A request that demands nothing about the answer's shape can consume either form, so an entry
    //     with no recorded shape - stored before this gate existed - is still served. That is what
    //     keeps "an upgrade is not a cache flush" true for the plain-prose case, which is the vast
    //     majority of traffic.
    //   * A request that DOES demand a shape may only be served by an entry that proves it matches.
    //     Prose handed to a json_object caller fails to parse in the caller and surfaces as an upstream
    //     outage - worse than a miss - and that direction is the entire reason this gate exists.
    // A recorded shape that differs is refused in both directions: the reverse (json handed to a prose
    // caller) does not crash anything, but it is still the wrong answer to the question asked.
    const shapeNeutral = shape === SHAPE_OF_NEUTRAL;
    if (!(record.shape === shape || (record.shape === undefined && shapeNeutral))) {
      shapeSkipped += 1;
      continue;
    }
    const vector = decodeEmbedding(record);
    if (!vector) continue; // ditto an entry whose vector cannot be read
    const candidateNorm = typeof record.norm === 'number' ? record.norm : normOf(vector);
    const similarity = similarityWithNorms(queryEmbedding, queryNorm, vector, candidateNorm);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { entry: record.entry, similarity };
    }
  }
  if (!best && shapeSkipped > 0) {
    // Visible, because "the semantic cache stopped hitting" otherwise looks like a tuning problem
    // rather than the shape gate doing its job.
    console.log(`[semantic] ${shapeSkipped} candidate(s) skipped: answer shape differs from this request`);
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
  // The shape is stored BESIDE the entry rather than folded into the key: matching here is by
  // embedding, so there is no key to fold it into. findMatch refuses a candidate whose shape differs.
  const shape = JSON.stringify(shapeFields(payload));
  try {
    await redis.client.lPush(key, JSON.stringify({
      embedding: encodeEmbedding(embedding),
      norm: normOf(embedding),
      shape,
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
