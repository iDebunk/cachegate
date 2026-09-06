const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runEval } = require('./semantic-cache-eval');

// A fake embeddings backend with hand-picked 2D unit vectors so the
// resulting cosine similarities are exact, known numbers - this tests
// the harness's OWN confusion-matrix/precision/recall arithmetic in
// isolation, with no real network call and no dependency on any real
// embedding model's actual behavior (that's what a real run against
// OpenAI/the local model is for - see semantic-cache-eval-pairs.json).
const V0 = [1, 0]; // reference vector
const V_SAME = [1, 0]; // cosine sim with V0 = 1.0
const V_CLOSE = [0.95, Math.sqrt(1 - 0.95 ** 2)]; // unit vector, cosine sim with V0 = 0.95 exactly
const V_FAR = [0, 1]; // cosine sim with V0 = 0

function fakeEmbeddings(vectorByText) {
  return {
    isEnabled: () => true,
    embed: async (text) => {
      if (!(text in vectorByText)) throw new Error(`fakeEmbeddings: no vector defined for "${text}"`);
      return vectorByText[text];
    }
  };
}

test('runEval computes a full confusion matrix and precision/recall correctly', async () => {
  const pairs = [
    { a: 'ref', b: 'same', expectMatch: true }, // TP: sim 1.0 >= 0.93
    { a: 'ref', b: 'far-but-expected', expectMatch: true }, // FN: sim 0 < 0.93, but expected a match
    { a: 'ref', b: 'far', expectMatch: false }, // TN: sim 0 < 0.93, correctly no match
    { a: 'ref', b: 'close-but-unexpected', expectMatch: false } // FP: sim 0.95 >= 0.93, but expected no match
  ];
  const embeddings = fakeEmbeddings({
    ref: V0,
    same: V_SAME,
    'far-but-expected': V_FAR,
    far: V_FAR,
    'close-but-unexpected': V_CLOSE
  });

  const result = await runEval({ embeddings, pairs });

  assert.equal(result.tp, 1);
  assert.equal(result.fn, 1);
  assert.equal(result.tn, 1);
  assert.equal(result.fp, 1);
  assert.equal(result.total, 4);
  assert.ok(Math.abs(result.precision - 0.5) < 1e-9); // TP/(TP+FP) = 1/2
  assert.ok(Math.abs(result.recall - 0.5) < 1e-9); // TP/(TP+FN) = 1/2
  assert.equal(result.misclassified.length, 2); // the FN and the FP, not the TP/TN
});

test('runEval respects a custom threshold, not just the default 0.93', async () => {
  const pairs = [{ a: 'ref', b: 'close', expectMatch: true }];
  const embeddings = fakeEmbeddings({ ref: V0, close: V_CLOSE }); // similarity exactly 0.95

  const strict = await runEval({ embeddings, pairs, threshold: 0.99 });
  assert.equal(strict.tp, 0);
  assert.equal(strict.fn, 1); // 0.95 < 0.99 -> predicted no-match, but expected one

  const lenient = await runEval({ embeddings, pairs, threshold: 0.90 });
  assert.equal(lenient.tp, 1); // 0.95 >= 0.90 -> predicted match, as expected
  assert.equal(lenient.fn, 0);
});

test('runEval returns null (not NaN or a misleading 0/1) precision/recall when there is nothing to score', async () => {
  // Every pair here expects NO match, and none predicts one - zero
  // actual positives makes "recall" an undefined question, not 0.
  const pairs = [{ a: 'ref', b: 'far', expectMatch: false }];
  const embeddings = fakeEmbeddings({ ref: V0, far: V_FAR });

  const result = await runEval({ embeddings, pairs });
  assert.equal(result.tp, 0);
  assert.equal(result.fp, 0);
  assert.equal(result.fn, 0);
  assert.equal(result.tn, 1);
  assert.equal(result.precision, null);
  assert.equal(result.recall, null);
});

test('runEval throws clearly, without attempting any embed() calls, when the backend is disabled', async () => {
  const embeddings = { isEnabled: () => false, embed: async () => { throw new Error('should never be called'); } };
  await assert.rejects(() => runEval({ embeddings }), /No embeddings backend is enabled/);
});

test('the real semantic-cache-eval-pairs.json dataset is well-formed and balanced', () => {
  // Not a precision/recall check (that needs a real backend) - just a
  // sanity floor so a future edit to the dataset can't silently drop
  // the shape this eval depends on (both classes present, no
  // duplicate/degenerate pairs).
  const pairs = require('./semantic-cache-eval-pairs.json');
  assert.ok(pairs.length >= 10, 'dataset should have a meaningful number of pairs');
  const positives = pairs.filter((p) => p.expectMatch === true);
  const negatives = pairs.filter((p) => p.expectMatch === false);
  assert.ok(positives.length > 0, 'dataset needs at least one true-match pair');
  assert.ok(negatives.length > 0, 'dataset needs at least one non-match pair');
  for (const pair of pairs) {
    assert.equal(typeof pair.a, 'string');
    assert.equal(typeof pair.b, 'string');
    assert.notEqual(pair.a, pair.b, 'a pair should compare two different texts, not a text against itself');
  }
});
