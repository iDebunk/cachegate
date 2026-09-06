const { test } = require('node:test');
const assert = require('node:assert/strict');

function freshCoalescing() {
  delete require.cache[require.resolve('../coalescing')];
  return require('../coalescing');
}

test('N concurrent identical keys share ONE dispatch (single-flight)', async () => {
  const c = freshCoalescing();
  let dispatchCount = 0;
  const dispatch = async () => {
    dispatchCount += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { answer: 42 };
  };
  const results = await Promise.all([
    c.joinOrRun('key-1', dispatch),
    c.joinOrRun('key-1', dispatch),
    c.joinOrRun('key-1', dispatch)
  ]);
  assert.equal(dispatchCount, 1); // one upstream call, not three
  assert.equal(results.filter((r) => r.coalesced).length, 2); // two joiners
  assert.equal(results.every((r) => r.result.answer === 42), true);
});

test('two DIFFERENT keys never share a promise', async () => {
  const c = freshCoalescing();
  let dispatchCount = 0;
  const dispatch = async () => { dispatchCount += 1; return {}; };
  const [a, b] = await Promise.all([c.joinOrRun('key-a', dispatch), c.joinOrRun('key-b', dispatch)]);
  assert.equal(dispatchCount, 2);
  assert.equal(a.coalesced, false);
  assert.equal(b.coalesced, false);
});

test("a joiner whose wait times out falls through to its OWN dispatch (fail open, not stuck)", async () => {
  process.env.COALESCE_WAIT_TIMEOUT_MS = '20';
  const c = freshCoalescing();
  let dispatchCount = 0;
  const slow = () => {
    dispatchCount += 1;
    return new Promise((resolve) => setTimeout(() => resolve('leader'), 200));
  };
  const fast = () => { dispatchCount += 1; return Promise.resolve('joiner-own'); };

  const leader = c.joinOrRun('key-1', slow); // leader, 200ms
  await new Promise((r) => setTimeout(r, 5)); // let the leader register first
  const joiner = await c.joinOrRun('key-1', fast); // 20ms timeout -> own dispatch

  const leaderResult = await leader;
  assert.equal(joiner.coalesced, false);
  assert.equal(joiner.result, 'joiner-own');
  assert.equal(leaderResult.result, 'leader');
  assert.equal(dispatchCount, 2); // leader + the timed-out joiner's own dispatch
  delete process.env.COALESCE_WAIT_TIMEOUT_MS;
});

test("a burst past COALESCE_MAX_INFLIGHT skips coalescing rather than growing unbounded", async () => {
  process.env.COALESCE_MAX_INFLIGHT = '2';
  const c = freshCoalescing();
  let dispatchCount = 0;
  const slow = () => {
    dispatchCount += 1;
    return new Promise((resolve) => setTimeout(() => resolve({}), 100));
  };

  const p1 = c.joinOrRun('a', slow);
  const p2 = c.joinOrRun('b', slow);
  await new Promise((r) => setTimeout(r, 5)); // let both leaders register

  // at capacity: a third distinct key dispatches independently, no map growth
  const r3 = await c.joinOrRun('c', slow);
  assert.equal(r3.coalesced, false);
  assert.equal(dispatchCount, 3);

  await Promise.all([p1, p2]);
  delete process.env.COALESCE_MAX_INFLIGHT;
});

test("the leader's failure is propagated to joiners (no false success)", async () => {
  const c = freshCoalescing();
  const failing = async () => { throw new Error('upstream exploded'); };
  const leader = c.joinOrRun('key-1', failing);
  const joiner = c.joinOrRun('key-1', failing);
  await assert.rejects(leader, /upstream exploded/);
  await assert.rejects(joiner, /upstream exploded/);
});
