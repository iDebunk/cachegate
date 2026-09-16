// test/lsh.test.js - the LSH pre-filter (step 23) does what the semantic cache
// needs from it: deterministic signatures (stable across restarts), a band split
// whose "share a band" test never drops a genuine near-duplicate, and reliably
// drops the far-away vectors that the brute-force scan used to waste cosine on.
//
// These are the properties the pre-filter lives or dies on, so they are tested
// directly against the LSH module - no Redis, no embedding API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const lsh = require('../lsh');

// Same small deterministic PRNG as lsh.js, re-implemented here ONLY to build
// test vectors - the module under test keeps its own (identical) hyperplanes.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitVec(dim, seed) {
  const rand = mulberry32(seed);
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) { v[i] = rand() * 2 - 1; norm += v[i] * v[i]; }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// v' = normalize(v + eps * noise) -> cosine(v, v') ~ 1/sqrt(1 + eps^2)
function perturb(v, eps, seed) {
  const rand = mulberry32(seed);
  const noise = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) { noise[i] = rand() * 2 - 1; n += noise[i] * noise[i]; }
  n = Math.sqrt(n);
  const scale = eps / n;   // noise L2-norm = eps exactly (per-component eps would blow up in high dims)
  const w = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) w[i] = v[i] + scale * noise[i];
  let norm = 0;
  for (let i = 0; i < w.length; i++) norm += w[i] * w[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < w.length; i++) w[i] /= norm;
  return w;
}

test('signatures are deterministic and band-split into DEFAULT_BANDS bytes', () => {
  const v = randomUnitVec(64, 1);
  const a = lsh.signatureOf(v);
  const b = lsh.signatureOf(v);
  assert.deepEqual(a, b, 'same vector -> byte-identical signature across calls (restart stability)');
  assert.equal(lsh.bandKeys(a).length, lsh.DEFAULT_BANDS, 'K=64 bits, B=8 bands -> 8 one-byte bands');
});

test('identical vectors share a band (trivially)', () => {
  const v = randomUnitVec(128, 2);
  const sig = lsh.signatureOf(v);
  assert.equal(lsh.sharesBand(lsh.bandKeys(sig), lsh.bandKeys(sig)), true);
});

test('a near-duplicate (cosine ~0.99) shares a band - recall is preserved', () => {
  // eps=0.1 -> cosine ~ 1/sqrt(1.01) ~ 0.995. The whole point of the pre-filter is
  // that a genuine near-duplicate is NEVER dropped; assert this over several pairs.
  for (let i = 0; i < 50; i++) {
    const v = randomUnitVec(96, 100 + i);
    const v2 = perturb(v, 0.1, 200 + i);
    assert.ok(cosine(v, v2) >= 0.99, `fixture is a near-duplicate (cosine ${cosine(v, v2)})`);
    assert.equal(
      lsh.sharesBand(lsh.bandKeys(lsh.signatureOf(v)), lsh.bandKeys(lsh.signatureOf(v2))),
      true,
      `near-duplicate pair ${i} must share a band`
    );
  }
});

test('opposite vectors flip every signature bit (the signature is a pure sign projection)', () => {
  // v and -v project onto every hyperplane with opposite sign, so each bit is the
  // complement of the other. This is the deterministic property the pre-filter leans on:
  // a signature is a projection, and the cosine scan (not the bands) is the final judge.
  for (let i = 0; i < 10; i++) {
    const v = randomUnitVec(96, 300 + i);
    const neg = new Float32Array(v.length);
    for (let j = 0; j < v.length; j++) neg[j] = -v[j];
    const a = lsh.signatureOf(v);
    const b = lsh.signatureOf(neg);
    for (let k = 0; k < a.length; k++) {
      assert.equal(a[k] ^ b[k], 0xff, `byte ${k} of v and -v must be complementary (pair ${i})`);
    }
  }
});

test('unrelated vectors are dropped the vast majority of the time', () => {
  // Two independently-drawn unit vectors are near-orthogonal, so their signatures
  // agree per-bit ~50% and share a full 8-bit band (same position) only ~3% of the
  // time. Assert under 10% - tight enough to catch the cross-position band-match bug
  // (which measured ~23-25% fan-out and was found by bench/lsh-benchmark.js).
  let shared = 0;
  const trials = 200;
  for (let i = 0; i < trials; i++) {
    const a = randomUnitVec(96, 1000 + i);
    const b = randomUnitVec(96, 2000 + i);
    if (lsh.sharesBand(lsh.bandKeys(lsh.signatureOf(a)), lsh.bandKeys(lsh.signatureOf(b)))) shared++;
  }
  assert.ok(shared < trials * 0.1, `pre-filter should skip >90% of unrelated pairs (shared ${shared}/${trials})`);
});
