// model-router/pii.js
//
// Pattern-based PII detection + redaction (roadmap step 25, PII track).
// Gated behind GUARDRAILS_PII_REDACTION (default OFF, same off-by-default
// convention as step 22's local embeddings) - ships fully inert until a
// deployment opts in. Standalone for now: NOT wired into server.js yet
// (see the step 25 kickoff directive) - this module only exposes the
// detection/redaction primitive; the pre-dispatch request-path wiring
// (and the coordination with the injection/policy track it needs to
// share a hook shape with) is a separate, joint follow-up change.
//
// Deliberately pattern/regex based, not a model call: PII redaction has
// to be synchronous, fast (it would run on every request, not just
// cache misses), and free of its own network dependency - a step whose
// whole job is stripping sensitive content out of a request shouldn't
// itself be a network hop that could leak that content to a third party.
//
// Redaction never surfaces the actual matched value anywhere, even in
// its own return value - only { type, count } counters. A false
// positive costs an unnecessary redaction (annoying); a leaked value in
// a log or a metrics row costs an actual PII exposure. This module is
// built to make the cheaper mistake.

// Order matters: more specific/longer patterns run first, so a token
// that could satisfy two shapes (e.g. a 16-digit run also containing a
// phone-shaped substring) is claimed by the more specific match before
// a looser pattern gets a chance to partially match what's left of it.
const PATTERNS = [
  {
    type: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  },
  {
    type: 'credit_card',
    // 13-19 digits, optionally grouped by single spaces or dashes
    // between digits (covers both "4111111111111111" and
    // "4111 1111 1111 1111"/"4111-1111-1111-1111"). Matched by shape
    // first, then narrowed by a Luhn checksum below - shape alone would
    // false-positive on any long unrelated digit run (an order id, a
    // padded invoice number).
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (match) => luhnValid(match.replace(/[ -]/g, ''))
  },
  {
    type: 'ssn',
    // US SSN: NNN-NN-NNNN. Dashes required - a bare 9-digit run is too
    // easy to confuse with an account/phone number to redact safely
    // without a much higher false-positive rate.
    regex: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    type: 'phone',
    // NA-style, requiring at least one separator (space/dash/dot/
    // parens) - a bare 10-digit run is left to the credit-card pattern
    // above (which needs 13+ digits, so no real overlap) rather than
    // guessed at here. Uses digit lookaround, not \b, at both ends: a
    // leading "(" is itself a non-word character, so a \b right before
    // it never matches (word-boundary needs one word char and one
    // non-word char either side) - \b would let the engine skip past a
    // real "(555)" opening paren and leave it un-redacted outside the
    // match. (?<!\d)/(?!\d) only cares that the run isn't glued to more
    // digits, which is what actually needs guarding against here.
    regex: /(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g
  },
  {
    type: 'api_key',
    // Common vendor secret shapes (OpenAI classic "sk-...", OpenAI
    // project-scoped "sk-proj-...", Anthropic "sk-ant-...", AWS,
    // GitHub, Slack, Google) - opaque tokens like these are exactly the
    // kind of thing that ends up pasted into a prompt by accident. The
    // "sk-" body allows dashes/underscores, not just alphanumerics, so
    // it covers the dash-separated "-proj-"/"-ant-" variants too rather
    // than needing one alternative per vendor prefix.
    regex: /\b(?:sk-[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g
  }
];

function luhnValid(digits) {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function isEnabled() {
  return process.env.GUARDRAILS_PII_REDACTION === 'true';
}

// redact(text) -> { text, redactions: [{ type, count }] }.
// Side-effect free and safe to call unconditionally - when the flag is
// off, returns the text UNCHANGED (not an error, not a throw), same
// "always callable, flag decides" shape as embeddings.js's isEnabled().
function redact(text) {
  if (!isEnabled() || typeof text !== 'string' || text.length === 0) {
    return { text, redactions: [] };
  }

  let result = text;
  const counts = new Map();

  for (const { type, regex, validate } of PATTERNS) {
    // A fresh RegExp per pattern per call: the source patterns are
    // global (/g), and a shared stateful regex's lastIndex would
    // corrupt matching across concurrent/repeated calls in a
    // long-running process handling many requests.
    const re = new RegExp(regex.source, regex.flags);
    result = result.replace(re, (match) => {
      if (validate && !validate(match)) return match; // shape matched but failed validation - leave as-is
      counts.set(type, (counts.get(type) || 0) + 1);
      return `[REDACTED_${type.toUpperCase()}]`;
    });
  }

  return {
    text: result,
    redactions: Array.from(counts.entries()).map(([type, count]) => ({ type, count }))
  };
}

module.exports = { isEnabled, redact };
