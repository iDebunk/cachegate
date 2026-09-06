const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshPii() {
  delete require.cache[require.resolve('../pii')];
  return require('../pii');
}

test('redact() is a no-op when GUARDRAILS_PII_REDACTION is unset (default off)', () => {
  delete process.env.GUARDRAILS_PII_REDACTION;
  const pii = freshPii();
  assert.equal(pii.isEnabled(), false);
  const input = 'contact me at jane@example.com or 555-123-4567';
  const { text, redactions } = pii.redact(input);
  assert.equal(text, input); // unchanged - the whole point of default-off
  assert.deepEqual(redactions, []);
});

test('redact() catches an email address when enabled', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  const { text, redactions } = pii.redact('reach me at jane.doe+work@example.co.uk please');
  assert.equal(text, 'reach me at [REDACTED_EMAIL] please');
  assert.deepEqual(redactions, [{ type: 'email', count: 1 }]);
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() catches a US SSN (dashed) when enabled', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  const { text, redactions } = pii.redact('my SSN is 123-45-6789 for the form');
  assert.equal(text, 'my SSN is [REDACTED_SSN] for the form');
  assert.deepEqual(redactions, [{ type: 'ssn', count: 1 }]);
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() catches a phone number in several common formats', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  for (const phone of ['(555) 123-4567', '555-123-4567', '+1 555.123.4567']) {
    const { text, redactions } = pii.redact(`call ${phone} anytime`);
    assert.equal(text, 'call [REDACTED_PHONE] anytime', `expected redaction for "${phone}"`);
    assert.deepEqual(redactions, [{ type: 'phone', count: 1 }]);
  }
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() catches a real (Luhn-valid) credit card number, spaced or not', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  // 4111111111111111 is the standard Luhn-valid Visa test number.
  for (const card of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111']) {
    const { text, redactions } = pii.redact(`card on file: ${card}`);
    assert.equal(text, 'card on file: [REDACTED_CREDIT_CARD]', `expected redaction for "${card}"`);
    assert.deepEqual(redactions, [{ type: 'credit_card', count: 1 }]);
  }
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() does NOT flag a shape-alike digit run that fails the Luhn check', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  // Same length/shape as a card number, deliberately not Luhn-valid -
  // e.g. an invoice or order id. Should be left untouched.
  const input = 'invoice number 1234567890123456 attached';
  const { text, redactions } = pii.redact(input);
  assert.equal(text, input);
  assert.deepEqual(redactions, []);
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() catches common API-key/secret shapes', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  const cases = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  ];
  for (const key of cases) {
    const { text, redactions } = pii.redact(`here's my key ${key} don't share it`);
    assert.ok(text.includes('[REDACTED_API_KEY]'), `expected an API-key redaction for "${key}"`);
    assert.equal(redactions.length, 1);
    assert.equal(redactions[0].type, 'api_key');
  }
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() handles multiple distinct PII types in one string, with accurate per-type counts', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  const input = 'Email jane@example.com or john@example.com, or call 555-123-4567. SSN 123-45-6789.';
  const { text, redactions } = pii.redact(input);
  assert.equal(text, 'Email [REDACTED_EMAIL] or [REDACTED_EMAIL], or call [REDACTED_PHONE]. SSN [REDACTED_SSN].');
  const byType = Object.fromEntries(redactions.map((r) => [r.type, r.count]));
  assert.deepEqual(byType, { email: 2, phone: 1, ssn: 1 });
});

test('redact() never leaks the original matched value anywhere in its return value', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  const secret = 'jane.doe@example.com';
  const { text, redactions } = pii.redact(`the address is ${secret}`);
  assert.ok(!text.includes(secret));
  assert.ok(!JSON.stringify(redactions).includes(secret));
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() is safe on non-string / empty input, on and off', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  assert.deepEqual(pii.redact(''), { text: '', redactions: [] });
  assert.deepEqual(pii.redact(undefined), { text: undefined, redactions: [] });
  assert.deepEqual(pii.redact(null), { text: null, redactions: [] });
  delete process.env.GUARDRAILS_PII_REDACTION;
});

test('redact() is repeatable across calls without a stale regex lastIndex corrupting later matches', () => {
  process.env.GUARDRAILS_PII_REDACTION = 'true';
  const pii = freshPii();
  // Two back-to-back calls with matches in the same position - a shared
  // stateful /g regex (lastIndex carried across calls) would miss the
  // second call's match. Both must be caught.
  const first = pii.redact('a@example.com');
  const second = pii.redact('b@example.com');
  assert.equal(first.text, '[REDACTED_EMAIL]');
  assert.equal(second.text, '[REDACTED_EMAIL]');
  delete process.env.GUARDRAILS_PII_REDACTION;
});
