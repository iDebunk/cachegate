// model-router/failover.js
//
// Pure control flow for trying a virtual model's ranked candidates in
// order until one succeeds - isolated from the actual provider-calling
// code (server.js's dispatchToProvider) so it's directly unit-testable
// with a fake dispatch function, no live API keys or network calls
// needed. Same reasoning as providers/*.js's own
// applyStreamEvent/applyStreamChunk factoring: the trickiest logic
// shouldn't require a real provider to test.
//
// Addresses ROADMAP.md's gap #2 ("no provider failover on a
// 5xx/rate-limit"): router.js's pickCandidate() already ranks every
// candidate in a tier by the configured strategy, but server.js used
// to dispatch to the top-ranked one only - if it failed, the whole
// request failed, even when a second healthy candidate existed in the
// same tier. This module is what actually walks that ranked list.

// Whether a failed dispatch attempt is worth retrying against the NEXT
// candidate, vs failing the request outright. The distinction: is the
// REQUEST itself broken (retrying elsewhere would fail identically),
// or did THIS provider fail in a way another provider might not (rate
// limit, an outage, a bad or expired key)? Bad request (400) and
// unknown model (404) are the request's own fault, not retried - the
// Anthropic and OpenAI SDKs both set `.status` on a thrown APIError.
// A network-level failure with no HTTP response at all (no `.status`)
// is treated as the provider's fault too, since it's not the
// request's content that's the problem. An auth failure (401) or
// missing-key misconfiguration is ALSO treated as retryable on
// purpose: a different candidate in the tier may use a different
// provider whose key is fine, so the request can still succeed - the
// broken key itself still surfaces on the dashboard's Provider alerts
// table via the metrics.record() call made before moving on (see
// server.js), so failover keeps requests succeeding without hiding
// the underlying problem from whoever needs to go fix that key.
function isRetryableError(err) {
  const status = err && (err.status || err.statusCode);
  return status !== 400 && status !== 404;
}

/**
 * Calls `dispatch(candidate)` for each candidate in order until one
 * resolves. On a rejection, calls `onAttemptFailed(candidate, err,
 * isLastCandidate)` (for logging/metrics only - it has no bearing on
 * control flow) and, unless the error is non-retryable or this was
 * the last candidate, moves on to the next one. Rethrows the error
 * from the LAST attempt if every candidate fails - the caller decides
 * what HTTP status/response that becomes.
 *
 * Resolves to `{ result, candidate, attempts }` on success -
 * `attempts` is 1 when the first candidate just worked, >1 when
 * failover actually happened (worth logging distinctly - see
 * server.js's caller).
 *
 * @param {Array<{provider: string, model: string}>} candidates ranked
 *   order, e.g. router.js's pickCandidate().rankedCandidates
 * @param {(candidate) => Promise<any>} dispatch
 * @param {(candidate, err, isLastCandidate) => void} [onAttemptFailed]
 */
async function dispatchWithFailover(candidates, dispatch, onAttemptFailed) {
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isLastCandidate = i === candidates.length - 1;
    try {
      const result = await dispatch(candidate);
      return { result, candidate, attempts: i + 1 };
    } catch (err) {
      lastErr = err;
      if (onAttemptFailed) onAttemptFailed(candidate, err, isLastCandidate);
      if (!isRetryableError(err) || isLastCandidate) throw err;
    }
  }
  throw lastErr; // unreachable when candidates.length > 0; kept honest for an empty list
}

module.exports = { isRetryableError, dispatchWithFailover };
