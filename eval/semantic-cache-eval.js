// model-router/eval/semantic-cache-eval.js
//
// Phase 2 roadmap, step 22.1/22.3 - measures precision/recall of
// whichever `embeddings` backend is active, against semanticCache.js's
// OWN cosineSimilarity() + threshold, using a curated positive/negative
// prompt-pair set (semantic-cache-eval-pairs.json). This is an offline
// measurement tool, not the request path and not run in CI - "ship only
// after a real eval pass" (the moat doc's own words on this step) means
// a human reads this report and decides, not a pass/fail gate that
// silently blocks a build.
//
// Parameterized on the embeddings module (defaults to whichever one
// ../embeddings currently resolves to) so the SAME dataset and harness
// run unchanged against OpenAI (today's default) or the local model
// (once step 22.2 lands - set SEMANTIC_CACHE_LOCAL_EMBEDDINGS=true and
// re-run) - a real apples-to-apples comparison, not two different
// measurements taken two different ways.
//
// Run: npm run eval:semantic-cache
// (needs a real, enabled embeddings backend - OPENAI_API_KEY today)

const { cosineSimilarity, DEFAULT_THRESHOLD } = require('../semanticCache');
const defaultPairs = require('./semantic-cache-eval-pairs.json');

async function runEval({
  embeddings = require('../embeddings'),
  threshold = DEFAULT_THRESHOLD,
  pairs = defaultPairs
} = {}) {
  if (!embeddings.isEnabled()) {
    throw new Error(
      'No embeddings backend is enabled - set OPENAI_API_KEY (or, once available, ' +
      'SEMANTIC_CACHE_LOCAL_EMBEDDINGS=true) before running this eval.'
    );
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const misclassified = [];

  for (const pair of pairs) {
    const [vecA, vecB] = await Promise.all([embeddings.embed(pair.a), embeddings.embed(pair.b)]);
    const similarity = cosineSimilarity(vecA, vecB);
    const predictedMatch = similarity >= threshold;

    if (pair.expectMatch && predictedMatch) {
      tp++;
    } else if (pair.expectMatch && !predictedMatch) {
      fn++;
      misclassified.push({ ...pair, similarity, predictedMatch });
    } else if (!pair.expectMatch && predictedMatch) {
      fp++;
      misclassified.push({ ...pair, similarity, predictedMatch });
    } else {
      tn++;
    }
  }

  // null (not NaN, not a misleading 1/0) when there's nothing to be
  // precise/complete about - e.g. a dataset with zero actual positives
  // makes "recall" an undefined question, not a score of 0.
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;

  return { threshold, total: pairs.length, tp, fp, tn, fn, precision, recall, misclassified };
}

if (require.main === module) {
  runEval()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Eval failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runEval };
