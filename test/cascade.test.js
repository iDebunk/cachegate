const { test } = require('node:test');
const assert = require('node:assert/strict');

// cascade.js reads CASCADE_ENABLED/CASCADE_CONFIDENCE_THRESHOLD once at
// require time (same pattern as router.js/metrics.js), so tests that need a
// non-default gate re-require the module with the env set first.
function freshCascade(env = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[require.resolve('../cascade')];
  return require('../cascade');
}

const cascade = freshCascade({ CASCADE_ENABLED: undefined, CASCADE_CONFIDENCE_THRESHOLD: undefined });

test('cascade is disabled by default', () => {
  assert.equal(cascade.isEnabled(), false);
});

test('cascade.isEnabled reflects CASCADE_ENABLED=true', () => {
  const on = freshCascade({ CASCADE_ENABLED: 'true' });
  assert.equal(on.isEnabled(), true);
});

// --- openaiLogprobConfidence ---

test('openaiLogprobConfidence returns null when there is no logprobs data', () => {
  assert.equal(cascade.openaiLogprobConfidence(null), null);
  assert.equal(cascade.openaiLogprobConfidence({}), null);
  assert.equal(cascade.openaiLogprobConfidence({ raw: {} }), null);
  assert.equal(cascade.openaiLogprobConfidence({ raw: { choices: [] } }), null);
  assert.equal(cascade.openaiLogprobConfidence({ raw: { choices: [{ logprobs: null }] } }), null);
  assert.equal(cascade.openaiLogprobConfidence({ raw: { choices: [{ logprobs: { content: [] } }] } }), null);
});

test('openaiLogprobConfidence computes exp(mean(logprobs)) - the geometric mean of probabilities', () => {
  const result = {
    raw: {
      choices: [{
        logprobs: {
          content: [
            { token: 'a', logprob: Math.log(0.5) }, // ln(0.5)
            { token: 'b', logprob: Math.log(0.2) }  // ln(0.2)
          ]
        }
      }]
    }
  };
  const expected = Math.exp((Math.log(0.5) + Math.log(0.2)) / 2); // sqrt(0.5 * 0.2) = sqrt(0.1)
  assert.ok(Math.abs(cascade.openaiLogprobConfidence(result) - expected) < 1e-9);
});

test('openaiLogprobConfidence skips entries with a missing/non-numeric logprob rather than producing NaN', () => {
  const result = {
    raw: {
      choices: [{
        logprobs: {
          content: [
            { token: 'a', logprob: Math.log(0.8) },
            { token: 'b' }, // no logprob - must be skipped
            { token: 'c', logprob: undefined }
          ]
        }
      }]
    }
  };
  const expected = Math.exp(Math.log(0.8));
  assert.ok(Math.abs(cascade.openaiLogprobConfidence(result) - expected) < 1e-9);
});

// --- parseGraderScore ---

test('parseGraderScore reads a bare number', () => {
  assert.equal(cascade.parseGraderScore('0.8'), 0.8);
  assert.equal(cascade.parseGraderScore('0'), 0);
  assert.equal(cascade.parseGraderScore('1'), 1);
});

test('parseGraderScore extracts the first number from surrounding prose', () => {
  assert.equal(cascade.parseGraderScore('The confidence is 0.3'), 0.3);
  assert.equal(cascade.parseGraderScore('0.7 out of 1'), 0.7);
});

test('parseGraderScore clamps out-of-range values to [0,1]', () => {
  assert.equal(cascade.parseGraderScore('1.5'), 1);
  assert.equal(cascade.parseGraderScore('-0.2'), 0);
});

test('parseGraderScore returns null when there is no numeric token', () => {
  assert.equal(cascade.parseGraderScore(null), null);
  assert.equal(cascade.parseGraderScore(undefined), null);
  assert.equal(cascade.parseGraderScore('not a number'), null);
  assert.equal(cascade.parseGraderScore(''), null);
});

// --- buildGraderMessages ---

test('buildGraderMessages includes the question, the response, and the scoring instruction', () => {
  const messages = cascade.buildGraderMessages(
    [{ role: 'user', content: 'What is 2+2?' }],
    'four'
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.ok(messages[0].content.includes('What is 2+2?'));
  assert.ok(messages[0].content.includes('four'));
  assert.ok(messages[0].content.includes('number between 0 and 1'));
});

test('buildGraderMessages handles a non-string response content (treats it as empty)', () => {
  const messages = cascade.buildGraderMessages(
    [{ role: 'user', content: 'hi' }],
    undefined
  );
  assert.equal(messages[0].role, 'user');
  assert.ok(messages[0].content.includes('Response:'));
});

// --- tryWithCascade ---

function candidate(provider) {
  return { provider, model: `${provider}-model` };
}

test('tryWithCascade returns the first candidate when confidence passes, no escalation', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  const dispatched = [];
  const outcome = await cascade.tryWithCascade(
    candidates,
    async (c) => { dispatched.push(c.provider); return { provider: c.provider, content: `${c.provider} answer` }; },
    async () => 0.9,
    { threshold: 0.5 }
  );
  assert.equal(outcome.candidate.provider, 'openai');
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.cascaded, false);
  assert.equal(outcome.failedOver, false);
  assert.deepEqual(dispatched, ['openai']);
});

test('tryWithCascade escalates to the next candidate when confidence is below the threshold', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  const dispatched = [];
  const escalated = [];
  const outcome = await cascade.tryWithCascade(
    candidates,
    async (c) => { dispatched.push(c.provider); return { provider: c.provider, content: `${c.provider} answer` }; },
    async (result) => (result.provider === 'openai' ? 0.1 : 0.9),
    {
      threshold: 0.5,
      onEscalated: (from, to, cheapResult) => escalated.push({ from: from.provider, to: to.provider, cheap: cheapResult.provider })
    }
  );
  assert.equal(outcome.candidate.provider, 'anthropic');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.cascaded, true);
  assert.equal(outcome.failedOver, false);
  assert.deepEqual(dispatched, ['openai', 'anthropic']);
  assert.deepEqual(escalated, [{ from: 'openai', to: 'anthropic', cheap: 'openai' }]);
});

test('tryWithCascade fails over on a retryable error (no confidence check on the error)', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  const dispatched = [];
  const failed = [];
  const outcome = await cascade.tryWithCascade(
    candidates,
    async (c) => {
      dispatched.push(c.provider);
      if (c.provider === 'openai') throw Object.assign(new Error('rate limited'), { status: 429 });
      return { provider: c.provider, content: 'ok' };
    },
    async () => 0.9,
    {
      threshold: 0.5,
      onAttemptFailed: (c, err, isLast) => failed.push({ provider: c.provider, message: err.message, isLast })
    }
  );
  assert.equal(outcome.candidate.provider, 'anthropic');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.cascaded, false);
  assert.equal(outcome.failedOver, true);
  assert.deepEqual(dispatched, ['openai', 'anthropic']);
  assert.deepEqual(failed, [{ provider: 'openai', message: 'rate limited', isLast: false }]);
});

test('tryWithCascade combines failover and cascade: error, then low confidence, then accept', async () => {
  const candidates = [candidate('openai'), candidate('anthropic'), candidate('other')];
  const dispatched = [];
  const outcome = await cascade.tryWithCascade(
    candidates,
    async (c) => {
      dispatched.push(c.provider);
      if (c.provider === 'openai') throw Object.assign(new Error('down'), { status: 503 });
      return { provider: c.provider, content: 'ok' };
    },
    async (result) => (result.provider === 'anthropic' ? 0.1 : 0.9),
    { threshold: 0.5 }
  );
  assert.equal(outcome.candidate.provider, 'other');
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.cascaded, true);
  assert.equal(outcome.failedOver, true);
  assert.deepEqual(dispatched, ['openai', 'anthropic', 'other']);
});

test('tryWithCascade does not retry a non-retryable (400) error, even with candidates left', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  let anthropicCalled = false;
  await assert.rejects(
    () => cascade.tryWithCascade(
      candidates,
      async (c) => {
        if (c.provider === 'openai') throw Object.assign(new Error('bad request'), { status: 400 });
        anthropicCalled = true;
        return { provider: c.provider };
      },
      async () => 0.9
    ),
    /bad request/
  );
  assert.equal(anthropicCalled, false);
});

test('tryWithCascade rethrows the last error when every candidate fails', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  await assert.rejects(
    () => cascade.tryWithCascade(
      candidates,
      async (c) => { throw Object.assign(new Error(`${c.provider} down`), { status: 503 }); },
      async () => 0.9
    ),
    /anthropic down/
  );
});

test('tryWithCascade treats a null confidence signal as confident (fail-open) - no escalation', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  let anthropicCalled = false;
  const outcome = await cascade.tryWithCascade(
    candidates,
    async (c) => {
      if (c.provider === 'anthropic') anthropicCalled = true;
      return { provider: c.provider, content: 'ok' };
    },
    async () => null, // no confidence signal at all
    { threshold: 0.5 }
  );
  assert.equal(outcome.candidate.provider, 'openai');
  assert.equal(outcome.cascaded, false);
  assert.equal(anthropicCalled, false);
});

test('tryWithCascade only escalates when a next candidate actually exists (last candidate low-confidence is accepted)', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  const outcome = await cascade.tryWithCascade(
    candidates,
    async (c) => ({ provider: c.provider, content: 'ok' }),
    async () => 0.1, // always low confidence
    { threshold: 0.5 }
  );
  // Both candidates low-confidence: escalate once, then accept the last.
  assert.equal(outcome.candidate.provider, 'anthropic');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.cascaded, true);
});

test('tryWithCascade calls onEscalated with the cheap result so its cost can be recorded, and discards it from the outcome', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  const escalated = [];
  const outcome = await cascade.tryWithCascade(
    candidates,
    async (c) => ({ provider: c.provider, content: `${c.provider} answer`, cost_usd: c.provider === 'openai' ? 0.01 : 0.03 }),
    async (result) => (result.provider === 'openai' ? 0.2 : 0.8),
    {
      threshold: 0.5,
      onEscalated: (from, to, cheapResult) => escalated.push(cheapResult)
    }
  );
  assert.equal(outcome.result.provider, 'anthropic'); // the accepted answer, not the cheap one
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].provider, 'openai');
  assert.equal(escalated[0].cost_usd, 0.01); // the cheap result, with its own cost
});

test('tryWithCascade passes failedOver=true to onEscalated when an earlier candidate already errored', async () => {
  const candidates = [candidate('openai'), candidate('anthropic'), candidate('other')];
  const escalatedFlags = [];
  await cascade.tryWithCascade(
    candidates,
    async (c) => {
      if (c.provider === 'openai') throw Object.assign(new Error('down'), { status: 503 });
      return { provider: c.provider, content: 'ok' };
    },
    async (result) => (result.provider === 'anthropic' ? 0.1 : 0.9), // anthropic low -> escalate to other
    {
      threshold: 0.5,
      onEscalated: (from, to, cheapResult, failedOver) => escalatedFlags.push({ from: from.provider, failedOver })
    }
  );
  assert.deepEqual(escalatedFlags, [{ from: 'anthropic', failedOver: true }]);
});

test('tryWithCascade passes failedOver=false to onEscalated when no earlier candidate errored', async () => {
  const candidates = [candidate('openai'), candidate('anthropic')];
  const escalatedFlags = [];
  await cascade.tryWithCascade(
    candidates,
    async (c) => ({ provider: c.provider, content: 'ok' }),
    async (result) => (result.provider === 'openai' ? 0.1 : 0.9),
    {
      threshold: 0.5,
      onEscalated: (from, to, cheapResult, failedOver) => escalatedFlags.push({ from: from.provider, failedOver })
    }
  );
  assert.deepEqual(escalatedFlags, [{ from: 'openai', failedOver: false }]);
});
