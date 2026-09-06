// model-router/coalescing.js
//
// Request coalescing (single-flight, roadmap step 24): N identical
// concurrent cache-MISS requests share ONE upstream dispatch instead of N.
// Keyed by the exact cache key (cache.buildCacheKey), so only byte-
// identical requests coalesce - near-duplicates are the semantic cache's
// job, not this. A leader creates + stores the dispatch promise BEFORE
// awaiting it, so a second caller arriving mid-flight finds it; joiners
// await that same promise. The map entry self-removes when it settles.

const MAX_INFLIGHT = Number(process.env.COALESCE_MAX_INFLIGHT) || 500;
const WAIT_TIMEOUT_MS = Number(process.env.COALESCE_WAIT_TIMEOUT_MS) || 3000;

const inFlight = new Map(); // cacheKey -> Promise<result>

// Returns { result, coalesced }. coalesced:true means this caller joined an
// existing in-flight dispatch (and should record a `coalesced` metric, zero
// NEW cost); coalesced:false means this caller was the leader, or dispatched
// independently after a join-timeout / capacity skip.
async function joinOrRun(key, dispatch) {
  const existing = inFlight.get(key);

  if (existing) {
    // Joiner: await the leader, but only for a bounded wait. If the leader
    // hangs past WAIT_TIMEOUT_MS, fail OPEN (dispatch independently) rather
    // than hang forever on someone else's stuck request. A leader that
    // REJECTS before the timeout propagates that rejection to the joiner
    // (Promise.race settles with the first settled promise), so a joiner
    // never gets a false success.
    const outcome = await Promise.race([
      existing.then((result) => ({ result, coalesced: true })),
      new Promise((resolve) => setTimeout(() => resolve(undefined), WAIT_TIMEOUT_MS))
    ]);
    if (outcome !== undefined) return outcome;
    // timed out -> fall through to an independent dispatch below
  } else if (inFlight.size < MAX_INFLIGHT) {
    // Leader (and only while there's room): create + store the promise
    // BEFORE awaiting it, so the next caller finds it. Self-removes on
    // settle, success or failure.
    const promise = dispatch();
    inFlight.set(key, promise);
    try {
      const result = await promise;
      return { result, coalesced: false };
    } finally {
      // Remove only if it is still OUR entry (a timed-out joiner that
      // dispatched independently never stored its own, so this guard is
      // defensive against any future change that does).
      if (inFlight.get(key) === promise) inFlight.delete(key);
    }
  }

  // Timed-out joiner, or map at capacity: dispatch independently, no map
  // entry (skip coalescing). The capacity path is a defensive cap against a
  // pathological high-cardinality burst, not a real-world leak (entries
  // already self-remove on settle).
  return { result: await dispatch(), coalesced: false };
}

module.exports = { joinOrRun };
