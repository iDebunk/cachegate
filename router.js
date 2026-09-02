// model-router/router.js
//
// The actual routing decision. Before this file existed, "the router"
// only dispatched: it read the model name the caller already sent
// (e.g. "claude-sonnet-4-5-20250929") and forwarded to whichever
// provider owns that name. That's not routing - the caller had already
// made the choice. This file adds the thing the product is named for:
// given a REQUEST FOR A CAPABILITY (not a specific vendor's model), pick
// a currently-healthy provider that can serve it - by cost (default),
// by latency, or by cost with a latency guard rail; see ROUTER_STRATEGY
// below for what each one actually does and doesn't guarantee.
//
// Backward compatibility is deliberate: a caller that already names a
// concrete model (any name not starting with "router:") is dispatched
// exactly as before, unchanged, in server.js. Nothing here overrides an
// explicit choice - virtual models are opt-in.

const anthropicProvider = require('./providers/anthropic');
const openaiProvider = require('./providers/openai');
const metrics = require('./metrics');

// A tier groups equivalent-capability models across providers - the
// deployer's judgment call about which models belong in the same
// bucket, not a claim this router can verify. Within a tier, selection
// is ALWAYS by estimated cost, full stop - never by some notion of
// "quality." That used to be fuzzy: a tier named "router:best" implied
// picking the best model, but pickCandidate() only ever compared cost,
// so it silently picked whichever candidate was cheaper - cheaper, not
// better. Naming it "frontier" instead of "best" says what's actually
// true: this is the pool of frontier-capability models the deployer
// trusts, and the router's only job is finding the cheapest healthy one
// in that pool. If a deployment genuinely needs "always this specific
// model regardless of price," that's what naming a concrete model
// directly (skipping "router:" tiers entirely) is for.
const DEFAULT_TIERS = {
  'router:fast-cheap': [
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }
  ],
  'router:frontier': [
    { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'openai', model: 'gpt-4o' }
  ]
};

function loadTiers() {
  if (!process.env.ROUTER_TIERS_JSON) return DEFAULT_TIERS;
  try {
    return JSON.parse(process.env.ROUTER_TIERS_JSON);
  } catch (err) {
    console.warn('⚠️ ROUTER_TIERS_JSON is not valid JSON, using defaults:', err.message);
    return DEFAULT_TIERS;
  }
}

// Three strategies, not one blended score. A weighted cost/latency
// formula LOOKS more sophisticated but is really just a made-up
// tradeoff dressed up as intelligence - whatever weights it used would
// be a guess this router has no basis for making on the deployer's
// behalf. These three are each simple enough to state exactly what they
// do:
//
//   cost                 - (default, unchanged from before) cheapest
//                          healthy candidate, full stop.
//   latency              - fastest healthy candidate by recent average
//                          latency, full stop. Cost isn't considered at
//                          all except as a tiebreaker.
//   latency-guarded-cost - cheapest healthy candidate, EXCLUDING any
//                          candidate whose recent average latency is
//                          more than ROUTER_LATENCY_GUARD_MULTIPLIER
//                          (default 3x) slower than the fastest known
//                          healthy candidate. A candidate with no
//                          latency history yet is never excluded by the
//                          guard - it hasn't had a chance to be slow.
//                          This is the one genuinely "latency-aware"
//                          option that still keeps cost as the primary
//                          signal: it's a guard rail against picking
//                          something dramatically slower to save a
//                          fraction of a cent, not a full re-ranking.
const VALID_STRATEGIES = ['cost', 'latency', 'latency-guarded-cost'];
const DEFAULT_STRATEGY = 'cost';
const LATENCY_GUARD_MULTIPLIER = Number(process.env.ROUTER_LATENCY_GUARD_MULTIPLIER) || 3;

function loadStrategy() {
  const raw = (process.env.ROUTER_STRATEGY || DEFAULT_STRATEGY).trim();
  if (!VALID_STRATEGIES.includes(raw)) {
    console.warn(`⚠️ Unknown ROUTER_STRATEGY "${raw}", falling back to "${DEFAULT_STRATEGY}". Valid values: ${VALID_STRATEGIES.join(', ')}`);
    return DEFAULT_STRATEGY;
  }
  return raw;
}

function byCostAscending(a, b) {
  return a.estimatedCostUsd - b.estimatedCostUsd;
}

function byLatencyThenCost(a, b) {
  const aLatency = typeof a.avgLatencyMs === 'number' ? a.avgLatencyMs : Infinity;
  const bLatency = typeof b.avgLatencyMs === 'number' ? b.avgLatencyMs : Infinity;
  if (aLatency !== bLatency) return aLatency - bLatency;
  return byCostAscending(a, b); // tiebreak: equal latency (often both unknown) falls back to cost
}

/**
 * Applies the `latency-guarded-cost` guard: drops any candidate whose
 * avgLatencyMs is more than LATENCY_GUARD_MULTIPLIER times the fastest
 * KNOWN healthy candidate's latency. If there's no latency data to
 * compare at all (a fresh deployment with no history yet), the guard
 * has nothing to guard against and every candidate passes through
 * unchanged - this strategy degrades to plain cost-only until real
 * latency data exists.
 */
function applyLatencyGuard(pool) {
  const knownLatencies = pool
    .map((c) => c.avgLatencyMs)
    .filter((v) => typeof v === 'number');
  if (knownLatencies.length === 0) return pool;

  const fastest = Math.min(...knownLatencies);
  const guarded = pool.filter(
    (c) => typeof c.avgLatencyMs !== 'number' || c.avgLatencyMs <= fastest * LATENCY_GUARD_MULTIPLIER
  );
  // The guard is a filter, not a veto - never let it eliminate every
  // candidate (a tier with one badly-behaved provider should still
  // route somewhere rather than error out).
  return guarded.length > 0 ? guarded : pool;
}

function isVirtualModel(model) {
  return typeof model === 'string' && model.startsWith('router:');
}

function estimatorFor(provider) {
  if (provider === 'anthropic') return anthropicProvider.estimateCost;
  if (provider === 'openai') return openaiProvider.estimateCost;
  return null;
}

// A fixed token assumption used ONLY to compare candidates against each
// other on a like-for-like basis (same assumed size for every
// candidate) - it is not a prediction of this request's real size.
const COMPARISON_INPUT_TOKENS = 1000;
const COMPARISON_OUTPUT_TOKENS = 500;

// A provider whose recent error rate is at or above this is treated as
// unhealthy and skipped unless every candidate in the tier is unhealthy
// (in which case we still have to pick one - see pickCandidate).
const UNHEALTHY_ERROR_RATE = 0.5;

// Minimum number of recent requests before a provider's error rate is
// treated as meaningful. Without this, a brand-new provider (or one whose
// traffic just resumed) with a SINGLE request that happened to error has
// errorRate 1.0 and flips unhealthy instantly; 1/1 or 1/2 errors is noise,
// not a signal. Below this sample size a provider is always considered
// healthy (insufficient data to judge) so one unlucky request can't bounce
// it out of rotation.
const MIN_HEALTH_SAMPLES = Number(process.env.ROUTER_HEALTH_MIN_SAMPLES) || 5;

/**
 * Choose a {provider, model} pair for a virtual model name. Always
 * excludes unhealthy candidates first (recent error rate too high,
 * unless every candidate is unhealthy - see below); the strategy (env
 * ROUTER_STRATEGY, default "cost") decides how what's left gets ranked.
 * See the strategy comment above loadStrategy() for what each one
 * actually does.
 *
 * `scope` (seams work): passed straight through to metrics.providerStats
 * - null/undefined (every call site in this codebase today) means the
 * platform-wide rolling health this always used, byte-identical to
 * before this parameter existed. A caller that passes a real scope gets
 * that scope's OWN rolling health instead - deliberately left as a
 * choice for whoever configures auth (see server.js's `configure()`),
 * not decided here: per-scope health isolates one tenant's provider
 * trouble from every other tenant's routing, platform-wide health
 * reacts faster (more samples) but lets one tenant's bad luck degrade
 * everyone's routing. This function doesn't take a side.
 */
async function pickCandidate(virtualModel, scope) {
  const tiers = loadTiers();
  const candidates = tiers[virtualModel];
  if (!candidates || candidates.length === 0) {
    return { error: `Unknown routing tier: ${virtualModel}` };
  }

  // The metrics store being unreachable must not take routing down with
  // it: health/latency data is an INPUT to the ranking below, not a
  // prerequisite for it. Degrade to the exact state a brand-new
  // deployment with zero history already routes in (every candidate
  // healthy, latency unknown, cost-only ordering) rather than failing
  // the request - a gateway's job during a dependency blip is to keep
  // serving, and the per-candidate failover at dispatch time still
  // catches a provider that's genuinely broken. Without this, a
  // Postgres-backed metrics outage turned every router:* request into an
  // unhandled rejection that crashed the process outright (Express 4
  // never sees async rejections).
  let stats = {};
  try {
    stats = await metrics.providerStats(scope);
  } catch (err) {
    console.warn('⚠️ providerStats unavailable - routing on cost only:', err.message);
  }

  const scored = candidates.map((candidate) => {
    const estimate = estimatorFor(candidate.provider);
    const estimatedCostUsd = estimate
      ? estimate(candidate.model, COMPARISON_INPUT_TOKENS, COMPARISON_OUTPUT_TOKENS)
      : Infinity;
    const providerStat = stats[candidate.provider] || { errorRate: 0, avgLatencyMs: null, sampleSize: 0 };
    return {
      ...candidate,
      estimatedCostUsd,
      errorRate: providerStat.errorRate,
      avgLatencyMs: providerStat.avgLatencyMs,
      healthy: providerStat.sampleSize < MIN_HEALTH_SAMPLES || providerStat.errorRate < UNHEALTHY_ERROR_RATE
    };
  });

  const healthy = scored.filter((c) => c.healthy);
  const pool = healthy.length > 0 ? healthy : scored; // all unhealthy: pick the least-bad rather than fail outright

  const strategy = loadStrategy();
  let ranked;
  let guardApplied = false;
  if (strategy === 'latency') {
    ranked = [...pool].sort(byLatencyThenCost);
  } else if (strategy === 'latency-guarded-cost') {
    const guarded = applyLatencyGuard(pool);
    guardApplied = guarded.length < pool.length;
    ranked = [...guarded].sort(byCostAscending);
  } else {
    ranked = [...pool].sort(byCostAscending);
  }

  const chosen = ranked[0];
  return {
    provider: chosen.provider,
    model: chosen.model,
    // Same order `chosen` was drawn from, stripped down to just
    // {provider, model} - lets a caller (server.js's failover loop)
    // retry the next-best candidate if the top choice's live call
    // fails, without re-running this scoring/health/strategy pass a
    // second time. Always has at least one entry when `chosen` does.
    rankedCandidates: ranked.map((c) => ({ provider: c.provider, model: c.model })),
    reason: {
      consideredTier: virtualModel,
      strategy,
      candidates: scored,
      allUnhealthy: healthy.length === 0,
      latencyGuardExcludedACandidate: guardApplied
    }
  };
}

module.exports = { isVirtualModel, pickCandidate, loadTiers, loadStrategy };
