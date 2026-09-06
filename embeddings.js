// model-router/embeddings.js
//
// Two embedding backends, selected by SEMANTIC_CACHE_LOCAL_EMBEDDINGS
// (default OFF, roadmap step 22.4):
//
// - OpenAI (default): text-embedding-3-small, 1536-dim, needs
//   OPENAI_API_KEY. The pre-existing behavior, unchanged - which means
//   a deployment that only chats with Anthropic still needs an OpenAI key
//   for semantic caching, exactly as before.
// - Local (opt-in): all-MiniLM-L6-v2 via @huggingface/transformers, 384-dim,
//   pure JS/WASM - no native build, no API key, fully self-hosted. The
//   model is downloaded and cached by transformers.js on FIRST use, so the
//   first local embed() is slow; later calls are in-process.
//
// OPERATIONAL NOTE (not silent): flipping this flag on a deployment with
// an existing semantic cache orphans every previously-stored entry -
// semanticCache.js's cosineSimilarity() returns 0 for a length mismatch
// (its own guard) rather than throwing, so old 1536-dim entries simply
// never match again and age out via MAX_CANDIDATES_PER_MODEL's cap / TTL.
// Not a crash, but the cache warms up from zero again.

const { OpenAI } = require('openai');

const LOCAL_EMBEDDING_DIMENSIONS = 384; // all-MiniLM-L6-v2
const OPENAI_EMBEDDING_DIMENSIONS = 1536; // text-embedding-3-small

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

// The local pipeline is lazy: @huggingface/transformers is heavy (WASM +
// model download on first use), so it must never load unless the flag is
// on. @huggingface/transformers (v3, same pipeline() API) rather than the
// frozen @xenova/transformers: the older package pins a vulnerable
// protobufjs transitively (CVSS 9.8) that ships to every installer.
let localPipeline;
async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline } = await import('@huggingface/transformers');
    localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return localPipeline;
}

function useLocal() {
  return process.env.SEMANTIC_CACHE_LOCAL_EMBEDDINGS === 'true';
}

// Which backend is active, exposed so tests can pin "the flag actually
// switches backends" without downloading a model.
function activeBackend() {
  return useLocal() ? 'local' : 'openai';
}

// Factored out of embed() so the timeout contract is directly testable
// (kept for the OpenAI network path; the local path is in-process).
function embedTimeoutMs() {
  return Number(process.env.EMBEDDING_TIMEOUT_MS) || 5000;
}

function isEnabled() {
  if (useLocal()) return true;
  return Boolean(process.env.OPENAI_API_KEY);
}

async function embed(text) {
  if (!isEnabled()) {
    throw new Error('OPENAI_API_KEY not configured - embeddings unavailable');
  }

  if (useLocal()) {
    // Local path: no network on the hot path after first use, but the
    // FIRST call loads (and possibly downloads) the model - the same
    // try/catch in semanticCache.js that degrades OpenAI timeouts to
    // "skip semantic caching" also covers a local-load failure.
    const pipeline = await getLocalPipeline();
    const output = await pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  // OpenAI path (unchanged): a hard timeout per embedding call. These run
  // on the hot request path (semanticCache.js's findMatch/store, one or
  // two per miss), so a hung embedding provider must not be able to stall
  // every chat request. AbortSignal.timeout aborts the underlying fetch,
  // and the thrown error is caught by semanticCache.js's own try/catch,
  // which degrades to "skip semantic caching" rather than failing.
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  const response = await getClient().embeddings.create(
    { model, input: text },
    { signal: AbortSignal.timeout(embedTimeoutMs()) }
  );
  return response.data[0].embedding;
}

module.exports = {
  isEnabled,
  embed,
  embedTimeoutMs,
  activeBackend,
  LOCAL_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_DIMENSIONS
};
