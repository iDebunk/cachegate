# Open-Source Release Roadmap — 20 Steps

**What this is:** the concrete execution plan for `ROADMAP.md`'s Phase 5
("open-source release"). That phase has existed as a single line —
"Public GitHub repo → npm package → Docker image → announce" — since
2026-08-23; this is what actually has to happen to make each of those
four words true, broken into 20 numbered steps with the sub-work under
each, so progress is trackable the same way the embedded build itself
was.

**Scope, precisely** (see `ROADMAP.md` section 6 and the 2026-08-29
open-source-scope discussion in the Decision Journal): **only the
embedded engine gets open-sourced** — routing, caching, metrics,
providers, the dashboard. Login, payment, multi-tenancy, and anything
else that makes the **standalone** hosted product ($ Phase 6) are never
part of this repo, this package, or this Docker image. If a step below
ever seems to call for adding one of those things, that's a sign the
step has drifted out of scope, not a sign the scope needs expanding.

**Status legend:** ⬜ not started · 🟨 in progress · ✅ done · ⏸ blocked/waiting

**Lesson applied from the embedded build's own history (see
`ROADMAP.md`'s "Note on an older numbering"):** that 20-step list was
never written down as one document and step 18's content couldn't be
reconstructed months later. This one is written down as one document,
here, on purpose — update status inline as steps close, don't let this
become a second undocumented list.

---

## Group A — Decide before building anything (steps 1-5)

### 1. ✅ Decide the extraction method — **decided 2026-08-29: fresh, curated history**
- **Checked directly** (`git log --format="%an <%ae>" --all -- 210_apps/001_model_router/`):
  the real commit history contains a real person's full name and
  personal Gmail address in the author field, across 12+ commits — not
  a hypothetical risk, a confirmed one. That alone settles the
  decision: **do not preserve the original git history** when
  extracting. A `git subtree split`/`filter-repo` approach would carry
  that identity into a permanently public, unrescindable record the
  moment the repo goes live.
- No leaked API keys or other secrets found in the history's actual
  diffs (checked separately — see step 3) — the ONE real exposure is
  the author metadata itself, which a fresh/squashed history sidesteps
  entirely along with everything else.
- **Decision: fresh, curated history** — squash to a clean set of
  milestone commits authored under a project/org identity, not
  personal ones, when step 16 actually pushes this public.

### 2. ✅ Pick a license — **decided 2026-08-29: MIT**
- **Decision: MIT**, not a BSL-style source-available license, for this
  first release. Reasoning, weighed against the alternative:
  - Phase 5's whole stated purpose is trust/adoption ("top-of-funnel"
    per section 3's own monetization table) - the two launch
    communities already planned for (Hacker News, r/selfhosted) react
    badly to source-available licenses on a first release from an
    unknown project. BSL here risks damaging the exact thing Phase 5
    exists to build.
  - The competing-hosted-clone risk BSL would guard against is
    theoretical today, not real: it requires someone to find this
    project among much bigger established names (LiteLLM, Portkey,
    OpenRouter), choose to build a hosted competitor on it instead of
    those, and out-compete our own hosted tier on the same code with
    none of our head start. Low-probability chain to defend against
    before there's any traction worth defending.
  - Real precedent (Elastic, MongoDB, Sentry) all started fully
    permissive and only moved to a restrictive license YEARS later,
    once a specific, material competitor was demonstrably siphoning
    revenue - never before there was traction. Code already released
    under MIT stays MIT forever, but nothing stops a FUTURE version
    from adopting different terms later if a real competing clone
    actually appears - so nothing is lost by not defending against a
    threat that doesn't exist yet.
  - MIT over Apache-2.0 specifically: LiteLLM, our closest named
    competitor, already ships MIT - matching it lowers the evaluation
    friction for the exact audience both projects are fishing from.
  - Revisit ONLY if a real competing hosted clone materializes later -
    that would apply to future versions/contributions, not retroactively.
- **Done:** `LICENSE` file added (MIT, "MemoCode" as copyright holder
  as a placeholder - confirm the real legal entity name before step 15
  actually makes the repo public).

### 3. ✅ Secrets and credential audit — **done 2026-08-29, clean**
- Grepped both the working tree AND the full commit history's diffs for
  API key patterns (`sk-...`, `AIza...`, `xai-...`) and email addresses
  — **no leaked keys found anywhere**, and the only email match was the
  git author metadata already handled by step 1's decision, not
  anything embedded in file content.
- `.env.example` confirmed to hold only placeholder values
  (`sk-ant-api03-...` truncated, `your-random-internal-key`, etc.), no
  real credentials.
- `MODEL_ROUTER_OWNER_EMAILS`-style references in the code/docs are the
  env var NAME only, never a real value.
- Nothing to rotate. Re-run this same check once more right before
  step 15 actually makes the repo public, as a final gate — a clean
  result today doesn't exempt a later commit from the same scrutiny.

### 4. ✅ Strip MemoCode-specific coupling — **name decided 2026-08-29: cachegate**
- **Checked directly**: grepped all `.js` code (not docs) for
  "memocode"/"MemoCode" — found only comments explaining context and
  one branded startup log line (`🚀 MemoCode Model Router listening...`
  in `server.js`), **zero functional coupling** — no hardcoded MemoCode
  URLs, no assumption that only a MemoCode caller exists. The "drop-in
  module" design claim holds up under inspection, not just assumption.
- **Naming — a real open decision, CEO's call (taste/brand, unlike the
  license), not decided here.** Checked npm registry availability for
  three neutral candidates: `cachegate` ✅ available, `routecache` ✅
  available, `llm-routecache` ✅ available (`llm-relay` was tried first
  and is already taken by an unrelated, similarly-scoped package).
  - **Case for a neutral name** (not "MemoCode ___"): "MemoCode" is a
    mnemonic/note-taking app name with no connection to "LLM gateway" —
    a stranger evaluating self-hosted LLM routers on Hacker News or
    r/selfhosted would find a "MemoCode Model Router" confusing (why
    does a notes app also make infrastructure?), which works against
    Phase 5's own adoption/trust goal. The eventual Phase 6 standalone
    product will also want its own identity as an "OpenRouter/LiteLLM
    competitor" (`ROADMAP.md` section 6's own framing) — easier to
    establish that now than rename after people have already
    starred/installed something.
  - **Case for keeping MemoCode branding:** funnel value back to the
    parent product; zero rename work.
  - **Decided: `cachegate`.** Applied everywhere: `package.json`'s
    `name`, `package-lock.json` regenerated, `README.md`'s title, and
    the startup log line in `server.js` (was
    `🚀 MemoCode Model Router listening...`, now `🚀 cachegate
    listening...`). Confirmed clean afterward - grepped for any
    remaining "memocode"/"MemoCode" reference in code or README, none
    found. Full suite re-run after the rename: 96/96 passing.

### 5. ✅ Rewrite the README for a stranger, not a teammate — done 2026-08-29
- Existing `README.md` was already thorough and honest (features,
  streaming caveats, dashboard limitations, all stated plainly) - most
  of it needed no change. What was missing for an external reader:
  - A "Why this instead of LiteLLM/Portkey/OpenRouter" section, pulling
    in the honest positioning already drafted in `ROADMAP.md` section 2
    (self-hosted-first, semantic cache with the LiteLLM caveat stated
    plainly, Node.js-native, embeddable, the real 20-45%/47-90% savings
    range instead of an inflated 86-95%).
  - A "What this is NOT" section stating the scope boundary up front
    (no hosted service, no login/billing/multi-tenancy, no 140-provider
    reach, no vector-indexed semantic cache yet) - added, per this
    doc's own step-14 principle, so nobody files an issue asking for
    something never in scope.
  - The quickstart assumed the MemoCode monorepo was already cloned
    (`cd 210_apps/001_model_router` as step one) - now gives both a
    standalone `git clone` path and an "embedded in your own app" path.
  - One paragraph named MemoCode's own internal file
    (`210_apps/000_backend/router-owner.mjs`) as the dashboard-gating
    example - generalized to describe the PATTERN (front the dashboard
    with your own app's login) without a path that won't exist in the
    extracted repo.
  - Title left as a placeholder pending step 4's naming decision.

---

## Group B — Make the code shippable outside this monorepo (steps 6-10)

### 6. 🟨 Package it as a real, standalone npm module — mostly done 2026-08-29
- `package.json`: `name` → `cachegate`, `description` rewritten to be
  accurate standalone (no "for MemoCode" framing), `license: "MIT"`
  added (matches step 2 - npm shows this on the package page without
  needing to open `LICENSE`), `engines: {"node": ">=18.0.0"}` added.
  Honest caveat: `>=18.0.0` is a reasonable floor given the
  dependencies (Express 4, `redis` v4, `pg` v8 all support it), NOT a
  claim this has been cross-version tested — only run against Node 22
  in this sandbox.
- **`bin` entry added**: `"cachegate": "./server.js"`, plus a
  `#!/usr/bin/env node` shebang line added to `server.js` (it had none)
  and the file's execute bit set - both required for `npx cachegate` to
  actually work once published (step 17). README's "Run it" section now
  documents this as the zero-clone path.
- **Deferred on purpose, not forgotten:** the `0.1.0` → `1.0.0` semver
  bump. Bumping it now, before the repo is actually public (step 16),
  would sit oddly in the internal monorepo and communicate a stability
  claim nothing has tested yet. Bump this at step 16/17, right when
  it's actually true.
- Dependencies unchanged and already appropriate for a standalone
  package - nothing in `package.json` assumed shared monorepo tooling
  to begin with, verified by a fresh `npm install` + full test run in
  an isolated worktree: 96/96 passing.

### 7. ✅ Standard OSS repo hygiene — done 2026-08-29
- `CONTRIBUTING.md` — local setup, how to run tests (including the two
  real test-suite conventions a contributor needs to know: no test
  calls a live provider, and metrics-writing tests need to isolate
  their own state), and the scope boundary repeated up front (a PR
  adding login/billing/multi-tenancy gets closed regardless of
  quality — that's a separate product, not this engine).
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1, adopted verbatim
  (that's its actual intended use, not something to rewrite).
- `SECURITY.md` — points to GitHub's private vulnerability reporting
  (Security tab → Report a vulnerability) rather than a fabricated
  contact email; states concretely what counts as a security issue
  for THIS project specifically (auth bypass, cross-deployment data
  leak, a resource-exhaustion path rate limiting doesn't cover) versus
  a regular bug. **Needs "Private vulnerability reporting" turned on**
  in the repo's Settings once step 15 creates it — flagged inline in
  the file itself as a maintainer note to remove once live.
- `.github/ISSUE_TEMPLATE/bug_report.md` + `feature_request.md` (the
  feature template repeats the scope boundary up front too) +
  `config.yml` (points to Security Advisories instead of a public
  issue for vulnerabilities — has a placeholder `OWNER` in its URL,
  flagged inline, to fill in at step 15).
- `.github/PULL_REQUEST_TEMPLATE.md` — a scope-boundary checkbox
  reviewers can actually check against, plus what testing was done.

### 8. ✅ CI for the public repo — done 2026-08-29
- `.github/workflows/test.yml` added: runs on every push and PR
  (deliberately NOT copying this monorepo's own root
  `.github/workflows/e2e.yml`, which is `workflow_dispatch`-only — a
  public OSS repo needs the automatic trigger, that's the whole point
  of the trust signal this step exists for).
- **Real finding, not assumed:** `npm test` needs more than just Node.
  `semanticCache.test.js` spawns its own throwaway `redis-server`
  process directly (the binary isn't on `ubuntu-latest` by default —
  added an install step); `metrics-postgres.test.js` needs a real
  reachable Postgres. The workflow adds a Postgres service container
  matching that test file's own default connection string exactly.
- **Second real finding, caught by actually stopping Postgres and
  re-running the suite rather than trusting the code's own comment**:
  `metrics-postgres.test.js`'s header comment claimed it "fails loudly
  with ECONNREFUSED... rather than silently skipping" — checked
  directly, and that's not what the code does. It probes connectivity
  once and skips gracefully with a warning if Postgres isn't reachable,
  and **every test still reports as passing either way** (96/96,
  whether or not Postgres was running). Fixed the comment to describe
  the real behavior, and noted the real consequence: without this
  workflow's Postgres service, CI would report green while silently
  never exercising that file at all — the service container isn't a
  nice-to-have here, it's what makes the badge mean what it's supposed
  to mean.
- Matrix across Node `18.x`/`20.x`/`22.x` — `package.json` declares
  `engines: {"node": ">=18.0.0"}`; running against all three actually
  backs that claim instead of leaving it asserted but untested.
- **Verified for real, not just written**: ran the actual suite locally
  with both a live local Postgres (started, password/db created to
  match the test's default string) and the pre-installed `redis-server`
  binary present — 96/96 passing, ~11s (vs. ~1.3s when Postgres is
  down and that file's tests silently skip) — confirms the difference
  is real exercise, not a no-op.
- Added a CI-status badge to `README.md` (next to the license badge) —
  has the same `OWNER` placeholder as `.github/ISSUE_TEMPLATE/config.yml`,
  flagged inline, to fill in at step 15.

### 9. 🟨 Docker image — improved and documented; build NOT verified here, real limitation
- **Honest limitation, not glossed over**: this sandbox's network
  egress policy blocks Docker Hub entirely (confirmed - `docker build`
  fails pulling `node:20-slim` with a 403 policy denial from
  `production.cloudfront.docker.com`, and the proxy status explicitly
  lists it as a policy denial, not a transient failure worth retrying).
  **The actual `docker build` + `docker run` + hit-`/health` verification
  this step calls for could NOT be done from here** - that needs
  whoever has real internet access (the CEO's local machine / DeepSeek's
  lane) to run it for real before step 16 ships. Said plainly rather
  than assumed to be fine.
- What WAS done, based on direct static review of the existing
  `Dockerfile` (not a guess):
  - **Added `.dockerignore`** - none existed. Without it, `COPY . .`
    would copy a HOST-machine `node_modules` (if one happens to exist
    at build time) straight over the image's own freshly-`npm ci`'d
    one - a classic, easy-to-hit Docker footgun, especially likely
    once this is a real repo other contributors build locally. Also
    excludes `.env`, `.git`, `test/`, `.github/` - none of it belongs
    in a runtime image.
  - **Added a non-root `USER node`** - the official Node image already
    ships this user (uid 1000); the Dockerfile just never used it,
    running as root by default. Standard hardening for a public image.
  - **Added a real `HEALTHCHECK`** - calls the existing `GET /health`
    endpoint via Node's own `http` module (the slim base image has no
    curl/wget), so `docker ps` actually reports `healthy`/`unhealthy`
    instead of only "running."
- **Publish target decided: GitHub Container Registry (GHCR)**, not
  Docker Hub - ties to the same repo/`GITHUB_TOKEN` already used for
  CI with no separate account or credential to manage, and the image
  inherits the repo's own visibility settings. Docker Hub has better
  discoverability for someone specifically browsing Docker Hub's own
  search, but the realistic audience here is someone already reading
  this GitHub repo's README, not browsing Docker Hub cold - GHCR fits
  that path better. Not closed off permanently: worth adding a Docker
  Hub mirror later if search-driven discovery turns out to matter.
- README's "Run it" section gained a Docker subsection: `docker build`
  + `docker run` with `--env-file`, a note on what `HEALTHCHECK`
  reports, and an explicit statement that Redis is NOT bundled in the
  image (point `REDIS_URL` at an external instance; missing it disables
  caching cleanly rather than failing to start).
- **Remaining, real, not done here:** the actual build-and-run
  verification. Flagging this explicitly as an open item for whoever
  picks this up next with real network access - do not treat this
  step as fully closed until that verification actually happens.

### 10. ✅ Config and environment documentation — done 2026-08-29
- **Checked directly, not assumed**: grepped every `.js` file for
  `process.env.` to build the actual, complete list of env vars the
  code reads, then diffed it against `.env.example`.
- **Real finding**: `.env.example` (and the README's own `.env`
  snippet) documented `ANTHROPIC_MODEL=claude-sonnet-4-5-20250929` as a
  config value - **grepped for it and it's read NOWHERE in the code**.
  The model is named per-request in the API call's own `model` field,
  not configured via env at all. A new user setting this would see it
  silently do nothing. Removed from both files, replaced with an
  explicit note that the model is per-request, not env-configured.
- **Missing from `.env.example` entirely, now added**:
  `ALLOW_INSECURE_LOCAL_DEV`, `EMBEDDING_MODEL` (which OpenAI embedding
  model the semantic cache uses), `METRICS_LOG_PATH` (JSONL storage
  location), `MEMOCODE_ROUTER_DATABASE_URL` (an alternate to
  `DATABASE_URL` that takes priority when set - useful when embedding
  this inside an app that already has its own `DATABASE_URL`), and
  `ROUTER_TIERS_JSON` (override the default routing tiers).
- **Genuinely tested the quickstart, not just written it**: ran
  `npm install`, copied `.env.example` to `.env`, filled in a test
  internal key and a fake Anthropic key, ran `npm start` - boots clean,
  logs "🚀 cachegate listening on port 4000." Hit `GET /health` (real
  response, correctly reflecting config) and `POST
  /v1/chat/completions` (reached Anthropic for real, got back a genuine
  401 "API key is invalid" - proving the full pipeline works end to
  end; only the placeholder key is fake, exactly what a real follower
  would see before adding their own). Also confirmed `.env` and the
  metrics `data/` directory stay gitignored, as claimed.
- README's `.env` snippet now points to `.env.example` for the full
  option list instead of duplicating a partial, now-corrected copy of it.

---

## Group C — Keep embedded and public in sync, and safe (steps 11-14)

### 11. ✅ Decide the concrete sync mechanism — **decided 2026-08-29**
- `ROADMAP.md` section 6 states the *principle* ("wrap it, don't fork
  it - same core logic, two thin deployment shells") but never names
  an actual mechanism. Two directions were on the table:
  - (a) the public repo becomes the source of truth, MemoCode vendors
    it in via a script/subtree pull.
  - (b) this monorepo directory stays the source of truth, a script
    pushes/mirrors it out to the public repo on release.
- **Decided: (b) — this monorepo directory stays the source of truth.**
  Reasoning:
  - It matches reality, not a fresh ideal: every real day of
    development on this router - the original 20-step build, the
    failover feature, all ten OSS-prep steps so far - happened inside
    this monorepo, through its own task-branch/PR/gate workflow
    (`AGENTS.md`). Moving day-to-day development to the public repo
    would mean either running two parallel workflows or abandoning the
    one that's actually proven itself this week - neither is worth it
    to satisfy a "public repo is canonical" ideal nobody needs yet.
  - Option (a) would put every internal-only concern (this team's own
    coordination-board conventions, anything MemoCode-embedding-
    specific) through public PR review before it could land internally
    - backwards for a team that needs to move fast on its own repo.
  - This is also the well-established pattern for exactly this
    situation, not a novel one: several real companies develop OSS
    projects inside a private monorepo and mirror them out
    (contributions flow back in via manual review + reapplication, not
    automatic two-way merge) rather than developing directly in the
    public repo.
- **The real gap this creates, named rather than ignored:** once
  external contributors exist (post step 19's launch), their PRs land
  on the PUBLIC repo first - there is no automatic path back into this
  monorepo. Concrete resolution: an accepted external PR gets manually
  reapplied to `210_apps/001_model_router/` as its own normal task
  branch here (same `AGENTS.md` workflow as any other change - it goes
  through this project's own gate even though it originated externally,
  on purpose, not as an oversight: an external diff doesn't get to skip
  this codebase's own verification standard just because GitHub already
  approved it). This creates a real but bounded divergence window
  between the two repos - acceptable, disclosed, and the discipline is
  keeping that window short (reapply promptly), not eliminating it.
- **The actual repeatable command** (implemented for real in step 12,
  sketched here so the decision isn't just prose): a single script,
  `sync-oss-release.sh`, invoked as `./sync-oss-release.sh <path-to-public-repo-checkout>`,
  that does, in order: (1) copy this directory's tracked files into the
  target checkout, excluding anything `.gitignore`d; (2) run the same
  secrets grep step 3 already established, failing loudly rather than
  publishing on a hit; (3) bump `package.json`'s version per step 6's
  deferred semver plan; (4) commit and leave the push to a human/CI
  step, never auto-pushed. One command, not a remembered sequence of
  manual copy-paste steps.

### 12. ✅ Build the actual sync script/workflow — done and genuinely tested 2026-08-29
- `sync-oss-release.sh` built per step 11's decision: mirrors this
  directory's git-tracked files into a target checkout (removing
  everything else there first, except its own `.git/`), scans for
  secrets before touching anything, optionally bumps `package.json`'s
  version (`--version X.Y.Z`), and commits in the TARGET repo without
  pushing. Refuses to run against a path that isn't a git repository,
  specifically so pointing it at the wrong path can't wipe something
  unrelated.
- **Actually tested end-to-end, not just written** - a real target git
  repo was created in scratch space and run through every real
  scenario: a clean sync with `--version 0.9.0` (files copied
  correctly, version bumped, a stale target-only file correctly
  removed, real commit created); a resync with no version flag
  (correctly left the version as whatever's currently in this
  directory); an identical third run (correctly reported "nothing
  changed," no empty commit); the non-git-directory safety guard
  (correctly refused); and the secrets-scan abort path (a real fake
  key was planted in `README.md` and the script was run against it).
- **Real bug found by that last test, not assumed to work**: the
  secrets-scan regex FAILED to catch the planted key on the first
  attempt. Root cause: the character class `[a-zA-Z0-9]{20,}` used
  after `sk-`/`xai-` doesn't allow hyphens - and a real Anthropic key
  looks like `sk-ant-api03-<random>`, where the hyphens immediately
  after `sk-` broke the match after only 3 characters. Fixed to
  `[a-zA-Z0-9_-]{20,}` (matching `AIza`'s pattern, which already had
  this right), re-tested, and confirmed it now correctly aborts.
- **This is the exact same pattern used in steps 1, 3, and 8's manual
  audits** - meaning those "clean" results were reached with the same
  blind spot. Re-ran the full audit (working tree + entire commit
  history) with the CORRECTED pattern before concluding anything:
  still genuinely clean. The earlier conclusion holds, but only because
  it was actually re-verified just now, not assumed to still be valid
  once the flaw in the method was found.
- No separate "checklist for what needs re-verifying after a sync" was
  needed beyond what the script itself already does (secrets scan is
  automatic on every run) - a maintainer still reviews the target
  repo's diff before pushing (the script's own final message says so),
  which covers README drift and anything else worth a human glance.

### 13. ✅ Security review pass, specifically for "now public" risk — done 2026-08-29
- **The one real, serious finding, confirmed live not assumed**: sent
  an actual oversized POST body during this review and got back a raw
  HTML page containing a FULL STACK TRACE with this server's own
  absolute filesystem paths - Express's own default error handler,
  reached because nothing here ever caught an error raised before a
  route's own try/catch (the concrete trigger: `express.json()`
  rejecting a too-large body). Fixed with a catch-all JSON error
  handler registered last, re-tested with the identical request:
  `{"error":"Request body too large."}`, 413, no stack trace. This is
  exactly the class of thing "worked fine as an internal tool nobody
  attacked" and would not have survived being public.
- **Second real finding**: `express.json({ limit: '50mb' })` was
  applied GLOBALLY and BEFORE the `/v1` auth check - an anonymous
  caller could force up to 50MB of JSON parsing per request before
  ever being rejected with 401. Fixed three ways: scoped to `/v1` only
  (the sole route that reads a body - checked directly, every other
  route is a body-less GET); moved after `requireInternalKey` and the
  rate limiter in the middleware chain, so a request is rejected by a
  cheap check before any parsing happens; limit dropped from 50mb to a
  configurable 2mb default (`JSON_BODY_LIMIT`) - checked that this
  router has no image/multimodal support, so even a very long text
  conversation fits comfortably under that. Live-verified: an
  unauthenticated 3MB POST now gets rejected in 16ms with a 401,
  vs. previously being fully parsed first.
- **Third finding, lower severity**: `/stats` and `/dashboard/data`
  had `requireInternalKey` but no rate limit at all, unlike `/v1`.
  Added a separate, more generous `readEndpointLimiter`
  (`READ_RATE_LIMIT_MAX`, default 120/window) - lower stakes than `/v1`
  (no provider spend on the line) but still real server work a
  leaked/shared key shouldn't be able to hammer unbounded.
- Free hardening added while in here: `app.disable('x-powered-by')` -
  no reason to hand a public-facing service's framework fingerprint to
  every caller.
- **Confirmed clean, no fix needed** (checked directly, not assumed):
  no `.stack` or raw error object is ever sent to a client anywhere in
  the existing route handlers - every error path already used
  `err.message` only. `ALLOW_INSECURE_LOCAL_DEV` already refuses to
  start without either a real key or this explicit opt-in, AND already
  prints a loud runtime `console.warn` when active - no doc-only
  warning to strengthen, the code itself already enforces it. No CORS
  middleware exists, which is the CORRECT default here (an admin/data
  API with bearer-token auth has no reason to allow arbitrary
  cross-origin browser access) - not a gap to fix.
- Also clarified in `server.js`'s own rate-limiter comment: the
  "shared ceiling across all callers" caveat is specific to a
  single-caller EMBEDDED deployment - a standalone self-hoster with
  distinct per-caller IPs gets real per-caller separation from the
  same default, not the same limitation.
- All fixes verified live (server started, real HTTP requests sent and
  checked) in addition to the automated suite - 96/96 passing
  throughout, confirming none of this changed any existing behavior
  other than the three things it was meant to fix.

### 14. ✅ Explicit non-goals, written down where a stranger will read them — done 2026-08-29
- Most of the literal content already existed from step 5 (the README's
  "What this is NOT" section) and step 7 (`CONTRIBUTING.md`,
  `.github/ISSUE_TEMPLATE/feature_request.md`) - checked all three
  directly rather than assuming step 14 was redundant with them.
- **Real gap found in two of the three, not assumed fine**: both the
  README's closing line and `CONTRIBUTING.md`'s scope section said, in
  effect, "if you want a hosted service, fork it" - which actively
  *invites* the exact outcome this section (and step 2's license
  reasoning) exists to discourage. Technically true under MIT, but
  saying it right next to "this is not a hosted service" undermines
  the whole point of drawing the boundary. Fixed both: still honest
  that MIT permits it (never claimed otherwise), but reframed as "not
  a licensing restriction, a project-scope one" - this repo specifically
  isn't going to grow into a hosted competitor to its own paid product,
  full stop, rather than a soft invitation to go build one.
  `.github/ISSUE_TEMPLATE/feature_request.md` already had this right -
  checked, no change needed there.
- README's closing line also now explicitly separates the two real,
  legitimate PR-worthy gaps (140-provider reach, vector-indexed
  semantic cache) from the one boundary that isn't a gap at all,
  pointing to `CONTRIBUTING.md` before someone opens a PR for it.

---

## Group D — Ship it (steps 15-18)

### 15. ⬜ Create the real public GitHub repository
- Public repo under whichever account/org is decided, real description,
  topics/tags for discoverability (`llm-gateway`, `semantic-cache`,
  `self-hosted`, `openai-compatible`, `llm-proxy`).
- Branch protection on the default branch (require CI green + review
  before merge - the repo's own credibility depends on this from day
  one, unlike an internal task branch nobody outside the team sees).

### 16. ⬜ Push the extracted, cleaned codebase
- First real push/release using whatever step 1 decided (curated
  history or fresh start).
- Tag it `v1.0.0` (or whatever step 6 decided) - this is the actual
  "it's out" moment everything before this step has been preparing for.

### 17. ⬜ Publish the npm package
- `npm publish` under the name step 4 chose, confirming it installs
  cleanly in a throwaway empty directory (not just "works from this
  monorepo").

### 18. ⬜ Publish the Docker image
- Push to the registry step 9 chose, confirm `docker pull` + `docker
  run` works cold, from a machine that has never seen this project's
  source at all.

---

## Group E — Tell people, then keep it alive (steps 19-20)

### 19. ⬜ Announce
- Per `ROADMAP.md`'s existing plan: Hacker News (Show HN post),
  r/LocalLLaMA, r/selfhosted, Dev.to - each gets its own framing (Show
  HN wants the honest savings number and the self-hosted angle;
  r/selfhosted wants the Docker one-liner front and center; Dev.to
  supports a longer "why we built this" writeup).
- Write the honest version of "why this exists" - the real story (an
  internal tool for MemoCode that turned out to be worth its own
  release), not a manufactured origin story.

### 20. ⬜ Post-launch triage plan
- Decide who watches the new public repo's issues/PRs day-to-day (the
  same "one agent holds the standing watch" model already used for
  this team's own PRs, per `AGENTS.md`) - a public repo with no
  visible maintainer activity in the first weeks reads as abandoned.
- Define what "Phase 5 done" actually means so it doesn't stay
  open-ended forever: e.g., shipped + stable for some real window with
  no critical issues, or a first external contribution merged -
  pick a concrete bar, not a vibe.
- This is also the moment Phase 6 (the standalone/hosted, NOT
  open-sourced) becomes buildable for real - it depends on this
  engine being proven stable under outside use, not just internal
  dogfooding.

---

*Written 2026-08-29. Cross-referenced from `ROADMAP.md`'s Phase 5. Update
status markers inline as each step closes - this document IS the tracker,
not a one-time plan to be superseded by a better one later.*
