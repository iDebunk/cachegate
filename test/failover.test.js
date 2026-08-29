const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRetryableError, dispatchWithFailover } = require('../failover');

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

test('isRetryableError treats a bad request (400) as not retryable', () => {
  assert.equal(isRetryableError(httpError('bad request', 400)), false);
});

test('isRetryableError treats an unknown model (404) as not retryable', () => {
  assert.equal(isRetryableError(httpError('not found', 404)), false);
});

test('isRetryableError treats rate limits, server errors, and auth failures as retryable', () => {
  assert.equal(isRetryableError(httpError('rate limited', 429)), true);
  assert.equal(isRetryableError(httpError('server error', 500)), true);
  assert.equal(isRetryableError(httpError('bad gateway', 502)), true);
  assert.equal(isRetryableError(httpError('unauthorized', 401)), true);
});

test('isRetryableError treats a network failure with no status at all as retryable', () => {
  assert.equal(isRetryableError(new Error('ECONNRESET')), true);
});

test('dispatchWithFailover resolves on the first candidate when it succeeds, attempts=1', async () => {
  const candidates = [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }];
  const dispatch = async (c) => ({ ok: true, provider: c.provider });

  const outcome = await dispatchWithFailover(candidates, dispatch);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.candidate.provider, 'openai');
  assert.deepEqual(outcome.result, { ok: true, provider: 'openai' });
});

test('dispatchWithFailover moves to the next candidate on a retryable failure', async () => {
  const candidates = [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }];
  const failedAttempts = [];
  const dispatch = async (c) => {
    if (c.provider === 'openai') throw httpError('rate limited', 429);
    return { ok: true, provider: c.provider };
  };

  const outcome = await dispatchWithFailover(candidates, dispatch, (candidate, err) => {
    failedAttempts.push({ candidate, message: err.message });
  });

  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.candidate.provider, 'anthropic');
  assert.equal(failedAttempts.length, 1);
  assert.equal(failedAttempts[0].candidate.provider, 'openai');
});

test('dispatchWithFailover does not retry a non-retryable (400) error, even with candidates left', async () => {
  const candidates = [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }];
  let anthropicCalled = false;
  const dispatch = async (c) => {
    if (c.provider === 'openai') throw httpError('bad request', 400);
    anthropicCalled = true;
    return { ok: true };
  };

  await assert.rejects(
    () => dispatchWithFailover(candidates, dispatch),
    /bad request/
  );
  assert.equal(anthropicCalled, false);
});

test('dispatchWithFailover rethrows the last error when every candidate fails', async () => {
  const candidates = [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }];
  const dispatch = async (c) => {
    throw httpError(`${c.provider} down`, 503);
  };

  await assert.rejects(
    () => dispatchWithFailover(candidates, dispatch),
    /anthropic down/ // the LAST attempt's error, not the first
  );
});

test('dispatchWithFailover calls onAttemptFailed for every failed candidate, including the last', async () => {
  const candidates = [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }];
  const seen = [];
  const dispatch = async (c) => {
    throw httpError(`${c.provider} down`, 503);
  };

  await assert.rejects(() => dispatchWithFailover(candidates, dispatch, (candidate, err, isLastCandidate) => {
    seen.push({ provider: candidate.provider, isLastCandidate });
  }));

  assert.deepEqual(seen, [
    { provider: 'openai', isLastCandidate: false },
    { provider: 'anthropic', isLastCandidate: true }
  ]);
});
