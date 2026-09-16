// bench/lsh-benchmark.js - measures the LSH pre-filter (step 23) against brute-force.
// Reports (a) fan-out - what fraction of candidates share a band with the query - and
// (b) wall-clock per lookup, so the 23.2 HNSW trigger is grounded in numbers, not guesswork.
//
// Model: candidates already carry their STORED signature (as semanticCache.js stores it);
// the query's signature is computed once per lookup, then each candidate is band-checked
// (cheap) and only band-matching ones get the cosine (expensive). Brute-force is cosine
// over every candidate. This is exactly the trade the shipped code makes.

const lsh = require('../lsh');

const DIM = 1536;                 // OpenAI text-embedding-3-small
const BITS = lsh.DEFAULT_BITS;    // 64
const BANDS = lsh.DEFAULT_BANDS;  // 8

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
  let n = 0;
  for (let i = 0; i < dim; i++) { v[i] = rand() * 2 - 1; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

// v' = normalize(v + eps-noise) -> cosine(v, v') ~ 1/sqrt(1+eps^2)
function nearDuplicate(v, eps, seed) {
  const rand = mulberry32(seed);
  const noise = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) { noise[i] = rand() * 2 - 1; n += noise[i] * noise[i]; }
  n = Math.sqrt(n);
  const scale = eps / n;
  const w = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) w[i] = v[i] + scale * noise[i];
  let wn = 0; for (let i = 0; i < w.length; i++) wn += w[i] * w[i]; wn = Math.sqrt(wn);
  for (let i = 0; i < w.length; i++) w[i] /= wn;
  return w;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function buildDataset(n, dim) {
  const vecs = new Array(n);
  const sigs = new Array(n);
  for (let i = 0; i < n; i++) {
    vecs[i] = randomUnitVec(dim, 1000 + i);
    sigs[i] = lsh.signatureOf(vecs[i]);
  }
  return { vecs, sigs };
}

function fanOutOf(query, sigs) {
  const qSig = lsh.signatureOf(query);
  const qBands = lsh.bandKeys(qSig);
  let passed = 0;
  for (const s of sigs) if (lsh.sharesBand(qBands, lsh.bandKeys(s))) passed++;
  return passed;
}

function time(fn, iters = 5) {
  // best-of-N wall clock, to dodge GC/JIT noise
  let best = Infinity;
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

function bruteForceLookup(query, vecs) {
  let best = -1;
  for (const v of vecs) { const s = cosine(query, v); if (s > best) best = s; }
  return best;
}

function lshLookup(query, sigs, vecs) {
  const qSig = lsh.signatureOf(query);
  const qBands = lsh.bandKeys(qSig);
  let best = -1;
  for (let i = 0; i < vecs.length; i++) {
    if (!lsh.sharesBand(qBands, lsh.bandKeys(sigs[i]))) continue;
    const s = cosine(query, vecs[i]);
    if (s > best) best = s;
  }
  return best;
}

const { vecs, sigs } = buildDataset(20000, DIM);

console.log(`=== LSH pre-filter benchmark (dim=${DIM}, K=${BITS} bits, B=${BANDS} bands) ===\n`);

// --- fan-out ---
console.log('Fan-out (fraction of candidates that pass the pre-filter):');
const fresh = randomUnitVec(DIM, 77777);                       // unrelated to everything
const dup095 = nearDuplicate(vecs[0], 0.32, 4242);             // cosine ~ 1/sqrt(1.10) ~ 0.95
const dup099 = nearDuplicate(vecs[0], 0.14, 4242);             // cosine ~ 1/sqrt(1.02) ~ 0.99
for (const [label, q, sim] of [
  ['unrelated query (no stored match)', fresh, null],
  ['near-duplicate of a stored entry (~0.95)', dup095, cosine(dup095, vecs[0])],
  ['near-duplicate of a stored entry (~0.99)', dup099, cosine(dup099, vecs[0])],
]) {
  const passed = fanOutOf(q, sigs);
  const pct = (100 * passed / sigs.length).toFixed(1);
  const simStr = sim === null ? 'n/a' : sim.toFixed(3);
  console.log(`  ${label.padEnd(40)} cosine=${simStr.padStart(6)}  fan-out=${passed}/${sigs.length} (${pct}%)`);
}
console.log('');

// --- wall-clock, per lookup, at increasing N ---
console.log('Wall-clock per lookup (best of 5):');
for (const n of [200, 2000, 20000]) {
  const v = vecs.slice(0, n);
  const s = sigs.slice(0, n);
  const q = nearDuplicate(vecs[0], 0.32, 9999);  // realistic: a near-duplicate query
  const bf = time(() => bruteForceLookup(q, v));
  const ls = time(() => lshLookup(q, s, v));
  const speedup = (bf / ls).toFixed(1);
  console.log(`  N=${String(n).padEnd(5)}  brute-force ${bf.toFixed(2).padStart(7)}ms | LSH pre-filter ${ls.toFixed(2).padStart(7)}ms | ${speedup}x`);
}
