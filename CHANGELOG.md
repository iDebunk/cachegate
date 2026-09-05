# Changelog

All notable changes to `cachegate` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
uses [semantic versioning](https://semver.org/).

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
