# Changelog

All notable changes to `cachegate` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed — UPGRADE NOTE for proxied deployments
- **`trust proxy` is now configurable, and its default is secure rather than convenient.** It was
  hardcoded to `1`: correct for a single reverse proxy, wrong for the topology this repo's README
  documents (`docker run -p 4000:4000`, no proxy). There, `1` tells express to trust
  `X-Forwarded-For`, which is client-controlled, so a caller can present a fresh IP on every request
  and the per-IP limiter on the key-holding routes is defeated — fail-**open**, and silent. The
  default is now `false`, which behind a real proxy fails **closed** and loud: the limiter keys
  globally until it is set, one env var away from correct.
  **If you run behind a proxy, set `TRUST_PROXY=1` (single hop) or your real hop count.** An
  unparseable value now refuses to start rather than silently changing limiter scope, and a Render
  deployment gets a boot-time warning when it is unset. The Cloud deployment must set it explicitly
  in its own `render.yaml` / `RENDER-ENV-MAP.md`.

### Added
- **A slotting measurement line, so the URL/email slotting decision can be made on data instead of
  taste.** Every exact-cache lookup logs one line —
  `[cacheslot] hit=<0|1> model=<m> url=<0|1> email=<0|1> date=<0|1> number=<0|1> numbers_gate=<0|1>` —
  which over a week splits hit rate by whether slotting fired. It reports the **gated** rules too
  (`date`, `number`) while that gate stays off, so enabling it can be priced without enabling it.
  Disable with `CACHE_SLOT_STATS=0`.
  - Honest limit: this is the hit rate **among requests that slot**, not the rate they would have had
    without slotting. The true counterfactual needs a second lookup per request, which would be a
    behaviour change — and this measurement is not allowed to change the thing it measures.
  - The slotting rules are now a single shared list (`SLOTTERS` in `cache.js`) that both `normalizeText`
    and the reporting read, so the measurement cannot drift from the behaviour it measures. The existing
    key tests are the regression guard: they are unchanged and still pass.

### Fixed
- **The semantic cache could serve a plain-text answer to a `json_object` caller.** The exact cache
  keyed `response_format`; the semantic path never did. A caller that asked for JSON could receive
  cached prose, fail to parse it, and surface the failure as an upstream outage rather than a cache
  miss. Matching there is by embedding, so the shape cannot live in a key: it is now stored beside
  each entry and enforced as a hard filter. The allowed direction is asymmetric ON PURPOSE — a
  request that demands nothing about the answer's shape can still be served an entry that predates
  the gate (so the upgrade is not a cache flush), while a request that *does* demand a shape may only
  be served by an entry that proves it matches. The answer-shape fields (`tools`, `tool_choice`,
  `response_format`, `seed`) are now defined once in `cache.js` and called by both paths, because
  adding them one at a time is exactly how the two drifted apart.

## [1.4.0] - 2026-09-06

Everything below is additive and opt-in — every new feature ships
gated off by default (an env var, or a value that matches today's
behavior), so an existing deployment that changes nothing is
byte-identical in observable behavior to 1.3.1.

### Added
- **Two more providers — DeepSeek and OpenRouter** — and a provider registry
  (`providers/index.js`) underneath them. Requests are still routed purely by
  the model name: `deepseek-*` (e.g. `deepseek-flash`, `deepseek-v4-pro`) goes
  to DeepSeek, and any `vendor/model` id (e.g. `meta/llama-3-70b`,
  `deepseek/deepseek-chat`) goes to OpenRouter. Adding a provider is now one
  module plus one line in the registry: model detection, client construction,
  the "which key is missing" error and both dispatch paths (direct and
  `router:` tier) all read from it instead of hardcoding a pair.
  - **DeepSeek cost tracking is timer- and cache-aware.** DeepSeek bills input
    in two tiers (cache hit vs miss) and every rate has a peak and an off-peak
    value (off-peak is exactly half), so `cost_usd` — and therefore cost-based
    routing — follows the current billing window instead of one flat rate.
    Its `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` usage fields are
    mapped through, so a cached request shows its real (much lower) cost rather
    than being priced as if nothing was cached.
  - **OpenRouter pricing is fetched, not hardcoded.** Its catalog spans many
    vendors and changes without a release of this project, so prices come from
    OpenRouter's own `/models` endpoint and are cached in-process. When a
    model's price is unknown, `cost_usd` is `null` — deliberately **not** `0`,
    which cost-based routing would read as "free" and would win every
    comparison. Optional `HTTP-Referer`/`X-Title` attribution headers are sent
    only when `OPENROUTER_SITE_URL`/`OPENROUTER_SITE_NAME` are configured, and
    the upstream provider OpenRouter actually used is surfaced per response.
- **`saved_usd` ($ saved)**: `rangeSummary()`, `GET /stats`, and the
  dashboard now report estimated dollars saved by cache hits (average
  cost of a same-model miss × that model's hit count), alongside the
  existing hit-rate numbers.
- **Prompt canonicalization** (`cache.js`): the exact-cache key now
  normalizes whitespace/case/Unicode/structural punctuation and
  canonical field ordering before hashing, so cosmetic variants of an
  identical prompt share one cache entry. Email/URL literal slotting
  (`<var>` placeholders) is unconditional; number/date slotting is
  gated behind `CACHE_KEY_SLOT_NUMBERS` (default **off**) since it can
  make genuinely different prompts ("15% of 200" vs. "25% of 900")
  collide on an *exact* cache with no similarity threshold.
- **Local embeddings backend** (`embeddings.js`): `all-MiniLM-L6-v2`
  (384-dim) via `@huggingface/transformers`, gated behind
  `SEMANTIC_CACHE_LOCAL_EMBEDDINGS` (default **off** — OpenAI stays the
  default embeddings backend). `npm run eval:semantic-cache` runs a
  curated precision/recall harness against whichever backend is
  active, for an apples-to-apples comparison before switching.
- **Request coalescing** (`coalescing.js`): concurrent identical
  cache-miss requests now share one upstream dispatch instead of each
  triggering its own — a joiner's metrics row is marked `coalesced` and
  inherits the leader's `quality_score`, not omitted like a cache hit.
- **Guardrails** — PII redaction (`pii.js`, gated behind
  `GUARDRAILS_PII_REDACTION`): pattern-based detection/redaction of
  emails, phone numbers, SSNs, credit cards, and common API-key/secret
  shapes before a prompt ever reaches a provider or the cache. Prompt-
  injection detection + policy (`guardrails.js`, gated behind
  `GUARDRAILS_ENABLED`): heuristic detection of instruction-override,
  system-prompt-leak, and jailbreak patterns, `block`/`flag`/`log`
  policy actions (default `flag`, since heuristics can false-positive).
- **`quality_score` reward signal** (`metrics.js`): every dispatch now
  records `1.0` (clean success) / `0.5` (success after failover) /
  `0.0` (failure); cache hits correctly omit it. `providerStats()`
  gained `avgQualityScore`, null-tolerant like the existing
  `avgLatencyMs`.
- **Health-scoring "shed" tier** (`router.js`): `SHED_ERROR_RATE`
  (default 0.9) and `SHED_QUALITY_SCORE` (default 0.2) fully exclude a
  clearly-degrading candidate from a tier's pool — stricter than the
  existing 50% "unhealthy" filter, which only deprioritizes. A
  deterministic fallback to the full ranked list applies if shedding
  would leave the pool empty. Stateless — both scores come fresh from
  the existing rolling-window stats on every call, no new
  circuit-breaker store or timers.
- **Cascade routing** (`cascade.js`, gated behind `CASCADE_ENABLED`):
  for a `router:` virtual model, dispatch to the cheapest candidate
  first and escalate to the next-ranked one if its confidence is below
  `CASCADE_CONFIDENCE_THRESHOLD` (default 0.5) — orthogonal to
  `failover.js`'s error-driven retry. Confidence is per-provider:
  OpenAI via native `logprobs` (near-zero marginal cost, opted into
  only when cascade is active); Anthropic via an opt-in grader model
  (`CASCADE_GRADER_MODEL`, unset means fail-open — no Anthropic
  escalation), a bounded single extra request rather than the 2-3×
  cost multiplier self-consistency re-sampling would impose.
- **Observability + tracing** (`tracing.js`, new): a request-scoped
  `trace_id`, returned as `X-Cachegate-Trace-Id` and threaded through
  every `metrics.record()` call a request makes (cache hits, each
  dispatch attempt, a coalesced leader/joiner pair, a cascade's
  cheap-then-escalated pair), so one request's full path can be
  reconstructed from its metrics rows. OpenTelemetry export (gated
  behind `OTEL_ENABLED` + `OTEL_EXPORTER_OTLP_ENDPOINT` — unset means
  the SDK never initializes at all): a root span per request plus
  child spans for cache lookup, coalescing wait, and each dispatch
  attempt.

### Fixed
- **Security**: the local-embeddings dependency was originally wired
  through `@xenova/transformers`, which pulls a critical CVE
  (`protobufjs` < 7.5.5, CVSS 9.8, arbitrary code execution) via
  `onnxruntime-web` — shipped to every installer regardless of the
  feature flag. Swapped to `@huggingface/transformers` (same
  `pipeline()` API, patched `protobufjs`) before this ever reached a
  release.
- **Security**: the OpenTelemetry SDK's initial dependency versions
  pulled a tree of vulnerable transitive `@opentelemetry/*` packages
  (23 findings, 3 high — including a real DoS in `propagator-jaeger`'s
  header parsing) — bumped to the `^0.222.0` line before release,
  verified compatible against a real OTLP-shaped receiver.
- **`package.json`'s `"files"` array** was missing `coalescing.js`,
  `guardrails.js`, and `pii.js` (added across steps this array wasn't
  updated for) — a fresh `npm install` of this version would have
  crashed with `Cannot find module` the moment any of them was
  required. Caught and fixed before ever shipping; verified end-to-end
  by packing the real tarball and requiring it from a clean install.
- A coalesced request's own status code could leak the internal
  retry-bookkeeping code instead of the contractually-fixed 502, and a
  static config error (missing key, unsupported model) could pollute
  provider-health metrics as if it were a live failure — both
  introduced by coalescing's dispatch wiring, both fixed before this
  release with regression coverage.

## [1.3.1] - 2026-09-05

### Fixed
- **Reliability**: `app.set('trust proxy', 1)` — any deployment behind
  a reverse proxy/load balancer (nginx, Traefik, Render, Heroku, ...)
  forwards the real client IP via `X-Forwarded-For`. Express's own
  default (trust proxy unset) made `express-rate-limit` refuse that
  header outright, throwing `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` on
  every request through a rate-limited route with no custom
  `keyGenerator` (`/stats`, `/dashboard/data`). Not fatal to the
  request, but it meant per-IP rate limiting was keyed off the proxy's
  own IP for every caller instead of each real client — brute-force/
  abuse limiting was effectively shared across all callers rather than
  per-caller. Found running this in production behind a single-hop
  proxy (Cachegate Cloud, 2026-09-04).
- `metrics.record()` now returns the underlying Postgres INSERT promise
  instead of discarding it, so tests/scripts can `await` it. Request
  paths still ignore the return value, so it stays fire-and-forget for
  them — a metrics write must never be the reason a real request fails
  or slows down.

## [1.3.0] - 2026-09-03

### Added
- `metrics.pruneScopedOlderThan(scope, days)` — scope-isolated cleanup:
  deletes one scope's records older than `days` (Postgres backend),
  leaving every other tenant's history untouched. This is the primitive
  a per-tenant retention policy needs. Throws on a `null`/`undefined`
  scope (fail-closed), and is a documented no-op on the JSONL file
  backend (scopes share per-day append-only files). The global
  `pruneOlderThan(days)` is unchanged.

## [1.2.0] - 2026-09-02

### Added
- `configure({ authenticate, resolveProviderKey, rateLimitKeyGenerator })`
  — an opt-in extension point for embedding `cachegate` behind real
  multi-tenant auth, per-caller provider keys, or per-caller rate
  limiting, instead of forking `server.js` to get there. Every default
  is exactly today's single-tenant, unconfigured behavior — a
  self-hosted deployment that never calls `configure()` is unaffected.
  See `server.js`'s own `seams` object for the shape of each override.
- `GET /health` and `GET /stats` responses are unchanged for an
  unconfigured deployment, but every cache/metrics/routing function now
  accepts an optional leading `scope` argument for library consumers
  that call them directly (`cache.get`, `metrics.record`,
  `router.pickCandidate`, etc.) — `null`/omitted is byte-identical to
  before this existed.

### Fixed
- **Reliability**: `isConnected()` now checks Redis's `isReady` instead
  of `isOpen`. In node-redis v4, `isOpen` stays `true` through an
  entire automatic-reconnect loop after a live connection drops — a
  Redis outage used to leave every cache read/write queueing commands
  on a dead socket instead of failing open immediately.
- **Reliability**: a metrics-store failure (e.g. a Postgres blip on a
  Postgres-backed deployment) no longer crashes the process. Previously
  an unguarded `await` in the routing decision, `GET /stats`, and
  `GET /dashboard/data` could produce an unhandled promise rejection —
  Express 4 doesn't route those to error-handling middleware, so
  Node's default was to crash the whole process, taking every other
  in-flight request down with it. Routing now degrades to cost-only
  ranking on a metrics-store failure instead of erroring.
- **Security**: the `/v1` rate limiter now runs *before* the internal-key
  check, so an unauthenticated brute-force attempt against the key is
  counted and throttled instead of bypassing the limiter entirely.
  Internal-key comparison is constant-time.
- **Security**: `GET /health` (public, unauthenticated) no longer
  reports which providers have a key configured or which routing
  tiers/strategy are active — moved to `GET /stats`, which already
  requires the internal key.
- **Correctness**: the exact-match cache key now includes
  `response_format`, so two requests identical except for
  `response_format` no longer share a cache entry (a `json_object`
  response could previously be served to a plain-text caller).
- A provider needs a configurable minimum number of recent requests
  (`ROUTER_HEALTH_MIN_SAMPLES`, default 5) before its error rate can
  mark it unhealthy — a single unlucky request no longer bounces a
  provider out of rotation.
- Every semantic-cache embedding call now has a hard timeout
  (`EMBEDDING_TIMEOUT_MS`, default 5000ms) — a hung embedding provider
  used to stall the entire request path, not just semantic caching.

## [1.1.0] - see git history

Everything before this point is tracked in this repository's own
commit history (each sync commit names the source monorepo commit it
mirrors) rather than reconstructed here after the fact.
