# MemoCode Model Router — Roadmap & Review

> Review of `210_apps/001_model_router/` as it stands, and the plan to take it
> from an internal MemoCode utility to a standalone self-hosted product.
> Originally written by DeepSeek, 2026-08-23, auditing the version that
> existed on `deepseek/memocode-chat-and-router` at the time. **Corrected the
> same day**: that audit's "gaps" section was accurate for the version it was
> looking at, but a second, much more complete implementation had been built
> in parallel on `claude/memocode-project-review-v0ohnx` and never merged
> anywhere shared — neither branch's author knew the other's existed. This
> file now reflects the merged, actual state. See section 0.

## 0. What happened, so it doesn't happen again

Two independent model-router implementations existed at once: this one
(minimal - proxy, exact-match cache, provider mapping) on
`deepseek/memocode-chat-and-router`, and a materially more complete one
(routing strategies, semantic cache, streaming, JSONL metrics with rotation,
a cost dashboard, hardened auth, 68 tests) built the same day on
`claude/memocode-project-review-v0ohnx` - a branch neither this file's
original audit nor DeepSeek's own semantic-cache attempt knew to check.
Discovered when the CEO asked to test the semantic cache and DeepSeek,
checking `master`/`deepseek/memocode-chat-and-router`/
`claude/session-import-feature`, correctly found it on none of them - but
hadn't checked the actual branch it lived on. Resolved by replacing this
directory's contents with the more complete version (a strict superset
except for this file) and keeping this file's own market/monetization
analysis, which stands independent of which codebase it's describing.
**The lesson, not just the fix**: a feature branch that never gets
merged toward `master` (or at least announced on the coordination board
with its branch name) is invisible to everyone not already looking at it,
no matter how complete the work on it is - completeness doesn't substitute
for discoverability.

## 1. What's actually here (audited 2026-08-23, post-merge)

**Working, tested, pushed** (`210_apps/001_model_router/`, this directory,
now matching `claude/memocode-project-review-v0ohnx`):
- `server.js` — Express, OpenAI-compatible `POST /v1/chat/completions`
  (streaming and non-streaming), internal bearer-key auth (fails CLOSED by
  default - `ALLOW_INSECURE_LOCAL_DEV=true` required to opt into running
  without a key), rate limiting, `/health`, `/stats`, `/dashboard`.
- `providers/anthropic.js` + `providers/openai.js` — request mapping,
  token/cost estimation, `chatStream()` for SSE.
- `cache.js` — Redis exact-match cache keyed by a content hash of
  `{model, messages, temperature, max_tokens, tools, tool_choice}`.
- `semanticCache.js` + `embeddings.js` — near-duplicate matching via
  embeddings + cosine similarity over a bounded per-model Redis list
  (brute-force, not RediSearch/vector-indexed - an honest, documented
  scale limit, not a hidden one). Tool-calling requests excluded. Semantic
  hits tracked separately from exact hits in metrics, never blended into
  one number.
- `router.js` — three explicit `router:` virtual-model strategies (cost /
  latency / latency-guarded-cost), no invented blended score.
- `metrics.js` — JSONL logs with day-rotation, bounded reads, opt-in
  pruning.
- `public/dashboard.html` — a real cost dashboard (KPI tiles, charts,
  auto-refresh, table-view twins), built to this project's own `dataviz`
  skill standard.
- 68 tests across 8 test files, all passing.
- Live: dogfooded by `210_apps/000_backend/chat-import-logic.mjs`
  (`localhost:4000/v1/chat/completions` for chat segmentation).

**Real remaining gaps** (honest, not "nothing left to do"; updated
2026-08-29 after re-auditing against the actual code - two of the four
gaps below turned out to already be closed):
1. Semantic cache is brute-force cosine over a capped list, not a real
   vector index - fine at self-hosted single-instance volume, not meant to
   scale past `SEMANTIC_CACHE_MAX_CANDIDATES` (default 200) per model.
2. ~~No provider failover on a 5xx/rate-limit~~ **Closed 2026-08-29.**
   `failover.js` + `server.js`'s non-streaming dispatch path now walk
   `router.js`'s full ranked-candidate list, retrying the next candidate
   when one fails for a reason that isn't the request's own fault (a
   400/404 still fails immediately - retrying elsewhere wouldn't help).
   Streaming is a deliberate exception, documented inline in
   `handleStreamingDispatch` - SSE headers and the first frame commit to
   a model name before a failure could be known, so silent mid-stream
   provider switching is a materially harder problem, left open rather
   than shipped half-working.
3. ~~No persistence layer under the dashboard~~ **Closed** (already true
   before this pass, just never updated here): `metrics.js` has stored
   metrics in Postgres since the `feat(model-router): persistent metrics
   storage via Postgres` commit, with automatic JSONL fallback when no
   database is configured.
4. Not yet open-sourced/packaged standalone (Phase 5, section 4 below).

**What this actually is today, said plainly**: working, tested internal
infrastructure with zero users outside this codebase — not an app, not a
published package, not a running public service, not something anyone has
paid for or even tried. Everything from here through section 3 (market
position, monetization tiers, MRR estimates) describes a *hypothetical*
product this code could become, not a claim about what it is right now.
Read it as a plan, not a status report - a CEO challenge on 2026-08-23
("this is not an app, it's not portable, we build nothing") is a fair
description of today's reality and is what section 4's Phase 5 (open
source release) exists to close.

## 2. Honest market position

Do **not** try to out-LiteLLM LiteLLM (140+ providers, Python, huge community)
or OpenRouter (acquired by Stripe). The winnable niche:

- **Self-hosted first** — prompts/PII never leave your infra.
- **Semantic cache**, not just exact-match (most OSS options still hash-match).
- **Node.js/TypeScript** — the JS/TS AI-app crowd is underserved.
- **Embeddable** — usable as a module inside an existing app before it's sold.

**Correction, same day, on the semantic-cache claim specifically**: verified
via WebSearch that LiteLLM shipped a real vector-indexed (Valkey-search +
HNSW) semantic cache in 2026 - more sophisticated than this router's
brute-force cosine scan. "Semantic cache, not just exact-match" is no longer
a differentiator against LiteLLM by name, even though it's still true against
"most OSS options." The honest remaining edges: small/auditable codebase,
Node-native, and already dogfooded inside a real app.

The sellable, honest claim (do not quote inflated 86–95%): **"Caching alone
typically saves 20–45%; add routing and it can reach 47–90% on well-tuned
traffic."** Being the vendor that quotes the real number is the credibility
edge with the buyer who has been burned by an inflated claim.

## 3. How this router makes money (open-core, honest)

Self-hosted OSS infrastructure monetizes by **open-core**, not by charging for
the free thing:

| Tier | What | Price | Why someone pays |
|---|---|---|---|
| **OSS core (free)** | exact-match cache, 2–3 providers, basic proxy | $0 | top-of-funnel; builds trust |
| **Pro** | semantic cache, cost-based routing + failover, cost dashboard | $49–99/mo | the "save 40–80% on LLM spend" features; charge ~10–20% of the savings |
| **Team** | multi-user, SSO, audit log, priority support | $199–499/mo | small teams running production workloads |
| **Hosted** | we run it for you (no ops) | usage-based, $99–999/mo | teams that don't want to self-host (where LiteLLM makes its money) |
| **Enterprise** | on-prem, compliance, SLAs | custom | regulated buyers |

**Honest caveats:** OSS → paid conversion is typically 1–5%; the money is in
the small fraction who want the semantic cache + dashboard and don't want to
self-host. It is a crowded market. Realistic: **$5–20K MRR in 12 months** by
owning the self-hosted Node.js niche. The metric that makes it work: a buyer
spending $1,000/mo on LLM APIs saves $400–800/mo with this — paying $50–100/mo
for the tool is an easy yes.

## 4. Phases

**Note on an older numbering (added 2026-08-29):** early journal entries
(2026-08-24) refer to this work as a flat "20-step roadmap" (steps
13-17 individually named there; 18 marked done but never described; 19
= the semantic-cache vector-index upgrade, paused; 20 = the standalone
product). That numbering was never written down as one document - it
only ever existed as scattered journal references, which made it
genuinely hard to reconstruct later (confirmed 2026-08-29: step 18's
actual content couldn't be found anywhere). **The 6 phases below
supersede that numbering entirely.** If an old "step N" reference ever
surfaces again, map it here rather than trying to revive the flat list.

### Phase 1 — make what exists real — **done**
Redis verified end-to-end, honest README, tests (68, not the "no test files"
this section originally reported), the honest cost claim above.

### Phase 2 — semantic cache — **done**
Embeddings + cosine similarity, `SEMANTIC_CACHE_THRESHOLD` default 0.93 (this
section's own original draft proposed ~0.95 - close, tuned during real
testing; see `semanticCache.js`'s own comment for the reasoning), tool-calls
excluded, tracked separately from exact-match hits.

### Phase 3 — real routing — **done**
Three explicit strategies (`router.js`) rather than a single invented
blended score - cost-ascending, latency-then-cost, and latency-guarded-cost
(excludes anything too much slower than the fastest known candidate).
Failover on error for non-streaming requests shipped 2026-08-29
(`failover.js`) - see section 1, gap 2, for what it does and doesn't cover.

### Phase 4 — cost visibility — **done**
`metrics.js` (JSONL, day-rotation, bounded reads) + `public/dashboard.html`
(KPI tiles, charts, auto-refresh, table-view twins).

### Phase 5 — open-source release — not started
Public GitHub repo → npm package → Docker image → announce (Hacker News,
r/LocalLLaMA, r/selfhosted, Dev.to). Still the real next milestone - none of
phases 1-4 being done changes that this hasn't shipped to anyone outside
this project yet. **Execution plan, added 2026-08-29:**
[`OPEN_SOURCE_ROADMAP.md`](./OPEN_SOURCE_ROADMAP.md) - the 20-step
breakdown of everything this one-liner actually requires, written down
as one document on purpose (see that file's own note on why).

### Phase 6 — hosted tier (only after OSS traction)
Render/Fly hosted; usage-based pricing.

## 5. One honest caveat on dogfooding

Chat-import's one segmentation call per session is too low-repeat to prove
the *cache* saves money — it only proves the *proxy* works. **2026-08-23
update**: `210_apps/000_backend/ai-providers.mjs`'s "Generate with AI" now
routes through this router too (app's own shared key only, never a
signed-in user's BYOK key — the router is one shared-secret proxy today,
not multi-tenant).

**Correction, same day, on how that update was first worded here**: this
section originally called that traffic "a genuinely more promising source
of real cache hits" — that was a hunch stated as a finding, and a CEO
challenge caught it (fair: "what are the odds two people ask the same
thing" is the right question, and for this app's actual traffic the honest
answer is "mostly low, and nobody has measured it"). The one real
structural fact in favor of *some* hits: `ai-providers.mjs` builds that
prompt as `"Subject: <topic>. Generate about N <label> worth of
content."` — short and templated, with `topic` the only variable — so two
different users both studying, say, "the Roman Empire" would produce an
identical or near-identical request, which chat-import's full conversation
transcripts basically never do. That's a plausible *mechanism* for a
non-zero hit rate on a study app whose users cluster around common
curriculum topics — it is not a measured hit rate, and treating it as one
would repeat the same mistake. Nobody has looked at MemoCode's actual
topic distribution. `MODEL_ROUTER_URL` is also still unset in the current
Render deploy (`render.yaml` declares no router service), so none of this
runs in production yet regardless.

To validate savings for real, you need either that traffic running through
the router in production with real measurement, or synthetic load testing
against a realistic topic distribution — not a plausible-sounding argument
for why it might work, however structurally reasonable that argument is.

## 6. Two-version architecture (decision 2026-08-23)

One engine (routing + cache + metrics), two wrappers — NOT two codebases:

| | Embedded | Standalone |
|---|---|---|
| Lives | inside MemoCode (own process) | its own hosted service (Render) |
| Keys | you bring Anthropic/OpenAI | it holds keys, issues its own key + URL |
| Login/billing | none | yes (login, payment, multi-tenancy) |
| Serves | your apps (fallback) | everybody, including your apps |
| Status | done — needs Redis + production wiring | future project (OpenRouter/LiteLLM competitor) |

Fallback: apps point at the standalone and drop back to the embedded
(localhost or MemoCode's own instance) when the standalone is down. Same job,
so the switch is invisible to the caller. Do NOT fork the router — wrap it:
same core logic, two thin deployment shells, so the two can never drift apart
the way the two parallel implementations did (section 0).

The embedded version **stays embedded in each new app** (each app inherits
this directory as-is) — it is NOT extracted to a shared repo. A shared repo
means maintaining one router copy per repo plus separate hosting/db, which
isn't worth it; a new app just copies `210_apps/001_model_router/` into its
own backend and points `MODEL_ROUTER_URL` at it. The standalone's key+URL are
left as comments in the app's `.env` as a future reminder, not wired yet.

Sequencing: finish the embedded first (cheap, real, no risk), then decide
whether to build the standalone's billing layer (the hard, deferred part).

## 7. Embedded — production checklist

1. Hosted Redis (Render Key Value) → set `REDIS_URL`.
2. Deploy this directory as its own service (or co-locate with the backend).
   The repo `render.yaml` now declares a `memocode-router` service (Node
   runtime, `npm ci` + `npm start`) and a `Dockerfile` is included for
   Docker-based deploys.
3. Set production env: `MODEL_ROUTER_INTERNAL_KEY` (strong, `openssl rand -hex 32`),
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `REDIS_URL`,
   `SEMANTIC_CACHE_ENABLED=false` (low-repeat traffic: semantic cache spends
   an embedding call on every miss for nothing), `ROUTER_STRATEGY=cost`.
4. Route MemoCode's AI call sites through it via `MODEL_ROUTER_URL`.
   **Corrected 2026-08-29**: this item previously named "image gen" and
   "transcription" as call sites to route through the router - checked
   directly, and that's not actually possible as scoped. The router is an
   OpenAI-*chat-completions*-compatible proxy only; image generation
   (`images.generate`) and Whisper transcription
   (`audio.transcriptions.create`) are different API shapes it doesn't
   speak. What's actually wired today: chat-import's segmentation call
   (`chat-import-logic.mjs`) and "Generate with AI" text generation
   (`ai-providers.mjs`'s `generateStructuredText`), both gated behind
   `MODEL_ROUTER_URL` being set (`shouldRouteToModelRouter()`). Extending
   the router to proxy image/audio calls too would be new scope, not a
   pending item on this checklist.
5. Verify `/health`, `/dashboard`, `/stats` on production with real traffic.

**Note on items 1 and 3 above (2026-08-29):** `render.yaml` declares the
env var slots for `REDIS_URL`, `MODEL_ROUTER_INTERNAL_KEY`,
`ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` (all `sync: false` - filled in
manually on Render's dashboard), and the metrics Postgres connection is
wired automatically via `fromDatabase`. Whether those manual slots are
actually populated with real values on the live Render service isn't
something a sandboxed session can check - that verification needs
whoever has the Render dashboard.
