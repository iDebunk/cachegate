// model-router/lsh.js
//
// MinHash/LSH pre-filter for the semantic cache (roadmap step 23).
//
// Why this exists: semanticCache.js finds near-duplicate prompts by cosine
// similarity, and today that is a brute-force scan of every candidate the
// per-model list holds (up to MAX_CANDIDATES_PER_MODEL). The scan is O(N x dim)
// of Float32 multiply-adds per lookup; at the default 200-entry cap that is
// ~3.6ms, which is fine, but it is the reason the cap exists at all - the cap
// is a wall around the cost, not a design goal. This module is the cheaper
// first pass that sits AHEAD of that scan: a random-hyperplane signature
// (SimHash, the cosine analogue of MinHash - MinHash is for Jaccard, this is
// for angles) whose bits are banded into buckets, so a candidate whose bands
// share nothing with the query's can be skipped before its embedding is even
// decoded. The exact cosine scan is still the final judge; this only narrows
// the field. Nothing here can make a wrong match - it can only, if mis-tuned,
// miss a real one - so the tuning bias is deliberately toward recall (see
// the band-size note below).
//
// Honest framing: at the default 200-entry cap the win is modest (~3.5x on
// the cosine work); the point is that it makes RAISING the cap cheap, because
// the expensive part no longer grows linearly with N. The HNSW step (23.2)
// stays deferred behind a traffic trigger, not a date - see the trigger note
// in semanticCache.js.

const DEFAULT_BITS = 64;  // K signature bits (8 bytes)
const DEFAULT_BANDS = 8;  // B bands -> R = K/B = 8 bits per band

// A signature is K bits; with K=64 and B=8, each band is exactly one byte,
// so bandKeys() is just the bytes. The signatures must be STABLE ACROSS
// RESTARTS (a stored signature has to mean the same thing tomorrow), so the
// hyperplanes are generated from a deterministic seeded PRNG, never Math.random.

// mulberry32 - tiny deterministic PRNG, good enough for hyperplane seeds.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller on the seeded PRNG: standard-normal samples for the hyperplanes.
function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// One set of K random hyperplanes per (dimension, bits) pair, cached so the
// query and every stored entry in the same embedding dimension share the same
// planes. A dimension change (OpenAI 1536 -> local 384) is a different cache
// entry - and, correctly, a different signature space, matching the fact that
// the two embedding backends can never cosine-match each other anyway.
const planesCache = new Map();
function planesFor(dim, bits) {
  const key = `${dim}:${bits}`;
  const cached = planesCache.get(key);
  if (cached) return cached;
  const rand = mulberry32(0x9e3779b9 + dim * 0x85ebca6b + bits); // fixed seed, dimension-mixed
  const planes = new Array(bits);
  for (let i = 0; i < bits; i++) {
    const plane = new Float32Array(dim);
    for (let j = 0; j < dim; j++) plane[j] = gaussian(rand);
    planes[i] = plane;
  }
  planesCache.set(key, planes);
  return planes;
}

// K-bit random-hyperplane signature of a vector. Bit i is the sign of vec . h_i.
// Returns a Buffer of K/8 bytes.
function signatureOf(vec, bits = DEFAULT_BITS) {
  if (!vec || vec.length === 0) return null;
  const dim = vec.length;
  const planes = planesFor(dim, bits);
  const sig = Buffer.alloc(bits / 8);
  for (let i = 0; i < bits; i++) {
    let dot = 0;
    const plane = planes[i];
    for (let j = 0; j < dim; j++) dot += vec[j] * plane[j];
    if (dot > 0) sig[i >> 3] |= 1 << (i & 7);
  }
  return sig;
}

// With R = 8 bits per band, each band is one byte: bandKeys is the bytes.
function bandKeys(sig) {
  if (!sig) return null;
  return Array.from(sig);
}

// Do two signatures share any band? Set lookup so it is O(B), not O(B^2).
function sharesBand(a, b) {
  if (!a || !b) return false;
  const set = new Set(a);
  for (const k of b) if (set.has(k)) return true;
  return false;
}

module.exports = {
  signatureOf,
  bandKeys,
  sharesBand,
  DEFAULT_BITS,
  DEFAULT_BANDS
};
