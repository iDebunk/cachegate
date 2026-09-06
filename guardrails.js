// model-router/guardrails.js
//
// Prompt-injection detection + the policy-enforcement hook shape (roadmap
// step 25, Track B). Heuristic, not a classifier: a small set of
// high-signal patterns that catch the common injection shapes. Gated off
// by default behind GUARDRAILS_ENABLED. Standalone for now - not wired
// into server.js (the pre-dispatch wiring is the joint follow-up once
// pii.js lands, same reason Track A is also standalone).
//
// Because these are heuristics (and therefore false-positive-prone), the
// default action on a detection is `flag` (record + pass through), NOT
// `block`. A deployment that wants to reject on a hit sets
// GUARDRAILS_INJECTION_ACTION=block; the hook shape is what that decision
// plugs into, so block/flag/log are all expressible without a code change.

const INJECTION_PATTERNS = [
  // Instruction-override: "ignore previous instructions", "disregard all
  // prior rules", etc.
  { id: 'ignore_previous_instructions', regex: /(?:ignore|disregard|forget|overwrite|override)\s+(?:all\s+)?(?:previous|prior|earlier|above|your)\s+(?:instructions?|rules?|prompts?)/i },
  // System-prompt leak probes: "reveal your system prompt", "show me your
  // instructions".
  { id: 'system_prompt_leak', regex: /(?:reveal|show|print|display|repeat|output)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|rules?|message|context)/i },
  // Role-play jailbreak framing: "pretend you are", "act as", "roleplay as".
  { id: 'roleplay_jailbreak', regex: /\b(?:pretend|act|roleplay|imagine|pose)\s+(?:you\s+are|as|to\s+be)\b/i },
  // "developer mode" / "dev mode" jailbreak framing.
  { id: 'developer_mode', regex: /\b(?:developer|dev)\s+mode\b/i },
  // DAN / "do anything now".
  { id: 'dan_jailbreak', regex: /\bDAN\b|\bdo\s+anything\s+now\b/i },
  // "no restrictions", "bypass your filters", "remove your guardrails".
  { id: 'no_restrictions', regex: /(?:no|without|bypass|ignore|remove)\s+(?:your\s+)?(?:restrictions?|limits?|limitations?|rules?|guardrails?|filters?)/i }
];

// Scans one piece of text and returns the ids of every matched pattern
// (empty array = clean). Pure - no env, no I/O.
function detectInjection(text) {
  const hits = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.regex.test(String(text))) hits.push(pattern.id);
  }
  return hits;
}

function extractPromptText(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

function isEnabled() {
  return process.env.GUARDRAILS_ENABLED === 'true';
}

// The policy-enforcement hook: evaluate a request's messages and return a
// decision + reasons. `decision` is one of allow/block/flag/log. The
// shape is deliberately minimal so pii.js's redaction and the future
// server.js wiring can feed additional findings into the same decision
// without reshaping this module.
//
// Gated on isEnabled() INSIDE evaluate() itself, not just left to the
// caller to check - same "always callable, flag decides" contract as
// pii.js's redact(). Without this, a future server.js call site that
// forgot its own `if (guardrails.isEnabled())` guard would silently
// flag/block on every request regardless of the deployment's own
// GUARDRAILS_ENABLED setting - exactly the gap this module's own header
// comment claims doesn't exist ("gated off by default").
function evaluate(messages) {
  if (!isEnabled()) {
    return { decision: 'allow', reasons: [] };
  }
  const text = extractPromptText(messages);
  const hits = detectInjection(text);
  if (hits.length === 0) {
    return { decision: 'allow', reasons: [] };
  }
  const action = process.env.GUARDRAILS_INJECTION_ACTION || 'flag'; // block | flag | log
  return { decision: action, reasons: hits };
}

module.exports = { detectInjection, evaluate, isEnabled, INJECTION_PATTERNS };
