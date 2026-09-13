#!/usr/bin/env node
// model-router/server.js
const path = require('path');
const crypto = require('crypto');

// Optional --env-path <file> / --env-path=<file> override, supported
// alongside (not instead of) the default cwd-based .env lookup: pass it
// and cachegate reads .env from wherever you point it, regardless of
// where you're running the command from; omit it and behavior is
// unchanged from before this flag existed. See README "Wiring this into
// your app" for why the cwd-only default was a real friction point.
function resolveEnvPathFromArgv(argv) {
  const eqArg = argv.find((a) => a.startsWith('--env-path='));
  if (eqArg) return path.resolve(eqArg.slice('--env-path='.length));

  const flagIndex = argv.indexOf('--env-path');
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return path.resolve(argv[flagIndex + 1]);
  }

  return undefined;
}

const customEnvPath = resolveEnvPathFromArgv(process.argv);
require('dotenv').config(customEnvPath ? { path: customEnvPath } : undefined);
const express = require('express');
const rateLimit = require('express-rate-limit');
const cache = require('./cache');
const semanticCache = require('./semanticCache');
const metrics = require('./metrics');
const router = require('./router');
const streaming = require('./streaming');
const providers = require('./providers');
// Kept as aliases: the cascade/grader paths below name these two explicitly
// (OpenAI's logprobs are the only native confidence signal; Anthropic falls
// back to a grader model). Everything that generalizes goes through
// `providers` - see providers/index.js for why.
const anthropicProvider = providers.get('anthropic');
const openaiProvider = providers.get('openai');
const failover = require('./failover');
const coalescing = require('./coalescing');
const cascade = require('./cascade');
const tracing = require('./tracing');
const pii = require('./pii');
const guardrails = require('./guardrails');

// Status-coded error for config/validation failures inside the dispatch
// (the /v1 catch below reads err.status to pick the HTTP code, but ONLY
// on the explicit-model path - see that catch's own comment on why the
// virtual-model/failover path never honors it). skipMetric marks a
// pre-dispatch validation failure (missing key, unsupported model) that
// never actually reached a provider - the ORIGINAL inline
// `return res.status(...)` code never called metrics.record() for these
// either, so this restores that (a static misconfiguration isn't a live
// provider-health signal; it shouldn't pollute the Provider alerts table
// the same way a real dispatch failure does).
function httpError(status, message, { skipMetric = false } = {}) {
  const err = new Error(message);
  err.status = status;
  err.skipMetric = skipMetric;
  return err;
}

// Applies pii.redact() to every string in a messages array (text content
// and the `text` field of multimodal content parts), returning a NEW
// array. Non-string content (images, etc.) passes through untouched. Only
// called when pii.isEnabled(), so redaction is identity when the flag is
// off.
function redactMessages(messages) {
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content === 'string') {
      return { ...m, content: pii.redact(m.content).text };
    }
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((part) => {
          if (typeof part === 'string') return pii.redact(part).text;
          if (part && typeof part === 'object' && typeof part.text === 'string') {
            return { ...part, text: pii.redact(part.text).text };
          }
          return part;
        })
      };
    }
    return m;
  });
}

const app = express();
// Step 36 (observability): initialize OTel once, at module load. A no-op
// unless OTEL_ENABLED + OTEL_EXPORTER_OTLP_ENDPOINT are both set (see
// tracing.js) - so both the standalone server and a wrapping deployment
// (cachegate-cloud's cloud-server.js) get tracing without any extra call.
tracing.initTracing();
// `trust proxy`, now CONFIGURABLE and secure by default. The previous hardcoded `1` was chosen for
// Cachegate Cloud's single-hop topology (2026-09-04) and is right THERE, but it is the wrong default
// for the topology this engine's own README documents (`docker run -p 4000:4000`: no proxy at all).
// In that topology `1` trusts a client-controlled X-Forwarded-For, so any caller can present a fresh
// IP on every request and the per-IP limiter on the key-holding routes is defeated - fail-OPEN, and
// silent. `false` behind a real proxy is fail-CLOSED and loud: the limiter keys globally, one env var
// away from correct. Every other security decision in this file fails closed (no DATABASE_URL, no
// API_KEY_ENCRYPTION_SECRET, auth) and this should not be the exception.
//
// Deployment note: a proxied deployment MUST now set TRUST_PROXY explicitly - Cachegate Cloud sets
// TRUST_PROXY=1 in render.yaml and RENDER-ENV-MAP.md. Upgrade impact is a boot-time warning on Render
// (see below) plus a CHANGELOG entry, not a silent change of limiter scope.
function resolveTrustProxy(raw) {
  const value = raw == null ? '' : String(raw).trim();
  if (value === '') {
    // Only warn where a proxy demonstrably exists: Render sets RENDER/RENDER_EXTERNAL_URL. Warning on
    // every unset boot would be noise in the topology where false is the correct answer.
    if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
      console.warn(
        '⚠️  TRUST_PROXY is unset and this looks like a proxied deployment: assuming NO proxy. ' +
        'Set TRUST_PROXY=1 (single hop) or the real hop count, or per-IP rate limiting will be global.'
      );
    }
    return false;
  }
  const lower = value.toLowerCase();
  if (['false', '0', 'off', 'no'].includes(lower)) return false;
  if (lower === 'true') return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  // Express also accepts a list of addresses/CIDRs plus the keywords loopback/linklocal/uniquelocal -
  // the form a real multi-hop deployment needs - so that is passed through. A guess here is not
  // harmless: a typo that express cannot parse would fall back to trusting nothing (or everything),
  // silently changing limiter scope, which is the class of bug this whole block exists to prevent.
  const tokens = value.split(',').map((t) => t.trim()).filter(Boolean);
  const valid = tokens.length > 0 && tokens.every((t) =>
    ['loopback', 'linklocal', 'uniquelocal'].includes(t.toLowerCase()) ||
    /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(t));
  if (valid) return tokens;
  throw new Error(
    `TRUST_PROXY="${value}" is not a value express can use. Expected false/true, a hop count, or a ` +
    'comma-separated list of IPs/CIDRs (loopback, linklocal, uniquelocal are also accepted). ' +
    'Refusing to start rather than silently changing rate-limiter scope.'
  );
}

app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));
// No X-Powered-By: Express - free, standard hardening (avoids handing a
// public-facing service's framework fingerprint to every caller for no
// benefit).
app.disable('x-powered-by');

// Defense-in-depth backstop, the same treatment the MemoCode backend
// already carries (its PRs #67/#71): Express 4 does NOT route an async
// route handler's rejected promise to the error middleware at the bottom
// of this file - left unguarded, Node's default since v15 is to crash
// the whole process, taking every other in-flight request with it. The
// route-level try/catches in /stats, /dashboard/data, and /v1's routing
// decision below are the primary fix; these hooks catch anything a
// future edit misses. The two failure shapes are deliberately treated
// differently (same reasoning as the backend's own PR #71): an
// unhandledRejection is one async operation's scoped failure - log and
// keep serving everyone else; an uncaughtException leaves the process in
// an unknown, possibly corrupted state - log and exit, letting whatever
// runs this (Docker, Render, Kubernetes) restart it clean.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server exiting so the platform restarts it clean):', err);
  process.exit(1);
});

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

// Constant-time comparison of the shared internal key. A plain `!==`
// comparison short-circuits on the first differing byte, which in theory
// leaks how many leading bytes of a guessed key are correct via response
// timing. Both sides are hashed to equal length first (so
// timingSafeEqual's equal-length requirement holds regardless of the raw
// key lengths), then compared in constant time. Low practical severity for
// a single shared secret, but free to do right.
function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// --- Extension seams (roadmap: engine/cloud "wrap it, don't fork it") ---
// A deployer needing real multi-tenancy (issued-key auth instead of one
// shared internal key, per-tenant BYOK provider keys, per-tenant rate
// limiting) overrides these via configure() below instead of forking
// this file - the fork this project's own Cachegate Cloud build had to
// maintain until now, duplicating every one of these decisions across a
// full copy of server.js. Every default here is EXACTLY today's
// single-tenant, unconfigured behavior - never calling configure()
// changes nothing about how this server behaves.
const seams = {
  // (req) => Promise<{ scope, error? }> | { scope, error? }. Runs where
  // requireInternalKey used to run unconditionally: as the FIRST /v1
  // middleware, before the rate limiter even sees the request, exactly
  // like today. `scope` is an opaque value (null = today's single
  // global tenant) threaded through to every cache/metrics/router call
  // this file makes below; `{ error: { status, message } }` rejects the
  // request with that status before body parsing/dispatch ever runs.
  // Default: today's shared-internal-key check, scope always null.
  authenticate: async (req) => {
    if (!INTERNAL_KEY) return { scope: null }; // only reachable when ALLOW_INSECURE_LOCAL_DEV=true
    const authHeader = req.headers.authorization || '';
    const providedKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!providedKey || !constantTimeEqual(providedKey, INTERNAL_KEY)) {
      return { scope: null, error: { status: 401, message: 'Unauthorized' } };
    }
    return { scope: null };
  },

  // (scope, provider) => string | null | Promise<string | null>. Default:
  // today's single shared process.env key, the same for every scope. A
  // BYOK-style deployer overrides this to look the key up per-scope
  // instead - and since a real per-scope lookup is usually a database
  // read (Cachegate Cloud's is a Postgres fetch + decrypt), the resolver
  // may return a Promise; every call site below awaits it, which is a
  // no-op for a synchronous resolver, so both shapes are first-class.
  // (See the callers below: they never cache a client built from a
  // non-default resolver's key, so a decrypted per-tenant secret never
  // outlives the one request it was resolved for.)
  resolveProviderKey: (scope, provider) => {
    const key = providers.envKey(provider);
    return (key ? process.env[key] : null) || null;
  },

  // Passed straight through as express-rate-limit's own `keyGenerator`.
  // Default: undefined, so express-rate-limit's own per-IP default
  // applies - exactly today's behavior. A deployer with a real per-
  // caller identity (e.g. req.scope, once authenticate() sets one)
  // overrides this to key the limiter on that instead of shared IP.
  rateLimitKeyGenerator: undefined
};

// Overrides one or more of the seams above. Safe to call anytime before
// the first request is handled (the functions above are read fresh on
// every request, not baked into route wiring at module-load time) -
// typically once, at process startup, by whatever imports this module.
// Never called anywhere in this codebase itself, so this file's own
// behavior is unaffected unless a caller opts in.
function configure(overrides = {}) {
  Object.assign(seams, overrides);
}

async function requireInternalKey(req, res, next) {
  try {
    const { scope, error } = await seams.authenticate(req);
    if (error) return res.status(error.status).json({ error: error.message });
    req.scope = scope;
    next();
  } catch (err) {
    console.error('❌ Auth error:', err.message);
    res.status(500).json({ error: 'Authentication failed.' });
  }
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
// keyGenerator reads `seams.rateLimitKeyGenerator` fresh on every
// request (a closure, not a value captured once here) - so a
// configure() call after this file loads (the normal case: a wrapping
// deployment configures before its first request, right after
// requiring this module) still takes effect. Falls back to
// express-rate-limit's own recommended IPv6-safe IP keying
// (ipKeyGenerator) when never configured - not a bare `req.ip`, which
// the library itself warns can let IPv6 users bypass limits (same
// default it would have used had this option been omitted entirely).
const rateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  limit: Number(process.env.RATE_LIMIT_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (seams.rateLimitKeyGenerator ? seams.rateLimitKeyGenerator(req, res) : rateLimit.ipKeyGenerator(req.ip)),
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

// JSON body parsing scoped to /v1 only, AFTER rate limiting and auth -
// security-review finding (2026-08-29): this used to be
// app.use(express.json({limit:'50mb'})) applied GLOBALLY, before any
// auth check, on every route. That meant an ANONYMOUS caller could
// force up to 50MB of JSON parsing per request before ever being
// rejected with 401 - a real resource-exhaustion vector once this is
// exposed to the internet, not just a theoretical one. Fixed three ways
// at once: (1) scoped to /v1, the only route that ever reads a body -
// /health, /stats, /dashboard/data, /dashboard are all GET with
// nothing to parse; (2) ordered so the RATE LIMITER runs first, then
// auth, then body parsing - rate limiting before auth means even a
// failed-auth request (a brute-force key guess, say) is counted and
// throttled, rather than being rejected by requireInternalKey before
// ever reaching the limiter (the original order let unauthenticated
// callers hammer the auth check at full speed, outside the limiter's
// reach); both are cheap checks, so an over-the-limit OR unauthenticated
// request is rejected before any parsing happens at all; (3) the limit
// itself dropped from 50mb to a much more realistic default - this
// router only ever handles plain text chat content (no image/multimodal
// support - see providers/*.js), so even a very long conversation
// history comfortably fits well under 2MB of raw JSON.
app.use('/v1', rateLimiter, requireInternalKey, express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

// Lazy clients, constructed only when a request actually needs them -
// but ONLY cached for the default global scope (null): that's the only
// case where `seams.resolveProviderKey` is guaranteed to return the
// same key on every call (today's single process.env key). Once a
// deployer configures a real per-scope resolver (BYOK, decrypted per
// tenant), every call below builds a fresh client instead of caching
// one - a decrypted secret must never outlive the one request it was
// resolved for.
// One cached client per provider for the default (unscoped) resolver. A
// scoped resolver may return a per-tenant decrypted secret, so those clients
// are deliberately NOT cached - a decrypted key must never outlive the request
// it was resolved for.
const defaultClients = new Map();

async function getProviderClient(scope, provider) {
  const mod = providers.get(provider);
  if (!mod) throw Object.assign(new Error(`unknown provider: ${provider}`), { status: 500 });
  const key = await seams.resolveProviderKey(scope, provider);
  if (scope == null) {
    if (!defaultClients.has(provider)) defaultClients.set(provider, mod.buildClient(key));
    return defaultClients.get(provider);
  }
  return mod.buildClient(key);
}

const getAnthropicClient = (scope) => getProviderClient(scope, 'anthropic');
const getOpenAiClient = (scope) => getProviderClient(scope, 'openai');

// Thin wrappers kept for the call sites that genuinely mean "this one
// provider" (cascade confidence, the grader). Everything else asks the
// registry: providerForModel() is the single answer to "who serves this?".
function providerForModel(model) {
  return providers.detectProvider(model);
}

function isModelAnthropic(model) {
  return model && (model.startsWith('claude-'));
}

function isModelOpenAi(model) {
  return model && (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3'));
}

// Public and deliberately minimal - a load balancer only ever needs "is
// this process up and can it reach its own dependencies", not internal
// configuration. redis_connected/semantic_cache_enabled are pure
// operational status (a monitoring dashboard's own "is the cache degraded
// right now" signal, not a secret); which PROVIDERS have a key configured,
// which routing TIERS/virtual models exist, and which STRATEGY picks
// between them used to live here too - internal routing configuration with
// no reason to be world-readable, unrelated to "is the process healthy".
// Anyone who legitimately needs that (an operator holding the internal
// key) gets it from GET /stats below instead.
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    redis_connected: cache.isConnected(),
    semantic_cache_enabled: semanticCache.isEnabled()
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
  try {
    // Same fix as /dashboard/data below: `Number(x) || 200` would treat
    // a legitimate ?limit=0 as falsy and silently substitute 200.
    const parsedLimit = Number(req.query.limit);
    const limit = Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 200, 2000);
    const [recent, byProvider] = await Promise.all([
      metrics.readRecent(req.scope, limit),
      metrics.providerStats(req.scope)
    ]);
    const totalCostUsd = recent.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
    const exactHits = recent.filter((r) => r.cache_hit && r.cache_type !== 'semantic').length;
    const semanticHits = recent.filter((r) => r.cache_hit && r.cache_type === 'semantic').length;
    const savedUsd = metrics.computeSavings(recent).total;
    res.json({
      sample_size: recent.length,
      cache_hit_rate: {
        exact: recent.length ? exactHits / recent.length : 0,
        semantic: recent.length ? semanticHits / recent.length : 0,
        combined: recent.length ? (exactHits + semanticHits) / recent.length : 0
      },
      total_cost_usd: totalCostUsd,
      saved_usd: savedUsd,
      by_provider: byProvider,
      // Internal routing configuration - which providers have a key
      // configured, which virtual-model tiers exist, and which strategy picks
      // between them - moved here from the public GET /health (security-
      // review finding, 2026-09-02): this endpoint already requires the
      // internal key, /health never did.
      // Review finding: this hardcoded anthropic/openai only, so adding
      // deepseek/openrouter to the registry never surfaced them here -
      // an operator checking "which providers have a key configured"
      // saw a false "no" for either. Built from providers.names() now,
      // so a future provider needs no edit here to show up.
      providers: Object.fromEntries(
        await Promise.all(
          providers.names().map(async (name) => [name, Boolean(await seams.resolveProviderKey(req.scope, name))])
        )
      ),
      routing_tiers: Object.keys(router.loadTiers()),
      routing_strategy: router.loadStrategy()
    });
  } catch (err) {
    // A metrics-store failure is OUR dependency failing - surface it as
    // an error rather than silently zeroing the numbers (a dashboard that
    // quietly shows empty data during an outage is a lie), and never let
    // it become an unhandled rejection: Express 4 doesn't route those to
    // the error middleware, and Node's default would crash the process
    // for every other in-flight request too.
    console.error('Stats read error:', err.message);
    res.status(500).json({ error: 'Failed to read metrics.' });
  }
});

// The cost dashboard's data source - everything in one response so the
// KPI tiles, the charts, and the provider table are all computed from
// the exact same filtered rows and can never disagree with each other.
// `days` is clamped to a sane range; the dashboard page's date-range
// picker calls this with 7/14/30.
app.get('/dashboard/data', requireInternalKey, readEndpointLimiter, async (req, res) => {
  try {
    // NOT `Number(req.query.days) || 14` - that treats a legitimate
    // ?days=0 as falsy and silently swaps in the default instead of
    // clamping it to 1. Only an actually-missing/non-numeric value should
    // fall back; a real 0 should clamp, not vanish.
    const parsedDays = Number(req.query.days);
    const requestedDays = Number.isFinite(parsedDays) ? parsedDays : 14;
    const days = Math.min(Math.max(requestedDays, 1), 90);
    const [summary, providerHealth] = await Promise.all([
      metrics.rangeSummary(req.scope, days),
      // Deliberately the ROLLING window (same one router.js itself uses to
      // decide routing health), not the calendar one above - "is something
      // wrong RIGHT NOW" is a different question than "how did the last N
      // days look," and answering it from stale calendar history would mean
      // an alert for a key that got fixed yesterday still shows today.
      metrics.providerStats(req.scope)
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
  } catch (err) {
    // Same shape as /stats above: a metrics-store failure is an error to
    // surface, never an unhandled rejection that crashes the process -
    // and never silently-empty data an operator would mistake for "no
    // traffic".
    console.error('Dashboard data read error:', err.message);
    res.status(500).json({ error: 'Failed to read metrics.' });
  }
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
// `options` is provider-specific dispatch hints (cascade routing, step 34).
// It reaches only providers/openai.js today (requestLogprobs); Anthropic
// ignores it. Kept backward-compatible - existing callers pass no options.
async function dispatchToProvider(scope, provider, payload, options = {}) {
  const mod = providers.get(provider);
  if (!mod) throw Object.assign(new Error(`unknown provider: ${provider}`), { status: 500 });
  if (!(await seams.resolveProviderKey(scope, provider))) {
    // Names the variable the provider actually needs - the message is built
    // from the registry, so it cannot drift from resolveProviderKey above.
    throw Object.assign(new Error(`${providers.envKey(provider)} not configured`), { status: 500 });
  }
  return mod.chat(await getProviderClient(scope, provider), payload, options);
}

// Step 34 (cascade routing): per-provider confidence estimation. OpenAI's
// path is pure (cascade.openaiLogprobConfidence over the logprobs the
// dispatch asked for). Anthropic has no native logprobs, so its confidence
// comes from a grader model - one bounded extra request to a small/cheap
// model asking "does this response fully and confidently answer the
// question? reply with a number 0-1" (Claude's recommendation over
// self-consistency, which multiplies cost 2-3x on every cheap-tier dispatch
// and works directly against cascade's own cheap-first reason to exist).
//
// The grader is opt-in (CASCADE_GRADER_MODEL): unset means Anthropic
// candidates return null confidence - fail-open, no escalation, the same
// "insufficient data must never escalate" discipline as everywhere else.
// The grader's own provider call is recorded like any other real dispatch so
// its cost is never invisible.
function buildConfidenceEstimator(scope, payload, requestedModel, traceId) {
  return async (result) => {
    if (!result) return null;
    if (result.provider === 'openai') return cascade.openaiLogprobConfidence(result);
    if (result.provider === 'anthropic') return graderConfidence(scope, payload, requestedModel, result, traceId);
    return null;
  };
}

async function graderConfidence(scope, payload, requestedModel, result, traceId) {
  const graderModel = process.env.CASCADE_GRADER_MODEL;
  if (!graderModel) return null; // no grader configured -> no signal -> fail open
  // Any chat-capable provider can grade (it is asked to reply with a number),
  // so this asks the registry rather than hardcoding two names.
  const graderProvider = providerForModel(graderModel);
  if (!graderProvider) return null;
  try {
    const grade = await dispatchToProvider(scope, graderProvider, {
      model: graderModel,
      messages: cascade.buildGraderMessages(payload.messages, result.content),
      temperature: 0,
      max_tokens: 8 // the grader only needs to emit a single 0-1 number
    });
    metrics.record(scope, {
      provider: grade.provider,
      model: grade.model,
      requested_model: requestedModel,
      cache_hit: false,
      quality_score: 1.0,
      trace_id: traceId,
      latency_ms: grade.latency_ms,
      cost_usd: grade.cost_usd
    });
    return cascade.parseGraderScore(grade.content);
  } catch (err) {
    // A grader failure (missing key, provider down) must never fail the
    // request being graded - treat it as "no confidence signal" and accept
    // the candidate's answer (fail-open).
    console.warn('⚠️ Cascade grader failed, accepting candidate without a confidence signal:', err.message);
    return null;
  }
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
async function handleStreamingDispatch(req, res, payload, requestedModel, routingDecision, traceId) {
  const scope = req.scope;
  const providerName = providerForModel(payload.model);
  if (!providerName) {
    return res.status(400).json({ error: `Unsupported model: ${payload.model}` });
  }
  if (!(await seams.resolveProviderKey(scope, providerName))) {
    return res.status(500).json({ error: `${providers.envKey(providerName)} not configured` });
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
    const client = await getProviderClient(scope, providerName);
    const chatStreamFn = providers.get(providerName).chatStream;
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
    metrics.record(scope, {
      provider: providerName,
      model: payload.model,
      requested_model: requestedModel,
      cache_hit: false,
      quality_score: 0.0,
      trace_id: traceId,
      error: err.message,
      error_type: metrics.classifyErrorType(err.message)
    });
    return;
  }

  await cache.set(scope, payload, result);
  await semanticCache.store(scope, payload, result);

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

  metrics.record(scope, {
    provider: result.provider,
    model: result.model,
    requested_model: requestedModel,
    cache_hit: false,
    quality_score: 1.0,
    trace_id: traceId,
    latency_ms: result.latency_ms,
    cost_usd: result.cost_usd
  });
}

// The one request-scoped correlation id (step 36.1): generated once per
// incoming request, returned as X-Cachegate-Trace-Id, and threaded through
// every metrics.record() this request makes - so a support conversation or a
// customer's own log line can reference the exact id that ties together every
// metrics row (cache hit, each dispatch attempt, a cascade's cheap+escalated
// pair, a coalesced joiner+leader pair) this request produced. Same generator
// family as streaming.genId() (crypto.randomBytes hex), no second scheme.
app.post('/v1/chat/completions', async (req, res) => {
  const traceId = crypto.randomBytes(16).toString('hex');
  res.setHeader('X-Cachegate-Trace-Id', traceId);
  const modelName = (req.body && req.body.model) || 'chat.completion';
  await tracing.withRootSpan(modelName, { trace_id: traceId }, () =>
    handleCompletion(req, res, traceId)
  );
});

async function handleCompletion(req, res, traceId) {
  const payload = req.body;
  const scope = req.scope; // set by requireInternalKey/seams.authenticate - null unless configured

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
    // Backstop: router.js already degrades a metrics-store failure to
    // cost-only ranking internally (see its providerStats fallback), so
    // this catch should be unreachable today - but an unguarded await
    // here was a process-crash vector under Express 4 (async rejections
    // never reach the error middleware), so guard it anyway rather than
    // trust a comment to hold against future edits.
    try {
      routingDecision = await router.pickCandidate(requestedModel, scope);
    } catch (err) {
      console.error('Routing decision error:', err.message);
      return res.status(500).json({ error: 'Routing decision failed.' });
    }
    if (routingDecision.error) {
      return res.status(400).json({ error: routingDecision.error });
    }
    payload.model = routingDecision.model;
  }

  // Step 25 (joint wiring): PII redaction + injection policy run BEFORE
  // the cache lookup, so redacted content is what gets cached (never raw
  // PII) and a blocked request never reaches a provider or a cache write.
  // Both modules are gated off by default, so this is a no-op unless the
  // deployment opts in.
  if (pii.isEnabled()) {
    payload.messages = redactMessages(payload.messages);
  }
  const policy = guardrails.evaluate(payload.messages);
  if (policy.decision === 'block') {
    return res.status(403).json({ error: 'Request blocked by content policy.' });
  }
  if (policy.decision !== 'allow') {
    // flag/log: pass through but record the detection. Console for now - a
    // dedicated metric column is a possible follow-up (same as the
    // coalesced column step 24 added).
    console.warn(`[guardrails] ${policy.decision}: ${policy.reasons.join(', ')}`);
  }

  // 1. Try the exact-match cache first - free, zero-risk, checked
  // before anything else (keyed on the resolved concrete model, so a
  // routed request and a direct request for the same concrete model
  // share the same cache entries). A hit is served the same way
  // whether or not the caller asked for stream:true - see
  // streamCachedReplay() for the streaming case.
  const cached = await tracing.withSpan('cache.exact', { trace_id: traceId }, () => cache.get(scope, payload));

  // R4 (review 2026-09-10): the measurement that decides whether URL/email literal slotting earns its
  // keep. One line per request carrying (a) whether the exact cache hit and (b) which slotting rules
  // fired, so a week of logs splits hit rate by slotting instead of arguing about it. slottingFlags
  // also reports the GATED rules (date, number), which is what makes the number/date decision priceable
  // without turning it on - that gate stays off.
  //
  // Only this path: slotting lives in the exact-cache key. The semantic path embeds the raw prompt, so
  // slotting does not touch it and a line there would measure nothing.
  //
  // Honest limit, stated here rather than discovered later: this is the hit rate AMONG requests that
  // slot, not the rate they would have had WITHOUT slotting. The true counterfactual needs a second
  // lookup per request, which is a behaviour change - and this measurement is not allowed to change the
  // thing it measures.
  if (process.env.CACHE_SLOT_STATS !== '0') {
    const sf = cache.slottingFlags(payload.messages);
    console.log(`[cacheslot] hit=${cached ? 1 : 0} model=${payload.model} url=${sf.url} email=${sf.email} date=${sf.date} number=${sf.number} numbers_gate=${sf.numbers_gate}`);
  }

  if (cached) {
    metrics.record(scope, {
      provider: cached.provider,
      model: cached.model,
      requested_model: requestedModel,
      cache_hit: true,
      cache_type: 'exact',
      trace_id: traceId,
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
  const semanticMatch = await tracing.withSpan('cache.semantic', { trace_id: traceId }, () => semanticCache.findMatch(scope, payload));
  if (semanticMatch) {
    const hit = semanticMatch.entry;
    metrics.record(scope, {
      provider: hit.provider,
      model: hit.model,
      requested_model: requestedModel,
      cache_hit: true,
      cache_type: 'semantic',
      semantic_similarity: semanticMatch.similarity,
      trace_id: traceId,
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
    return handleStreamingDispatch(req, res, payload, requestedModel, routingDecision, traceId);
  }

  try {
    // 2.5. Request coalescing (step 24): identical concurrent cache-miss
    // requests share ONE upstream dispatch (single-flight). Keyed on the
    // exact cache key, so only byte-identical requests coalesce. The
    // callback below is the leader's dispatch - provider call, cache
    // writes, and the leader's cache-miss metric - and a joiner awaits
    // that same promise instead of dispatching again.
    // The coalescing span carries a leader/joiner role attribute so a trace
    // visibly distinguishes the request that actually dispatched (leader)
    // from the ones that shared its upstream call (joiners). The role is only
    // known after joinOrRun settles, so the attribute is set before end().
    const coalesceSpan = tracing.startSpan('coalescing', { trace_id: traceId });
    let joined;
    try {
      joined = await coalescing.joinOrRun(
        cache.buildCacheKey(scope, payload),
        async () => {
        let result;
        let failedOver = false;
        let cascaded = false;

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
          //
          // Step 34 (cascade routing): when CASCADE_ENABLED, the same walk
          // ALSO escalates on a successful-but-low-confidence response -
          // orthogonal to failover (which retries on ERROR). The default
          // (cascade off) stays on failover.dispatchWithFailover, byte-
          // identical to before cascade existed.
          const onAttemptFailed = (candidate, err) => metrics.record(scope, {
            provider: candidate.provider,
            model: candidate.model,
            requested_model: requestedModel,
            cache_hit: false,
            quality_score: 0.0,
            trace_id: traceId,
            error: err.message,
            error_type: metrics.classifyErrorType(err.message)
          });

          // Each provider dispatch attempt - a failover retry or a cascade
          // escalation - is its own child span, not folded into one, so a
          // trace visibly shows "escalate to a bigger model" as a distinct
          // step, not just `cascaded: true` after the fact.
          const dispatchAttempt = (candidate) => tracing.withSpan(
            'dispatch',
            { provider: candidate.provider, model: candidate.model, trace_id: traceId },
            () => dispatchToProvider(
              scope,
              candidate.provider,
              { ...payload, model: candidate.model },
              { requestLogprobs: cascade.isEnabled() && candidate.provider === 'openai' }
            )
          );

          let attempt;
          if (cascade.isEnabled()) {
            attempt = await cascade.tryWithCascade(
              routingDecision.rankedCandidates,
              dispatchAttempt,
              buildConfidenceEstimator(scope, payload, requestedModel, traceId),
              {
                threshold: cascade.threshold(),
                onAttemptFailed,
                onEscalated: (fromCandidate, toCandidate, cheapResult) => {
                  // The cheap answer is rejected (that's cascade's point),
                  // but its dispatch was a real provider call with real cost
                  // - record it so the spend is never invisible. It is NOT
                  // marked `cascaded`: that flag belongs to the dispatch we
                  // escalated TO (the final record below).
                  //
                  // quality_score is ALWAYS 0.5 here, never 1.0 - caught in
                  // review: the original version scored it 1.0 whenever no
                  // earlier candidate had failed over, meaning a candidate
                  // whose answer was just rejected for low confidence still
                  // got a PERFECT quality score. That directly corrupts the
                  // exact signal Step 33's shed logic depends on: a provider
                  // that's frequently escalated past due to low confidence
                  // would show a misleadingly perfect avgQualityScore instead
                  // of the "this one needs a second look" signal it should.
                  // A low-confidence rejection alone already disqualifies a
                  // perfect score, regardless of whether failover ALSO
                  // happened earlier in the same walk.
                  metrics.record(scope, {
                    provider: cheapResult.provider,
                    model: cheapResult.model,
                    requested_model: requestedModel,
                    cache_hit: false,
                    quality_score: 0.5,
                    trace_id: traceId,
                    latency_ms: cheapResult.latency_ms,
                    cost_usd: cheapResult.cost_usd
                  });
                  console.warn(`⚠️ Model router cascade: ${fromCandidate.provider}/${fromCandidate.model} answered with low confidence, escalating to ${toCandidate.provider}/${toCandidate.model}`);
                }
              }
            );
            cascaded = attempt.cascaded;
          } else {
            attempt = await failover.dispatchWithFailover(
              routingDecision.rankedCandidates,
              dispatchAttempt,
              onAttemptFailed
            );
          }
          result = attempt.result;
          failedOver = attempt.failedOver !== undefined ? attempt.failedOver : attempt.attempts > 1;
          payload.model = result.model; // the candidate that actually served it, if failover/cascade moved past the first choice
          if (failedOver) {
            console.warn(`⚠️ Model router failover: ${routingDecision.provider}/${routingDecision.model} unavailable, served by ${attempt.candidate.provider}/${attempt.candidate.model} instead (attempt ${attempt.attempts}/${routingDecision.rankedCandidates.length})`);
          }
        } else if (providerForModel(payload.model)) {
          const directProvider = providerForModel(payload.model);
          if (!(await seams.resolveProviderKey(scope, directProvider))) {
            throw httpError(500, `${providers.envKey(directProvider)} not configured`, { skipMetric: true });
          }
          result = await providers.get(directProvider)
            .chat(await getProviderClient(scope, directProvider), payload, {
              requestLogprobs: cascade.isEnabled() && directProvider === 'openai'
            });
        } else {
          throw httpError(400, `Unsupported model: ${payload.model}`, { skipMetric: true });
        }

        // Store in both caches - exact-match for identical future
        // requests, semantic for near-duplicate ones. Both no-op quietly if
        // their prerequisites (Redis / OPENAI_API_KEY) aren't configured.
        // Cascade (step 34): only the response that PASSES confidence gets
        // cached. A rejected low-confidence answer was already escalated
        // away inside tryWithCascade, so `result` here is always the final
        // accepted response - never the cheap one we threw away.
        await cache.set(scope, payload, result);
        await semanticCache.store(scope, payload, result);

        metrics.record(scope, {
          provider: result.provider,
          model: result.model,
          requested_model: requestedModel,
          cache_hit: false,
          quality_score: failedOver ? 0.5 : 1.0,
          ...(cascaded ? { cascaded: true } : {}),
          trace_id: traceId,
          latency_ms: result.latency_ms,
          cost_usd: result.cost_usd
        });

        return { result, failedOver, cascaded };
        },
        traceId
      );
    } finally {
      if (joined) {
        coalesceSpan.setAttribute('coalescing.role', joined.coalesced ? 'joiner' : 'leader');
        if (joined.coalesced && joined.joinedTraceId) {
          coalesceSpan.setAttribute('coalescing.joined_trace_id', joined.joinedTraceId);
        }
      }
      coalesceSpan.end();
    }

    const { result: dispatchOutcome, coalesced: wasCoalesced, joinedTraceId } = joined;
    const { result, failedOver, cascaded } = dispatchOutcome;

    if (wasCoalesced) {
      // Joiner: shared the leader's upstream call - record it distinctly
      // (coalesced: true, zero NEW cost) so coalescing is measurable, not
      // just asserted. The leader's record above is the single source of
      // cost for the one upstream call that actually happened.
      //
      // quality_score is INHERITED from the leader (failedOver came back
      // on the same shared dispatchOutcome), not omitted like a cache hit
      // - a joiner isn't "no independent dispatch happened" in the same
      // sense a cache hit is; it received the exact same result as the
      // leader, over the exact same failedOver-or-not path, so its
      // quality signal is identical, not absent. Omitting it would
      // systematically under-sample avgQualityScore precisely for the
      // busiest, most-coalesced request shapes - the opposite of what a
      // signal meant to feed future routing decisions should do. `cascaded`
      // inherits for the exact same reason: a joiner received the
      // escalated result, so it must be visible as escalated too.
      metrics.record(scope, {
        provider: result.provider,
        model: result.model,
        requested_model: requestedModel,
        cache_hit: false,
        coalesced: true,
        quality_score: failedOver ? 0.5 : 1.0,
        ...(cascaded ? { cascaded: true } : {}),
        trace_id: traceId,
        ...(joinedTraceId ? { joined_trace_id: joinedTraceId } : {}),
        latency_ms: result.latency_ms,
        cost_usd: 0
      });
    }

    res.json({
      cached: false,
      coalesced: wasCoalesced ? true : undefined,
      provider: result.provider,
      model: result.model,
      routed_from: routingDecision ? requestedModel : undefined,
      failover: failedOver ? true : undefined,
      cascaded: cascaded ? true : undefined,
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
    if (!routingDecision && !err.skipMetric) {
      // Virtual-model attempts already record one metrics entry PER
      // candidate as each fails (see the onAttemptFailed callback
      // above), including whichever one was last - recording again
      // here would double-count it. skipMetric is the OTHER exclusion:
      // a pre-dispatch validation failure (missing key, unsupported
      // model - see httpError()'s own comment) never reached a
      // provider at all, so recording it here would be new behavior,
      // not a restoration - the original inline `return res.status(...)`
      // code never touched metrics for these either.
      metrics.record(scope, {
        // `|| 'openai'` keeps the pre-registry fallback for a model nothing
        // claims, so this metric row is not a behavior change.
        provider: providerForModel(payload.model) || 'openai',
        model: payload.model,
        requested_model: requestedModel,
        cache_hit: false,
        quality_score: 0.0,
        trace_id: traceId,
        error: err.message,
        error_type: metrics.classifyErrorType(err.message)
      });
    }
    // err.status is only honored on the explicit-model path (where it
    // can ONLY come from this file's own httpError() calls above - a
    // deliberate 500/400 for a config/validation failure). The virtual-
    // model/failover path always falls back to 502 regardless of
    // err.status: dispatchToProvider() sets .status=500 on ITS OWN
    // thrown errors too, but only for failover.isRetryableError()'s
    // internal retry decision - that was never meant to reach the
    // client as the final status once every candidate is exhausted
    // (see the dedicated test for this exact contract: exhausted
    // failover -> 502, always, whatever the last candidate's own
    // error looked like).
    const status = !routingDecision && err.status ? err.status : 502;
    res.status(status).json({ error: err.message });
  }
}

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
    // Review finding: this hardcoded anthropic/openai only, so the boot
    // log silently never mentioned deepseek/openrouter once they existed.
    // Built from providers.names() now, same fix as /stats above.
    console.log(`📡 Providers: ${providers.names().map((name) => `${name}=${!!process.env[providers.envKey(name)]}`).join(', ')}`);
    console.log(`💾 Redis cache: ${cache.isConnected() ? 'connected' : 'disabled'}`);
    console.log(`🗄️ Metrics storage: ${metrics.usingPostgres() ? 'Postgres' : 'local JSONL'}`);
    runScheduledPrune();
    setInterval(runScheduledPrune, PRUNE_INTERVAL_MS);
  });
}

module.exports = { app, isAuthConfigured, resolveEnvPathFromArgv, resolveTrustProxy, configure };
