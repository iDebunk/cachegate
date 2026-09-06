// model-router/cascade.js
//
// Cascade routing (roadmap Phase 2 step 34): for a `router:` virtual model,
// dispatch to the tier's top-ranked candidate (router.js already produced
// that order), estimate how confident that response is, and if it's below a
// threshold, escalate to the NEXT-ranked candidate instead of accepting the
// cheap answer. This is orthogonal to failover.js's error-driven retry: a
// cheap candidate could fail outright (failover retries on error) or succeed
// unconfidently (cascade escalates on low confidence); both can apply to the
// same request.
//
// Gated off by default (CASCADE_ENABLED). Like every speculative feature in
// this codebase (step 22's local embeddings, step 25's guardrails), it ships
// inert and only activates when a deployment explicitly opts in.
//
// Confidence is per-provider, and there is no single obviously-right answer
// for every provider:
//   - OpenAI: native logprobs. The request asks for logprobs only when
//     cascade is active for that dispatch (see providers/openai.js); the
//     response's per-token natural log-probabilities are reduced to one
//     number via the geometric mean, exp(mean(logprobs)) - a defensible
//     [0,1] figure, not an invented score.
//   - Anthropic: no logprobs. Confidence comes from a grader model (one
//     bounded extra request, not the 2-3x cost multiplier self-consistency
//     would impose) - the caller supplies that as an injected async
//     estimator, because a grader is a real provider call and therefore
//     lives where provider calls live (server.js), not in this pure module.
//     This module owns only the pure, testable halves of the grader: the
//     prompt builder and the numeric-score parser.
//
// Pure control flow, mirroring coalescing.js's factoring: no provider
// clients, no network, no metrics store. Directly unit-testable with fake
// dispatch and confidence functions.

const failover = require('./failover');

// Gated off by default - cascade is genuinely more speculative than health
// scoring (grading one LLM's confidence in another LLM is inherently fuzzy),
// so it must prove itself before ever defaulting on.
const CASCADE_ENABLED = process.env.CASCADE_ENABLED === 'true';

// The confidence floor below which a successful response is escalated to the
// next-ranked candidate instead of accepted. Env-tunable; the default is a
// deliberately ordinary starting point, not a claim about any specific
// provider/model's real confidence distribution.
const CASCADE_CONFIDENCE_THRESHOLD = Number(process.env.CASCADE_CONFIDENCE_THRESHOLD) || 0.5;

function isEnabled() {
  return CASCADE_ENABLED;
}

function threshold() {
  return CASCADE_CONFIDENCE_THRESHOLD;
}

/**
 * Confidence from an OpenAI response's native logprobs: the geometric mean of
 * per-token probabilities, exp(mean(logprobs)) - a number in [0,1]. `result`
 * is the shape providers/openai.js returns; its `raw` field is the full SDK
 * response, whose `choices[0].logprobs.content[]` carries
 * `{token, logprob, bytes, top_logprobs}` when the request asked for
 * logprobs (providers/openai.js only asks when cascade is active for the
 * dispatch).
 *
 * Returns null when there is no logprobs data (the request didn't ask, or
 * the provider didn't return any) - a missing confidence signal must never
 * be treated as low confidence (fail-open), the same discipline router.js's
 * "insufficient data must never shed" holds to.
 */
function openaiLogprobConfidence(result) {
  const content = result && result.raw && result.raw.choices
    && result.raw.choices[0] && result.raw.choices[0].logprobs
    && result.raw.choices[0].logprobs.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const logprobs = content
    .map((entry) => (entry && typeof entry.logprob === 'number' ? entry.logprob : null))
    .filter((v) => v !== null && Number.isFinite(v));
  if (logprobs.length === 0) return null;
  const mean = logprobs.reduce((sum, v) => sum + v, 0) / logprobs.length;
  return Math.exp(mean);
}

/**
 * Parse a grader model's reply into a [0,1] confidence number, or null. The
 * grader is prompted to reply with only a number; this tolerates surrounding
 * prose/whitespace but never invents a score it can't read (null, not a
 * guess, when there's no numeric token).
 */
function parseGraderScore(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/[+-]?(?:\d+\.?\d*|\.\d+)/);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * Build the grader prompt messages: the original question plus the candidate
 * response, asking for a single 0-1 number. `questionMessages` is the
 * request's own messages (the question); `responseContent` is what the
 * candidate answered.
 */
function buildGraderMessages(questionMessages, responseContent) {
  const question = questionMessages
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  return [{
    role: 'user',
    content: [
      'Question:',
      question,
      '',
      'Response:',
      String(responseContent == null ? '' : responseContent),
      '',
      'Does this response fully and confidently answer the question? Reply with only a number between 0 and 1 (0 = not at all, 1 = fully and confidently).'
    ].join('\n')
  }];
}

/**
 * Cascade orchestration for a virtual model's ranked candidates when cascade
 * is active: walks the list once, failing over on ERROR and escalating on LOW
 * CONFIDENCE. Reuses failover.isRetryableError so the "is this error worth
 * retrying" decision has exactly one source of truth (failover.js); the walk
 * itself is re-derived here only because cascade adds a second reason to move
 * to the next candidate that failover.dispatchWithFailover doesn't know
 * about. failover.dispatchWithFailover remains the path when cascade is
 * disabled - the default is byte-identical to before this module existed.
 *
 * @param {Array<{provider: string, model: string}>} candidates ranked order
 *   (router.js's pickCandidate().rankedCandidates)
 * @param {(candidate) => Promise<any>} dispatch one candidate's provider call
 * @param {(result) => Promise<number|null>} estimateConfidence per-result
 *   confidence; null means "no signal" and is treated as CONFIDENT (fail-open)
 * @param {object} [options]
 * @param {number} [options.threshold] confidence floor for escalation
 * @param {(candidate, err, isLastCandidate) => void} [options.onAttemptFailed]
 *   error metric hook (same contract as failover.dispatchWithFailover's)
 * @param {(fromCandidate, toCandidate, cheapResult, failedOver) => void} [options.onEscalated]
 *   hook fired when a low-confidence success is escalated away (the cheap
 *   result's cost is the caller's to record here; it is deliberately NOT
 *   returned - rejecting it is the whole point of cascade). `failedOver` is
 *   true when an earlier candidate in this same walk already errored, so the
 *   caller can record the cheap attempt's quality honestly (0.5, not 1.0).
 * @returns {Promise<{result, candidate, attempts, cascaded, failedOver}>}
 */
async function tryWithCascade(candidates, dispatch, estimateConfidence, options = {}) {
  const {
    threshold: confidenceThreshold = threshold(),
    onAttemptFailed,
    onEscalated
  } = options;

  let lastErr;
  let failedOver = false;
  let cascaded = false;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isLastCandidate = i === candidates.length - 1;
    let result;
    try {
      result = await dispatch(candidate);
    } catch (err) {
      lastErr = err;
      failedOver = true;
      if (onAttemptFailed) onAttemptFailed(candidate, err, isLastCandidate);
      if (!failover.isRetryableError(err) || isLastCandidate) throw err;
      continue; // failover: try the next candidate
    }

    const confidence = await estimateConfidence(result);
    if (typeof confidence === 'number' && confidence < confidenceThreshold && !isLastCandidate) {
      // Low confidence, and a next candidate exists: escalate rather than
      // accept the cheap answer.
      if (onEscalated) onEscalated(candidate, candidates[i + 1], result, failedOver);
      cascaded = true;
      continue;
    }
    return { result, candidate, attempts: i + 1, cascaded, failedOver };
  }

  // Unreachable when candidates.length > 0 (the loop either returns or
  // throws); kept honest for an empty list, mirroring failover.js.
  throw lastErr;
}

module.exports = {
  isEnabled,
  threshold,
  openaiLogprobConfidence,
  parseGraderScore,
  buildGraderMessages,
  tryWithCascade
};
