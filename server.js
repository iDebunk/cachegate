#!/usr/bin/env node
// model-router/server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const cache = require('./cache');
const semanticCache = require('./semanticCache');
const metrics = require('./metrics');
const router = require('./router');
const streaming = require('./streaming');
const anthropicProvider = require('./providers/anthropic');
const openaiProvider = require('./providers/openai');
const failover = require('./failover');

const app = express();
// No X-Powered-By: Express - free, standard hardening (avoids handing a
// public-facing service's framework fingerprint to every caller for no
// benefit).
app.disable('x-powered-by');

const PORT = process.env.PORT || 4000;
const INTERNAL_KEY = process.env.MODEL_ROUTER_INTERNAL_KEY;
const ALLOW_INSECURE_LOCAL_DEV = process.env.ALLOW_INSECURE_LOCAL_DEV === 'true';

// Fail closed, not open. A missing key used to mean "no auth enforced" -
// the .env.example calls the key "Required" but the code silently let
// requests through anyway, which is exactly the kind of thing that
// turns into an unauthenticated proxy sitting in front of real API keys
// the moment someone forgets to set it in a real deployment. This is
// checked right before the server actually starts listening (bottom of
// this file) rather than at module-load time, so requiring this file
// in-process (tests) doesn't need to satisfy it. Pure logic (no
// process.exit) so it's directly testable.
function isAuthConfigured() {
  return Boolean(INTERNAL_KEY) || ALLOW_INSECURE_LOCAL_DEV;
}

// Internal authentication: every request must carry the shared internal key.
// Health check is intentionally public so load balancers can monitor the service.
function requireInternalKey(req, res, next) {
  if (!INTERNAL_KEY) {
    // Only reachable when ALLOW_INSECURE_LOCAL_DEV=true was explicitly set above.
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const providedKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (providedKey !== INTERNAL_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Rate limiting: this proxy sits in front of paid, metered API keys -
// an unbounded client (a bug, a misbehaving script, abuse of a leaked
// internal key) has no ceiling today. Defaults are deliberately
// generous for real usage and overridable per deployment.
//
// The embedded deployment (this app's own MemoCode instance) has
// exactly ONE caller identity - memocode-backend, one service, one
// outbound IP - which means express-rate-limit's default per-IP
// keying doesn't separate individual end users at all: this ceiling is
// shared across EVERY MemoCode user's combined traffic, not per person.
// 60/60s (the original default) turned out to be uncomfortably close
// to what a single legitimate action can burst on its own: PDF
// summarize dispatches one call per chapter, sequentially, up to
// MAX_SUMMARIZED_CHAPTERS (40) - one person summarizing one long
// document could already use most of that budget alone, before any
// other user's traffic. Raised to something that comfortably covers
// real concurrent+bursty usage while still bounding a truly runaway
// loop (a retry bug, a leaked key) well before it could rack up
// meaningful real spend. NOT a fix for per-user fairness (a single
// abusive/looping caller could still crowd out everyone else within
// this shared ceiling) - that would need the router to key on a
// forwarded per-user identifier instead of the caller's IP, a real
// multi-tenancy step the router's own docs already flag as future
// scope (see ROADMAP.md's embedded/standalone split), not something
// this single-app deployment needs yet. Note for a STANDALONE
// self-hoster (as opposed to MemoCode's own single-caller embedded
// deployment the paragraph above describes): if your own callers each
// have distinct outbound IPs, this same per-IP default DOES separate
// them from each other - the "shared ceiling" caveat above is specific
// to a deployment with exactly one caller identity, not a general
// limitation of the rate limiter itself.
const rateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  limit: Number(process.env.RATE_LIMIT_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests - rate limit exceeded' }
});

// A separate, more generous limiter for the read-only aggregate
// endpoints (/stats, /dashboard/data) - security-review finding
// (2026-08-29): these were gated by the internal key but had NO rate
// limit at all, unlike /v1. Lower stakes than /v1 (no provider spend
// on the line), but still real server work (a metrics-store read +
// aggregation) that a leaked/shared key shouldn't be able to hammer
// without bound. Default comfortably covers the dashboard's own
// 30-second auto-refresh across several simultaneous viewers.
const readEndpointLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  limit: Number(process.env.READ_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests - rate limit exceeded' }
});

// JSON body parsing scoped to /v1 only, AFTER auth and rate limiting -
// security-review finding (2026-08-29): this used to be
// app.use(express.json({limit:'50mb'})) applied GLOBALLY, before any
// auth check, on every route. That meant an ANONYMOUS caller could
// force up to 50MB of JSON parsing per request before ever being
// rejected with 401 - a real resource-exhaustion vector once this is
// exposed to the internet, not just a theoretical one. Fixed two ways
// at once: (1) scoped to /v1, the only route that ever reads a body -
// /health, /stats, /dashboard/data, /dashboard are all GET with
// nothing to parse; (2) ordered after requireInternalKey and
// rateLimiter, both cheap checks, so an unauthenticated or
// over-the-limit request is rejected before any parsing happens at
// all; (3) the limit itself dropped from 50mb to a much more realistic
// default - this router only ever handles plain text chat content (no
// image/multimodal support - see providers/*.js), so even a very long
// conversation history comfortably fits well under 2MB of raw JSON.
app.use('/v1', requireInternalKey, rateLimiter, express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

// Lazy clients, constructed only when a request actually needs them.
let anthropicClient;
let openaiClient;

function getAnthropicClient() {
  if (!anthropicClient) anthropicClient = anthropicProvider.buildClient(process.env.ANTHROPIC_API_KEY);
  return anthropicClient;
}

function getOpenAiClient() {
  if (!openaiClient) openaiClient = openaiProvider.buildClient(process.env.OPENAI_API_KEY);
  return openaiClient;
}

function isModelAnthropic(model) {
  return model && (model.startsWith('claude-'));
}

function isModelOpenAi(model) {
  return model && (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3'));
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    redis_connected: cache.isConnected(),
    semantic_cache_enabled: semanticCache.isEnabled(),
    providers: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY
    },
    routing_tiers: Object.keys(router.loadTiers()),
    routing_strategy: router.loadStrategy()
  });
});

// Raw aggregate data over the last N raw log records (a record-count
// window, not a calendar one) - a quick curl-able snapshot. The actual
// dashboard page (GET /dashboard) uses GET /dashboard/data below
// instead, which windows by calendar day so its date-range picker means
// what it says.
//
// exact vs. semantic hit rate are reported SEPARATELY, not blended into
// one number. An exact hit is a guarantee (identical request, identical
// cached response); a semantic hit is the router's best guess above a
// similarity threshold. Collapsing them into one "cache hit rate" is
// exactly the kind of thing that produces the inflated vendor numbers
// this project's own market research called out - see semanticCache.js.
app.get('/stats', requireInternalKey, readEndpointLimiter, async (req, res) => {
  // Same fix as /dashboard/data below: `Number(x) || 200` would treat
  // a legitimate ?limit=0 as falsy and silently substitute 200.
  const parsedLimit = Number(req.query.limit);
  const limit = Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 200, 2000);
  const [recent, byProvider] = await Promise.all([
    metrics.readRecent(limit),
    metrics.providerStats()
  ]);
  const totalCostUsd = recent.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const exactHits = recent.filter((r) => r.cache_hit && r.cache_type !== 'semantic').length;
  const semanticHits = recent.filter((r) => r.cache_hit && r.cache_type === 'semantic').length;
  res.json({
    sample_size: recent.length,
    cache_hit_rate: {
      exact: recent.length ? exactHits / recent.length : 0,
      semantic: recent.length ? semanticHits / recent.length : 0,
      combined: recent.length ? (exactHits + semanticHits) / recent.length : 0
    },
    total_cost_usd: totalCostUsd,
    by_provider: byProvider
  });
});

// The cost dashboard's data source - everything in one response so the
// KPI tiles, the charts, and the provider table are all computed from
// the exact same filtered rows and can never disagree with each other.
// `days` is clamped to a sane range; the dashboard page's date-range
// picker calls this with 7/14/30.
app.get('/dashboard/data', requireInternalKey, readEndpointLimiter, async (req, res) => {
  // NOT `Number(req.query.days) || 14` - that treats a legitimate
  // ?days=0 as falsy and silently swaps in the default instead of
  // clamping it to 1. Only an actually-missing/non-numeric value should
  // fall back; a real 0 should clamp, not vanish.
  const parsedDays = Number(req.query.days);
  const requestedDays = Number.isFinite(parsedDays) ? parsedDays : 14;
  const days = Math.min(Math.max(requestedDays, 1), 90);
  const [summary, providerHealth] = await Promise.all([
    metrics.rangeSummary(days),
    // Deliberately the ROLLING window (same one router.js itself uses to
    // decide routing health), not the calendar one above - "is something
    // wrong RIGHT NOW" is a different question than "how did the last N
    // days look," and answering it from stale calendar history would mean
    // an alert for a key that got fixed yesterday still shows today.
    metrics.providerStats()
  ]);
  // Only providers with an actual recent error - a healthy deployment
  // sends an empty array, and the dashboard renders nothing for it,
  // instead of a permanent "0.0%" row nobody needs to see.
  const provider_alerts = Object.entries(providerHealth)
    .filter(([, stat]) => stat.lastErrorType)
    .map(([provider, stat]) => ({
      provider,
      error_type: stat.lastErrorType,
      error_rate: stat.errorRate,
      last_error_at: stat.lastErrorAt
    }));
  res.json({ ...summary, provider_alerts });
});

// The dashboard page itself - static HTML/CSS/JS, no server-side
// templating. It's served without auth (it's just markup, no data) and
// the page's own JS asks for the internal key and calls
// GET /dashboard/data with it - same bearer-token model as every other
// authenticated endpoint here, just entered once and kept in the
// browser's localStorage for convenience. See the README's "Cost
// dashboard" section for the real tradeoff that convenience carries.
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Replays a cached entry (exact or semantic) as a synthetic SSE stream,
// so a streaming caller still gets the caching benefit instead of being
// forced onto the slow path just because it asked for stream:true. The
// whole cached answer arrives as one delta chunk - it was never
// generated token-by-token in the first place, so there's nothing to
// genuinely trickle out. (The match's similarity score, for a semantic
// hit, is already captured in the metrics.record() call the caller
// makes before reaching here - there's no slot for it in the
// OpenAI-compatible SSE frame shape, and adding one isn't worth
// deviating further from it.)
function streamCachedReplay(res, entry, cacheType) {
  streaming.startSse(res);
  const id = streaming.genId();
  res.write(streaming.roleChunk({ id, model: entry.model }));
  if (entry.content) res.write(streaming.deltaChunk({ id, model: entry.model, content: entry.content }));
  res.write(streaming.finalChunk({
    id,
    model: entry.model,
    usage: entry.usage,
    cost_usd: 0,
    provider: entry.provider,
    cached: true,
    cache_type: cacheType
  }));
  res.write(streaming.doneFrame());
  res.end();
}

// Dispatches one non-streaming chat call to a specific provider -
// the same "is the key configured" checks the explicit-model branch
// below does inline, factored out here because the virtual-model
// failover loop needs to attempt this once per candidate, potentially
// against more than one provider in the same request. Throws an error
// with `.status` set so failover.isRetryableError() can decide whether
// it's worth trying the next candidate.
async function dispatchToProvider(provider, payload) {
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw Object.assign(new Error('ANTHROPIC_API_KEY not configured'), { status: 500 });
    }
    return anthropicProvider.chat(getAnthropicClient(), payload);
  }
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OPENAI_API_KEY not configured'), { status: 500 });
  }
  return openaiProvider.chat(getOpenAiClient(), payload);
}

// The real streaming dispatch path: an actual cache miss, forwarded
// token-by-token to a provider. Scope: plain text content only - tools
// + stream:true is rejected before this is ever reached. Failover
// (below) is deliberately NOT applied here: by the time a streaming
// call could fail, SSE headers and the first frame (naming the
// ORIGINAL model) are already flushed to the client, so silently
// switching providers mid-stream would mean frames that disagree
// about which model answered - a materially harder problem than the
// non-streaming case, left as a documented gap rather than shipped
// half-working (see ROADMAP.md).
async function handleStreamingDispatch(req, res, payload, requestedModel, routingDecision) {
  let providerName;
  if (isModelAnthropic(payload.model)) {
    providerName = 'anthropic';
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  } else if (isModelOpenAi(payload.model)) {
    providerName = 'openai';
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  } else {
    return res.status(400).json({ error: `Unsupported model: ${payload.model}` });
  }

  streaming.startSse(res);
  const id = streaming.genId();
  res.write(streaming.roleChunk({ id, model: payload.model }));

  // If the client disconnects mid-stream, stop paying the provider for
  // tokens nobody will read.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let result;
  try {
    const client = providerName === 'anthropic' ? getAnthropicClient() : getOpenAiClient();
    const chatStreamFn = providerName === 'anthropic' ? anthropicProvider.chatStream : openaiProvider.chatStream;
    result = await chatStreamFn(client, payload, {
      signal: controller.signal,
      onDelta: (text) => res.write(streaming.deltaChunk({ id, model: payload.model, content: text }))
    });
  } catch (err) {
    console.error('❌ Model router streaming error:', err.message);
    // Headers are already sent by this point (SSE started above), so an
    // HTTP error status is no longer possible - an in-band error frame
    // is the honest signal a streaming client can actually observe,
    // instead of an abrupt, unexplained connection close.
    res.write(streaming.errorFrame(err.message));
    res.write(streaming.doneFrame());
    res.end();
    metrics.record({
      provider: providerName,
      model: payload.model,
      requested_model: requestedModel,
      cache_hit: false,
      error: err.message,
      error_type: metrics.classifyErrorType(err.message)
    });
    return;
  }

  await cache.set(payload, result);
  await semanticCache.store(payload, result);

  res.write(streaming.finalChunk({
    id,
    model: result.model,
    usage: result.usage,
    cost_usd: result.cost_usd,
    provider: result.provider,
    cached: false
  }));
  res.write(streaming.doneFrame());
  res.end();

  metrics.record({
    provider: result.provider,
    model: result.model,
    requested_model: requestedModel,
    cache_hit: false,
    latency_ms: result.latency_ms,
    cost_usd: result.cost_usd
  });
}

app.post('/v1/chat/completions', async (req, res) => {
  const payload = req.body;

  if (!payload || !payload.model || !Array.isArray(payload.messages)) {
    return res.status(400).json({ error: 'Missing model or messages' });
  }

  const wantsStream = !!payload.stream;

  // Tool-call streaming is a genuinely separate, harder problem -
  // accumulating partial JSON arguments across chunks, possibly for
  // more than one call in flight at once. Shipping a half-working
  // version would be worse than this clear, honest "not yet." Plain
  // text streaming (no tools) works below.
  if (wantsStream && payload.tools) {
    return res.status(400).json({
      error: 'stream:true with tools is not yet supported. Send stream:false for tool-calling requests.'
    });
  }

  const requestedModel = payload.model;
  let routingDecision = null;

  // Virtual model ("router:..."): this is the actual routing decision -
  // pick the cheapest currently-healthy real model for the requested
  // capability tier. Any other model name is dispatched exactly as
  // before, unchanged - an explicit model choice is never overridden.
  if (router.isVirtualModel(requestedModel)) {
    routingDecision = await router.pickCandidate(requestedModel);
    if (routingDecision.error) {
      return res.status(400).json({ error: routingDecision.error });
    }
    payload.model = routingDecision.model;
  }

  // 1. Try the exact-match cache first - free, zero-risk, checked
  // before anything else (keyed on the resolved concrete model, so a
  // routed request and a direct request for the same concrete model
  // share the same cache entries). A hit is served the same way
  // whether or not the caller asked for stream:true - see
  // streamCachedReplay() for the streaming case.
  const cached = await cache.get(payload);
  if (cached) {
    metrics.record({
      provider: cached.provider,
      model: cached.model,
      requested_model: requestedModel,
      cache_hit: true,
      cache_type: 'exact',
      latency_ms: 0,
      cost_usd: 0
    });
    if (wantsStream) return streamCachedReplay(res, cached, 'exact');
    return res.json({
      cached: true,
      cache_type: 'exact',
      provider: cached.provider,
      model: cached.model,
      routed_from: routingDecision ? requestedModel : undefined,
      latency_ms: 0,
      usage: cached.usage,
      cost_usd: 0,
      choices: [{
        message: {
          role: 'assistant',
          content: cached.content,
          tool_calls: cached.tool_calls
        }
      }]
    });
  }

  // 1b. Exact match missed - try the semantic cache (a near-duplicate
  // prompt, not an identical one). This costs one embedding call
  // whether or not it finds anything; see semanticCache.js for why
  // that's a deliberate tradeoff, not overhead to optimize away.
  const semanticMatch = await semanticCache.findMatch(payload);
  if (semanticMatch) {
    const hit = semanticMatch.entry;
    metrics.record({
      provider: hit.provider,
      model: hit.model,
      requested_model: requestedModel,
      cache_hit: true,
      cache_type: 'semantic',
      semantic_similarity: semanticMatch.similarity,
      latency_ms: 0,
      cost_usd: 0
    });
    if (wantsStream) return streamCachedReplay(res, hit, 'semantic');
    return res.json({
      cached: true,
      cache_type: 'semantic',
      semantic_similarity: semanticMatch.similarity,
      provider: hit.provider,
      model: hit.model,
      routed_from: routingDecision ? requestedModel : undefined,
      latency_ms: 0,
      usage: hit.usage,
      cost_usd: 0,
      choices: [{
        message: {
          role: 'assistant',
          content: hit.content,
          tool_calls: hit.tool_calls
        }
      }]
    });
  }

  // 2. Full miss - dispatch to a provider. The streaming and
  // non-streaming paths diverge here because a streaming response has
  // already started writing to `res` by the time an error could occur,
  // so the two need different error-reporting strategies (see
  // handleStreamingDispatch's error frame vs. this path's 502 JSON).
  if (wantsStream) {
    return handleStreamingDispatch(req, res, payload, requestedModel, routingDecision);
  }

  try {
    let result;
    let failedOver = false;

    if (routingDecision) {
      // Virtual model: try the ranked candidates in order (router.js's
      // own health/strategy scoring already produced this order),
      // falling over to the next one when a provider fails in a way
      // that isn't the REQUEST's own fault - see
      // failover.isRetryableError for exactly what that means. Every
      // failed attempt is recorded on the dashboard the same way a
      // non-failed-over error would be (below), so failover keeps the
      // request succeeding without hiding the underlying provider
      // problem from the Provider alerts table.
      const attempt = await failover.dispatchWithFailover(
        routingDecision.rankedCandidates,
        (candidate) => dispatchToProvider(candidate.provider, { ...payload, model: candidate.model }),
        (candidate, err) => metrics.record({
          provider: candidate.provider,
          model: candidate.model,
          requested_model: requestedModel,
          cache_hit: false,
          error: err.message,
          error_type: metrics.classifyErrorType(err.message)
        })
      );
      result = attempt.result;
      failedOver = attempt.attempts > 1;
      payload.model = result.model; // the candidate that actually served it, if failover moved past the first choice
      if (failedOver) {
        console.warn(`⚠️ Model router failover: ${routingDecision.provider}/${routingDecision.model} unavailable, served by ${attempt.candidate.provider}/${attempt.candidate.model} instead (attempt ${attempt.attempts}/${routingDecision.rankedCandidates.length})`);
      }
    } else if (isModelAnthropic(payload.model)) {
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
      }
      result = await anthropicProvider.chat(getAnthropicClient(), payload);
    } else if (isModelOpenAi(payload.model)) {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
      }
      result = await openaiProvider.chat(getOpenAiClient(), payload);
    } else {
      return res.status(400).json({ error: `Unsupported model: ${payload.model}` });
    }

    // Store in both caches - exact-match for identical future
    // requests, semantic for near-duplicate ones. Both no-op quietly if
    // their prerequisites (Redis / OPENAI_API_KEY) aren't configured.
    await cache.set(payload, result);
    await semanticCache.store(payload, result);

    metrics.record({
      provider: result.provider,
      model: result.model,
      requested_model: requestedModel,
      cache_hit: false,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd
    });

    res.json({
      cached: false,
      provider: result.provider,
      model: result.model,
      routed_from: routingDecision ? requestedModel : undefined,
      failover: failedOver ? true : undefined,
      latency_ms: result.latency_ms,
      usage: result.usage,
      cost_usd: result.cost_usd,
      choices: [{
        message: {
          role: 'assistant',
          content: result.content,
          tool_calls: result.tool_calls
        }
      }]
    });
  } catch (err) {
    console.error('❌ Model router error:', err.message);
    if (!routingDecision) {
      // Virtual-model attempts already record one metrics entry PER
      // candidate as each fails (see the onAttemptFailed callback
      // above), including whichever one was last - recording again
      // here would double-count it.
      metrics.record({
        provider: isModelAnthropic(payload.model) ? 'anthropic' : 'openai',
        model: payload.model,
        requested_model: requestedModel,
        cache_hit: false,
        error: err.message,
        error_type: metrics.classifyErrorType(err.message)
      });
    }
    res.status(502).json({ error: err.message });
  }
});

// Step 14 (ROADMAP.md): metrics.pruneOlderThan() has existed since the
// day metrics.js was written, but nothing ever actually CALLED it - the
// log/table only ever grew. Retention default (90 days) deliberately
// matches /dashboard/data's own longest supported range (its own
// `days` clamp tops out at 90) - pruning any sooner than that would
// silently make the dashboard's own "Last 90 days" option lie. Runs
// once at boot (so a long-idle deployment doesn't wait a full day for
// its first cleanup) and once a day after that - a "delete old rows"
// job has no reason to run more often than that, and deliberately
// isn't tied to request volume at all (unlike everything else in this
// file, it should happen on a calendar cadence, not a traffic-shaped
// one).
const METRICS_RETENTION_DAYS = Number(process.env.METRICS_RETENTION_DAYS) || 90;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
function runScheduledPrune() {
  metrics
    .pruneOlderThan(METRICS_RETENTION_DAYS)
    .then((deleted) => {
      if (deleted.length) {
        console.log(`🧹 Pruned ${deleted.length} metrics record(s) older than ${METRICS_RETENTION_DAYS} days`);
      }
    })
    .catch((err) => console.warn('⚠️ Scheduled metrics prune failed:', err.message));
}

// Catch-all error handler - MUST be registered last, after every route
// (Express identifies error-handling middleware by its 4-argument
// signature, and only reaches it once something upstream calls
// next(err) or throws synchronously before a route's own try/catch).
//
// Real finding, security review 2026-08-29: without this, an error
// raised before a route handler runs (confirmed case: express.json()
// rejecting an oversized body) fell through to EXPRESS'S OWN default
// error handler - which returns a raw HTML page containing the FULL
// STACK TRACE, including this server's absolute filesystem paths, to
// whoever sent the request. Verified live with an actual oversized
// POST during this review, not assumed from reading the framework's
// docs. This returns the same plain JSON error shape every other
// endpoint here already uses, and never lets a stack trace reach the
// response body.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const message = status === 413 ? 'Request body too large.' : (err.message || 'Internal server error');
  console.error('❌ Unhandled error:', err.message);
  res.status(status).json({ error: message });
});

if (require.main === module) {
  if (!isAuthConfigured()) {
    console.error(
      '❌ MODEL_ROUTER_INTERNAL_KEY is not set. Refusing to start with an ' +
      'open /v1 endpoint. Set MODEL_ROUTER_INTERNAL_KEY, or set ' +
      'ALLOW_INSECURE_LOCAL_DEV=true if you understand the risk and this ' +
      'is a throwaway local instance.'
    );
    process.exit(1);
  }
  if (!INTERNAL_KEY && ALLOW_INSECURE_LOCAL_DEV) {
    console.warn('⚠️ Running with NO internal-key auth (ALLOW_INSECURE_LOCAL_DEV=true). Never do this in production.');
  }
  app.listen(PORT, () => {
    console.log(`🚀 cachegate listening on port ${PORT}`);
    console.log(`📡 Providers: Anthropic=${!!process.env.ANTHROPIC_API_KEY}, OpenAI=${!!process.env.OPENAI_API_KEY}`);
    console.log(`💾 Redis cache: ${cache.isConnected() ? 'connected' : 'disabled'}`);
    console.log(`🗄️ Metrics storage: ${metrics.usingPostgres() ? 'Postgres' : 'local JSONL'}`);
    runScheduledPrune();
    setInterval(runScheduledPrune, PRUNE_INTERVAL_MS);
  });
}

module.exports = { app, isAuthConfigured };
