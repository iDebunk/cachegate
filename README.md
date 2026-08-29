# cachegate

<!-- "OWNER" below is a placeholder - fill in the real GitHub org/username
     at step 15, same placeholder used in .github/ISSUE_TEMPLATE/config.yml -->
[![Tests](https://github.com/OWNER/cachegate/actions/workflows/test.yml/badge.svg)](https://github.com/OWNER/cachegate/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A self-hostable, OpenAI-compatible proxy that routes LLM requests to the
cheapest currently-healthy provider, caches responses both exactly and
semantically, and tracks cost and latency per call.

## Why this instead of LiteLLM / Portkey / OpenRouter?

Those are all excellent, and this doesn't try to out-feature them (140+
providers, a huge ecosystem, hosted enterprise plans). The niche this
fills instead:

- **Self-hosted first** — your prompts and provider keys never leave
  your own infrastructure. No account, no telemetry, no hosted
  dependency to go down.
- **Semantic cache included**, not just exact-match — most lightweight
  self-hosted options only hash-match identical requests. (LiteLLM does
  now ship a more sophisticated vector-indexed semantic cache than this
  project's brute-force cosine scan — stated plainly, not glossed over;
  see "Two kinds of cache hit" below for what this one actually does.)
- **Node.js/TypeScript-native** — most comparable gateways are Python;
  this fits directly into a JS/TS stack with no cross-language bridge.
- **Small and embeddable** — a handful of files, no framework beyond
  Express, easy to read end to end and drop into an existing app's own
  backend rather than standing up a separate service.
- **Honest numbers.** Caching alone typically saves 20-45% on LLM spend;
  add routing and well-tuned traffic can reach 47-90%. Not the inflated
  86-95% figures some vendors quote — real ranges, from real benchmarks.

## What this is NOT

- **Not a hosted service.** There's no cloud offering, no login, no
  billing, no multi-tenant key custody here — this is the engine you
  run yourself. If you want that instead, that's a separate, closed
  product built on top of this same engine — not a fork of this one,
  and not something this repository will ever grow into. This project
  intentionally doesn't ship the pieces (billing, multi-tenant key
  custody, a login system) that a competing hosted offering would need,
  and isn't looking for PRs that add them (see `CONTRIBUTING.md`'s
  scope note) — not because the license forbids it (MIT permits
  exactly that — see `LICENSE`), but because it's not what this project
  is for.
- **Not a 140-provider gateway.** Anthropic and OpenAI today (see
  "Features" below for the honest current gap against a wider pitch).
- **Not a vector-indexed semantic cache** (yet) — see "Two kinds of
  cache hit" for the real, disclosed scale limit.

The last two are real gaps worth a PR. The first is a boundary, not a
gap — see `CONTRIBUTING.md` before opening one for it.

## Run it

**Zero-clone** (once published to npm — see `OPEN_SOURCE_ROADMAP.md` step 17):
```bash
npx cachegate
```
Reads config from `.env` in the current directory, same as every other
option below — there's no separate config path for this one.

**Standalone** (this repo on its own):
```bash
git clone <this-repo-url>
cd <repo-directory>
npm install
```

**Embedded** (copied into an existing app's own backend, alongside its
other services): copy this directory into your project, then run the
same commands from inside it.

```bash
npm install
```

**Docker:**
```bash
docker build -t cachegate .
docker run -p 4000:4000 --env-file .env cachegate
```
The image runs as a non-root user, and its `HEALTHCHECK` calls the same
`GET /health` endpoint documented below — `docker ps` shows `healthy`/
`unhealthy` once the container's been up for a few seconds. **Redis is
not bundled in the image** — point `REDIS_URL` in your `.env` at an
existing Redis instance (a sibling container on the same Docker
network, or a managed one); without it the exact-match and semantic
caches are disabled cleanly (see "Features" below), not a startup
failure.

Create or edit your local `.env` file (do **not** overwrite an existing one):

```text
PORT=4000
MODEL_ROUTER_INTERNAL_KEY=your-random-internal-key
ANTHROPIC_API_KEY=your-real-key-here
# Optional:
# OPENAI_API_KEY=your-openai-key-here
# REDIS_URL=redis://localhost:6379
```

See `.env.example` for the full list of options (semantic cache
tuning, routing strategy, metrics storage, rate limits) — the model
itself is named per-request in the API call, not configured here.

`MODEL_ROUTER_INTERNAL_KEY` is required - the server refuses to start
without it, on purpose (see "Auth" below). For a throwaway local
instance only, you can skip it and set `ALLOW_INSECURE_LOCAL_DEV=true`
instead.

```bash
npm start
```

`.env` is gitignored. `.env.example` is only a reference template.

## Usage

Direct dispatch - name a specific provider's model, same as calling that
provider yourself:

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-random-internal-key" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

Routed dispatch - name a capability tier instead, and the router picks
the cheapest currently-healthy provider for it:

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-random-internal-key" \
  -d '{
    "model": "router:fast-cheap",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

`GET /health` lists the configured tiers and the active routing
strategy. Tiers are defined in `router.js` (`DEFAULT_TIERS`) and can be
overridden per deployment via the `ROUTER_TIERS_JSON` env var; the
strategy is `ROUTER_STRATEGY` (`cost` / `latency` / `latency-guarded-cost`,
default `cost`) - see "Where this leaves things" below for what each
one actually does.

Streamed dispatch - add `"stream": true` to either form above and get
back SSE chunks instead of one JSON body (see "Streaming" below for
scope):

```bash
curl -N http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-random-internal-key" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

## Auth

Every `/v1/*` and `/stats` request needs `Authorization: Bearer
<MODEL_ROUTER_INTERNAL_KEY>`. If the key isn't set, the server refuses
to start at all rather than falling open - an earlier version treated a
missing key as "no auth enforced," which is exactly the kind of thing
that turns into an unauthenticated proxy sitting in front of real
provider API keys the moment someone forgets to set it. Set
`ALLOW_INSECURE_LOCAL_DEV=true` to explicitly opt into running with no
auth, for local development only.

## Features

- OpenAI-compatible `/v1/chat/completions` endpoint - direct dispatch to
  a named provider model, or routed dispatch via a `router:` capability
  tier (cheapest currently-healthy candidate, by estimated cost; see
  `router.js`).
- **`stream: true` works** for plain text content, on both providers,
  including replaying a cache hit (exact or semantic) as a stream so a
  streaming caller still gets the caching benefit. See "Streaming"
  below for the real scope boundary (tool-call streaming isn't
  included) and the cost-tracking detail it depends on.
- Anthropic and OpenAI providers. (Not yet: Gemini, Groq, local models -
  a real gap against the two-provider skeleton's original pitch.)
- Redis-backed exact-match response cache by content hash - the first,
  free, zero-risk check on every request.
- A semantic cache on top of it, for near-duplicate prompts the exact
  hash can't catch (a paraphrase, reordered context). Requires
  `OPENAI_API_KEY` (the only embedding backend right now, regardless of
  which provider actually answers the chat request) and Redis; disabled
  cleanly if either is missing. Tool-calling requests are never
  semantically cached (see `semanticCache.js`). `GET /health` reports
  `semantic_cache_enabled`; `GET /stats` reports exact and semantic hit
  rates **separately**, not blended - see "Two kinds of cache hit"
  below for why that distinction matters.
- Per-request cost and latency tracking, persisted to a local JSONL log
  (`metrics.js`) so routing decisions and `GET /stats` have real
  history to work from, not just a number thrown away after each
  response.
- Rate limiting on `/v1/*` (`RATE_LIMIT_MAX` requests per
  `RATE_LIMIT_WINDOW_MS`, defaults 60/60s) - this proxy sits in front of
  paid, metered keys, so an unbounded client has no ceiling otherwise.
- `GET /health` for monitoring (public, no auth) and `GET /stats` for a
  quick record-count-windowed aggregate snapshot (auth required).
- **A cost dashboard** at `GET /dashboard` - a static page (no auth
  itself; its own JS asks for the internal key and stores it in
  localStorage, then calls the authenticated data endpoint below) with
  KPI tiles, cost-over-time, requests-by-outcome, and cost-by-provider
  charts, a 7/14/30-day range picker, a table-view twin for every chart,
  and a toggleable 30-second auto-refresh (paused while the tab isn't
  visible). Backed by `GET /dashboard/data` (auth required), which computes
  everything from one calendar-windowed pass over the metrics log so the
  tiles, charts, and provider table can never disagree with each other.
  See "Two kinds of cache hit" below and "Cost dashboard" further down
  for the real tradeoffs and limitations.
- Automated tests (`npm test`, Node's built-in test runner) covering
  auth, request validation, routing decisions (including the unhealthy-
  provider fallback), and the metrics store. They don't call a real
  provider API - that needs live keys and real spend, out of scope for
  this suite.

## Two kinds of cache hit - why they're reported separately

An **exact** hit means this exact request (same model, same messages,
same params) was seen before - the cached response is guaranteed
correct for it. A **semantic** hit means a *different* request scored
above a similarity threshold against something cached before - the
router's best guess that they want the same answer, not proof they do.
Blending those into one "cache hit rate" number is exactly the failure
mode this project's own market research flagged in vendor marketing:
inflated headline hit-rate claims that don't hold up against real
production numbers. `GET /stats` reports `cache_hit_rate.exact`,
`.semantic`, and `.combined` as three separate numbers so nobody has to
take that on faith.

Practical tradeoff worth stating plainly: the semantic cache is not
free to run. Every request that misses the exact cache costs one
embedding call to check the semantic cache (`SEMANTIC_CACHE_THRESHOLD`,
default `0.93`, tunable) - whether or not it finds a match - plus
another embedding call to store the eventual answer. That's real cost
and latency on every miss, in exchange for a chance at skipping a much
larger completion call on a future near-duplicate. It's worth it when
near-duplicate traffic is common; it's pure overhead when it isn't. Set
`SEMANTIC_CACHE_ENABLED=false` to disable it outright while keeping the
exact-match cache and `OPENAI_API_KEY` for other things.

Storage is a plain Redis list per model, capped at
`SEMANTIC_CACHE_MAX_CANDIDATES` (default 200) - a lookup does a
brute-force cosine-similarity scan over that list in Node, not an
indexed vector search. No RediSearch or vector-search Redis module is
assumed (most self-hosted Redis, including Render's managed Redis,
doesn't have one). That's fine at single-instance, self-hosted volume;
it is not built to scale past that cap. See `semanticCache.js` for the
full reasoning.

## Streaming

`stream: true` forwards a real, incremental, token-by-token response
from either provider, framed as OpenAI-compatible SSE chunks
(`data: {...}\n\n`, ending `data: [DONE]\n\n`). A few things worth
knowing:

- **Scope: plain text content only.** `stream: true` combined with
  `tools` is rejected with a clear 400 rather than attempted -
  accumulating partial tool-call JSON arguments across chunks (possibly
  more than one call in flight at once) is a genuinely separate, harder
  problem. Send `stream: false` for tool-calling requests.
- **A cache hit still streams.** Both the exact-match and semantic
  caches are checked before dispatching to a provider, same as the
  non-streaming path; a hit is replayed as SSE (one delta chunk with the
  whole cached answer, since it was never generated token-by-token to
  begin with) rather than forcing a streaming caller onto the slow path
  just because it asked for `stream: true`.
- **Cost tracking on a streamed OpenAI response requires asking for
  it.** OpenAI only includes token-usage data on a stream at all when
  the request explicitly sets `stream_options: {include_usage: true}` -
  without it, a streamed response has NO usage data, which would
  silently make `cost_usd` wrong (stuck at 0) for every streamed OpenAI
  call. `providers/openai.js` sets this automatically; it's called out
  here because it's exactly the kind of easy-to-miss detail that quietly
  breaks the cost accounting this whole project exists for.
- **A client disconnect aborts the upstream call.** If the caller goes
  away mid-stream, an `AbortController` cancels the in-flight provider
  request rather than continuing to pay for tokens nobody will read.
- **A mid-stream provider error can't become an HTTP error status** -
  SSE headers are already sent by the time a provider error could occur.
  It arrives instead as an in-band `data: {"error":{"message":"..."}}`
  frame followed by `[DONE]`, which is the honest signal a streaming
  client can actually observe, rather than an unexplained connection
  close.

## Cost dashboard

`GET /dashboard` is a real, working page - not a mockup - built as
static HTML/CSS/vanilla JS with inline SVG charts, no external chart
library or build step, consistent with this project's lightweight
positioning. A few things worth knowing before relying on it:

- **The internal key lives in the browser's localStorage.** The
  dashboard page asks for `MODEL_ROUTER_INTERNAL_KEY` once and stores it
  there for convenience, the same bearer-token model every other
  authenticated endpoint here already uses - there's no separate
  per-user account system, because this is a single-operator,
  self-hosted admin tool, not a multi-tenant product. If that key leaks
  from a shared/public machine's browser storage, treat it as
  compromised and rotate it.
- **Auto-refresh polls; it doesn't push.** The "Auto-refresh" checkbox
  (on by default, preference kept in localStorage) re-fetches
  `GET /dashboard/data` every 30 seconds, paused while the tab isn't
  visible (`document.hidden`) and firing immediately when it becomes
  visible again. There's no server push/websocket here - a viewer
  watching in real time still only sees whatever changed in the last
  poll, not the instant it happened.
- **"Requests by outcome" folds errors into whichever bucket they'd
  otherwise land in**, rather than giving errors their own stacked
  segment. A 4th visual series was worse than the alternative: the error
  count for each day is still fully available, both in that chart's
  hover tooltip ("N of the misses errored") and in its table view, plus
  precisely per-provider in the "Provider health" table and the
  dedicated "Error rate" KPI tile - nothing is hidden, it's just not a
  4th color competing with the three that actually matter most.
- **`GET /stats` and `GET /dashboard/data` intentionally use different
  windows.** `/stats` windows by the last N raw log *records* (a quick
  curl-able snapshot); `/dashboard/data` windows by *calendar days* (so
  its date-range picker means what it says). They will not show
  identical numbers for "the same" range, because they're not measuring
  the same thing - see the code comments in `server.js` if that's ever
  confusing.
- The charts are original inline SVG (no canvas, no external library),
  built to the same practical bar - visible legends, hover tooltips
  reachable by pointer, a table-view twin for every chart so no value is
  color-only or hover-only, light/dark via `prefers-color-scheme`, a
  categorical palette checked for colorblind-safe separation.

## Where this leaves things (known gaps, stated plainly)

- **Tool-call streaming isn't built.** Plain text streams end-to-end;
  `stream: true` combined with `tools` is rejected with a clear error
  rather than attempted (see "Streaming" above for why). Tool-calling
  requests need `stream: false` for now.
- **Routing has three strategies, not a blended score - `ROUTER_STRATEGY`
  (default `cost`).** A weighted cost/latency formula would look more
  sophisticated but would really just be a made-up tradeoff this router
  has no basis for choosing on the deployer's behalf, so instead there
  are three simple, exactly-stated options:
  - `cost` (default, unchanged from before) - cheapest healthy candidate
    in the tier, full stop.
  - `latency` - fastest healthy candidate by recent average latency,
    full stop; cost only breaks a tie (most often when there's no
    latency history yet for either candidate).
  - `latency-guarded-cost` - cheapest healthy candidate, EXCLUDING any
    candidate whose recent average latency is more than
    `ROUTER_LATENCY_GUARD_MULTIPLIER` (default 3x) slower than the
    fastest known healthy candidate. A candidate with no latency history
    yet is never excluded by the guard. This is the one genuinely
    "latency-aware" option that still keeps cost as the primary signal -
    a guard rail against picking something dramatically slower to save a
    fraction of a cent, not a full re-ranking. With no latency data at
    all yet, it degrades to plain `cost`.

  `GET /health` reports the active strategy (`routing_strategy`); a
  decision's `reason.strategy` and `reason.latencyGuardExcludedACandidate`
  say which one ran and whether the guard actually did anything, same
  transparency style as the rest of the routing decision. Tier
  membership is still the deployer's quality-floor decision (see
  `router:frontier` below) - strategy only decides ranking *within*
  whatever tier was requested. If a deployment needs one specific model
  regardless of price or speed, name that model directly instead of a
  `router:` tier.
- The `router:best` → `router:frontier` rename (still relevant context):
  a tier named "best" implied quality-aware selection that the code
  never actually did, so it silently picked whichever candidate was
  cheaper. The deployer decides which models belong in a tier (that's
  the quality floor); the router's job is ranking within it, by
  whichever strategy above is configured.
- **Metrics storage is JSONL by default, Postgres if you set `DATABASE_URL`.**
  Unset, it's local, rotated-by-UTC-day JSONL files
  (`metrics-YYYY-MM-DD.jsonl`) - fine for a standalone deployment with
  no database of its own, but ephemeral on most hosts (a restart/
  redeploy wipes a container's own filesystem). Set `DATABASE_URL` to a
  real Postgres connection string and every metrics function
  transparently reads/writes there instead - MemoCode's own embedded
  deployment points this at its already-provisioned `memocode-db`
  rather than standing up a separate database just for cost history.
  Same public API either way (`record`/`readRecent`/`providerStats`/
  `rangeSummary`/`pruneOlderThan`); nothing outside `metrics.js` needs
  to know or care which backend is actually running. Retention is the
  same story regardless of backend: nothing is deleted automatically by
  default reasoning, but `pruneOlderThan(days)` is now actually wired up
  (a scheduled job in `server.js`, `METRICS_RETENTION_DAYS`, default 90
  - matching `/dashboard/data`'s own longest supported range) rather than
  existing but never being called.
- **The semantic cache needs OPENAI_API_KEY regardless of which
  provider actually serves the chat request** - it's the only embedding
  backend implemented. An Anthropic-only deployment gets exact-match
  caching but not semantic caching unless it also configures an OpenAI
  key purely for embeddings.
- **The dashboard's internal-key gate is convenience, not a real auth
  system** - see "Cost dashboard" above. Fine for a single self-hosted
  operator; not a substitute for real per-user accounts if this ever
  needs multiple people with different access levels. If you're
  embedding this inside an app that already has its own login, the
  clean pattern is to add a thin authenticated route on YOUR OWN backend
  that relays `GET /dashboard/data` to your signed-in users, gated by
  your own auth - so the router's shared secret never has to reach a
  browser at all. This page's own `GET /dashboard` is unchanged and
  still works standalone either way (useful for checking the router's
  health independent of anything wrapping it).
- **Auto-refresh polls on a fixed interval (30s), not push-based.** The
  dashboard re-fetches `GET /dashboard/data` on a timer (visible in the
  "Auto-refresh" toggle and the "Updated Xs ago" text next to it),
  paused while the tab isn't visible and re-fetching immediately when it
  becomes visible again - there's no server-push/websocket, so a genuine
  real-time view isn't what this is. 30 seconds was picked as a
  reasonable balance for a cost dashboard, not tuned against any
  particular deployment's request volume.
