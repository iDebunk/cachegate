<!-- moved from iDebunk/cachegate-coordination@2f8b360:designs/cachegate-release-check.md on 2026-09-27 - this repo keeps its own reports; the original stays in that repo as the archive -->

## Release check

T-210 / roadmap step 08 — Part 2 (claude-deepseek). Repo `cachegate`, main `8228274`.
Read-only: nothing was published, bumped or written to the repo. Every claim carries the command or the
value that produced it, so it can be re-run.

**This file corrects an earlier draft that was wrong in two places, and a first revision of itself in a
third** — see *Corrections* and *Re-verification* at the end.

> **Read this first — §1-§4 below are the 1.3.1 answer and are kept as the record.** They were correct
> when written and are still true of 1.3.1. They are no longer the current release: **1.4.0 shipped on
> 2026-09-12 while this card was open**, and all three blockers §4 raised are closed. The current answer
> is the last section, *Pass 4*.

### 1. Is 1.3.1 published? — YES, and on all three channels

| check | command | result |
|---|---|---|
| repo version | `node -p "require('./package.json').version"` | `1.3.1` (name `cachegate`) |
| npm latest | `npm view cachegate version` | `1.3.1` |
| npm dist-tags | `npm view cachegate dist-tags` | `{ latest: '1.3.1' }` |
| npm versions | `npm view cachegate versions` | `1.0.0, 1.1.0, 1.1.1, 1.2.0, 1.3.0, 1.3.1` |
| npm last publish | `npm view cachegate time.modified` | `2026-09-05T21:30:30.961Z` |
| tarball gitHead | `npm view cachegate gitHead` | `1e946280b8288783aa27fb859b4a9ef718b3d5e7` |
| Docker Hub | `hub.docker.com/v2/repositories/shipman/cachegate/tags/1.3.1` | present, pushed `2026-09-05T21:51:04Z` |
| GHCR | `ghcr.io/v2/idebunk/cachegate/tags/list` | `1.0.0 … 1.3.1` + `latest` |
| git tag | `git ls-remote --tags origin` | `v1.3.1` → `ac5ba8451eeaa373f66135f8e6b8b54729f1a189` |

The npm tarball traces to real history here: `git cat-file -t 1e946280…` → `commit`, and
`git log -1 1e946280…` → `1e94628 ci(release): add workflow_dispatch for manual/retry runs`, on top of
`3c1bddd ci: automate npm/GHCR/Docker Hub publish on version bump` and `2276b0b chore(release): 1.3.1`.
It is not an orphan publish.

On Docker Hub, `latest` and `1.3.1` resolve to the **same digest**, so `latest` has not drifted away from
the released version. Both tags carry both of these, and they are different objects:

- manifest digest `sha256:a734574faa6998478b0e4801c28dc4ddcac4a9e2cd8774e4c478846c39a193cd` — the tag
  response's top-level `digest`, what the tag *is*;
- amd64 image digest `sha256:a3fc054ac6ab57dc4eec42dcac116761392802e540137c4e4d285522dde2bf0a` — that same
  response's `images[0].digest`, one layer down.

GHCR serves the **same manifest digest** for `1.3.1`
(`ghcr.io/v2/idebunk/cachegate/manifests/1.3.1` → `docker-content-digest`:
`sha256:a734574f…`), so the two registries hold byte-identical manifests, not merely same-named tags.
*(An earlier revision quoted only `a3fc054a…`, unlabelled — see Correction 3.)*

**The publication boundary held** — the check this repo's `AGENTS.md` singles out, because internal
planning material leaked into the npm tarball once before. The 1.3.1 tarball's file list is *exactly* the
`files` allowlist as it stood at `1e94628`, plus only the three files npm always adds:

```
package/.env.example  package/LICENSE  package/README.md  package/package.json
package/cache.js  package/embeddings.js  package/failover.js  package/metrics.js
package/redisClient.js  package/router.js  package/semanticCache.js  package/server.js
package/streaming.js  package/providers/anthropic.js  package/providers/openai.js
package/public/dashboard.html
```

No roadmap or planning file, no `.github/`, no `eval/`, no `CHANGELOG.md`. Verified by downloading the
tarball (`npm view cachegate@1.3.1 dist.tarball`) and comparing `tar -tzf` against
`git show 1e94628:package.json`'s `files` array — the two lists are equal.

### 2. Changelog — current for 1.3.1, but it contains one real defect

- `## [1.3.1] - 2026-09-05` is present. ✓
- An `## [Unreleased]` section sits above it, per Keep a Changelog. ✓
- **`## [1.4.0] - 2026-09-06` sits between them, and 1.4.0 was never released.** Keep a Changelog reads
  `## [version] - date` as *shipped on that date*, which makes this heading a false statement today:

  | test | result |
  |---|---|
  | `git log -S'"version": "1.4.0"' -- package.json` | **empty** — the version was never bumped |
  | `npm view cachegate@1.4.0 version` | **404** — never published |
  | `git ls-remote --tags origin` | only `v1.3.1` — no `v1.4.0` |
  | introducing commit | `8ffae3b docs(changelog): **draft** the 1.4.0 entry for everything since 1.3.1 (Steps 20-36)`, 2026-09-06T17:52:12Z |

  The section is not padding — it documents real merged work on main (DeepSeek + OpenRouter providers and
  the provider registry, `saved_usd`, prompt canonicalization, the local embeddings backend, request
  coalescing). The *code* shipped to `main`; only the *release* never happened. So a stranger reading
  `CHANGELOG.md` — or the GitHub Releases page, which the pipeline fills from this file — is told 1.4.0
  shipped on 2026-09-06. It did not.

### 3. Release pipeline — green end-to-end exactly once, not "all green"

`release.yml` fires on a push to `main` that changes `package.json`'s version to something not already
live on npm. Manual runs via `workflow_dispatch` are the documented retry path.

8 runs total: **6 success, 2 failure** — both failures on the first attempts at 1.3.1:

| run | when (UTC) | outcome |
|---|---|---|
| 33992621034 | 2026-09-05 21:17:42 | **failure** — `publish-npm` failed at *Run npm publish*; `publish-docker` failed at *Build and push*; `tag-and-release` skipped |
| 33993168310 | 2026-09-05 21:28:55 | **failure** — npm **succeeded**, `publish-docker` failed at *Build and push* → a **partial release** |
| 33993965551 | 2026-09-05 21:45:35 | success |
| 33994132040 | 2026-09-05 21:49:10 | success — all 5 jobs including `tag-and-release` |
| 34006512389 / 34011422769 / 34032132144 / 34044216425 | 2026-09-06 | success — but see below, these are **no-ops** |

`ac5ba84 ci(release): add force-retry input, make npm publish idempotent` landed between the second
failure and the successes; the `force` input and the idempotent npm step exist *because of* that
partial-failure mode, so its cost has already been paid once.

**The four push-triggered runs on 2026-09-06 are green but prove nothing about publishing.** In each of
them `check-version` succeeds and every downstream job is **skipped** (`should_publish=false`, because
1.3.1 was already `latest`). Checked directly on run 34044216425: `check-version → success`,
`test/publish-npm/publish-docker/tag-and-release → skipped`. They exercise the *gate*; the last run that
actually exercised the *publish path* is 33994132040 on 2026-09-05.

Tests workflow (`test.yml`): 72 runs, latest `success` on `8228274` (2026-09-11T03:43:06Z), which **is**
the current main SHA — so current main is green.

### 4. Blockers

**For 1.3.1: none.** Published on all three channels, matches the repo, has a changelog entry, traces to
a real commit, and the pipeline that produced it finished green.

**For the next release — three items, and the first is step 09's actual work:**

1. **The changelog claims 1.4.0 shipped; it never did.** Everything merged since 1.3.1 is sitting
   unreleased on main while the file describes it as dated output of 2026-09-06. The fix is to publish it
   as 1.4.0 (or re-date it if the next version should also absorb `[Unreleased]`) — either way the version
   in `package.json` must change, because that is the pipeline's only trigger.
2. **`[Unreleased]` holds a security fix that is also a behaviour change.** `trust proxy` was hardcoded to
   `1`; with no proxy in front that tells express to trust client-controlled `X-Forwarded-For`, so a
   caller could present a fresh IP per request and defeat the per-IP limiter on the key-holding routes —
   fail-**open**, silently. The default is now `false`. Verified in this clone, not just in the changelog:
   `resolveTrustProxy()` at `server.js:109-142` returns `false` when unset (with a boot-time warning when
   `RENDER` is detected) and **throws** on an unparseable value; `test/trust-proxy.test.js` asserts both.
   This is at least a **minor** bump, and the UPGRADE NOTE ("set `TRUST_PROXY=1`") must stay prominent — a
   proxied deployment that upgrades without setting it gets a global rate limiter.
3. **Any release must be verified on all three channels, not just npm.** Run 33993168310 is the
   precedent: npm published, Docker did not, and it took a manual retry. "It's on npm" is not
   "it's released".

### Method, and what was not run

Read-only, from the working clone at `8228274` (= `origin/main`). Registry state via `npm view`; workflow
state, run history and per-job conclusions via `gh api repos/iDebunk/cachegate/actions/…`; image tags via
the Docker Hub tag API and the GHCR anonymous token flow; the tarball by download.

**Not run, stated so it is not mistaken for a pass:** `npm test` in this clone (that is step 10's
acceptance, not step 08's), and any check of the *contents* of the published Docker images — I confirmed
the tags and digests exist, not what is inside them.

### Corrections to the earlier draft of this file

Two claims in the previous version were wrong, and both were wrong in the direction of *more green than
the evidence supports*:

1. It reported the Release workflow as "8 runs, **all `success`**". It is **6 success and 2 failure**; the
   failures are listed in §3. This matters beyond bookkeeping: that draft concluded the next version bump
   would be "the first real test" of the publish path, when the publish path had in fact already failed
   twice — once leaving npm and Docker out of sync.
2. It reported the published versions as "1.1.1, 1.2.0, 1.3.0, 1.3.1", omitting `1.0.0` and `1.1.0`.

It also did not mention the `## [1.4.0]` defect at all, which is the largest thing in this file.

One note from the earlier draft is confirmed and worth keeping: I expected the Actions API to refuse for
lack of the `workflow` token scope. It does not — that scope governs *writing* workflow files; reading run
history and job conclusions works fine. Do not skip the check on the assumption it cannot run.

### Where this file was written, and why the live copy may lag

`/app/workspace/coordination/designs/` is root-owned and **not writable by the agent uid** — append,
truncate and replace were all attempted and all denied (`EACCES`), leaving the original intact. The
corrected text was therefore committed in this agent's coordination state clone
(`/app/workspace/coordination-state-claude-deepseek`) and pushed to the shared bare remote
(`/app/workspace/remote/coordination.git`, `main`), which is the documented write path.

**The lag this section warned about has since been observed and closed.** The earlier revision ended
"the live checkout at `/app/workspace/coordination` keeps the **old, wrong** copy until it is synced".
It has been synced — checked, not assumed: the live checkout's HEAD is `5786a35`, its working tree is
clean, `08d5214` (the commit that introduced this text) is an ancestor of that HEAD, and `diff` of the
live file against the committed file reported **no differences**. So the write path above is not a
theory; it has now run end to end once. *This* revision will in turn lag until the next sync — that
costs nothing here, because the acceptance (`test -s`) is satisfied by a file that already exists.

**Syncing it needs `reset`, not `pull` — verified, not assumed.** In the live checkout that path was
*untracked* while the commit that introduced it *tracks* it, so a plain pull aborts:

```
$ git pull origin main
error: The following untracked working tree files would be overwritten by merge:
        designs/cachegate-release-check.md
Please move or remove them before you merge.
Aborting
```

`git fetch && git reset --hard origin/main` does work (reproduced in a scratch clone: the tracked path
is written from the commit regardless of the untracked file) and is what `watch.sh`'s `sync_fresh`
already does. So the live copy is correctable without touching the file by hand.

### Re-verification pass, and Correction 3 (2026-09-12T11:43Z)

Every check in §1-§3 was re-run from scratch in a fresh clone and **all of them reproduced**: npm reports
`1.3.1` with dist-tag `latest` and versions `1.0.0, 1.1.0, 1.1.1, 1.2.0, 1.3.0, 1.3.1`; the tag `v1.3.1`
→ `ac5ba84`; the published tarball's 16 paths equal the `files` allowlist at `1e94628` **plus exactly**
`LICENSE`, `README.md`, `package.json`; the Release workflow is 8 runs — 6 success, 2 failure — with the
per-job conclusions in §3 (including `34044216425`, where only `check-version` ran and the other four
jobs are `skipped`); `test.yml` is 72 runs with the latest `success` on `8228274` = `origin/main`; and
`resolveTrustProxy` still returns `false` when unset and throws on an unparseable value
(`server.js:109-142`, `test/trust-proxy.test.js` asserting both). The `reset`-not-`pull` claim was
re-reproduced too, with one precision worth recording: the abort message depends on which commit you are
standing on. From `0cdcfa3` (before the file existed) it is *"untracked working tree files would be
overwritten"*; from `e1a9cb8` (the file introduced, then modified locally) it is *"Your local changes to
the following files would be overwritten"*. Both exit 1, both leave HEAD where it was, and in both cases
`git reset --hard origin/main` writes the committed file.

One claim did not survive as *cited*, and it is corrected here:

3. **A digest was quoted without saying which of the two it was.** The first revision of this file said
   `latest` and `1.3.1` resolve to `sha256:a3fc054a…`. Both tags *do* carry that value — but it is the
   **amd64 image digest** (the tag response's `images[0].digest`), not the digest the tag resolves to
   (the response's top-level `digest`). Anyone re-running the obvious command and reading the top-level
   field gets `sha256:a734574f…` and would conclude the claim had failed to reproduce, when the claim
   itself was true. §1 now labels both values. The re-check also added a fact the first revision did not
   have: GHCR serves the **same** manifest digest as Docker Hub, so the two registries are byte-identical
   for `1.3.1` — a stronger statement than "both have a tag by that name".

Stated so it is not mistaken for a pass: this pass re-ran §1-§4 and nothing else. It did **not** run
`npm test` (that is step 10's acceptance) and did **not** inspect the contents of the published images.

### Pass 3, 2026-09-12T12:14Z — 1.3.1 unchanged; the fix for blocker 1 is now in flight

Same method, same clone (`origin/main` `8228274`, still the tip, still the SHA `test.yml` last went green
on). **§1-§3 re-ran and every number is identical** — this pass adds no correction, only freshness and one
new fact:

- **npm**: `npm view cachegate version` → `1.3.1`; `dist-tags` → `{ latest: '1.3.1' }`; `versions` → the
  same six (`1.0.0, 1.1.0, 1.1.1, 1.2.0, 1.3.0, 1.3.1`); `time.modified` → `2026-09-05T21:30:30.961Z`,
  byte-identical to pass 2, so **nothing has been published since 1.3.1**.
- **Tags**: `git ls-remote --tags origin` → `v1.3.1` → `ac5ba8451eeaa373f66135f8e6b8b54729f1a189`, and
  nothing else. No `v1.4.0`.
- **Registries** (re-fetched, not quoted from pass 2): Docker Hub `1.3.1` and `latest` both →
  manifest `sha256:a734574f…`, `images[0]` `sha256:a3fc054a…`, `tag_last_pushed` `2026-09-05T21:51:05Z` /
  `21:51:07Z`; GHCR `1.3.1` and `latest` both → `docker-content-digest: sha256:a734574f…` (same manifest
  as Docker Hub) and its tag list is unchanged: `1.0.0, latest, 1.1.0, 1.1.1, 1.2.0, 1.3.0, 1.3.1`.
- **Changelog on `origin/main` is still the defect described in §2**: `## [Unreleased]` at line 7,
  `## [1.4.0] - 2026-09-06` at line 48, `## [1.3.1] - 2026-09-05` at line 169, and `package.json` on main
  is still `"version": "1.3.1"`.
- **Pipelines**: `release.yml` → 8 runs, 6 success / 2 failure, the same run ids and timestamps as §3; the
  publish path has still not been exercised since `33994132040` on 2026-09-05. `test.yml` → 72 runs,
  latest `success` `34559492309` on `8228274`.

**New since pass 2 — blocker 1 has an owner and an unmerged branch, and it is not yet testable by CI.**
Branch `agent/T-213-trust-proxy` exists on origin, tip `55cb0ff`, committed `2026-09-12T12:09:52Z` (author and
commit dates identical; the push is at or after that and was not separately recorded — the branch was already
on origin when this pass read it at 12:12Z), *"chore(release): 1.4.0 — make the changelog's claim true, and
lead with the security fix"* (folds
`[Unreleased]` into `## [1.4.0] - 2026-09-12` and leads with the `TRUST_PROXY` upgrade note). It is **not**
merged — main is still `8228274` — and, checked rather than assumed, it is **not covered by any CI run**:
`repos/iDebunk/cachegate/pulls?state=open` returns **zero** open PRs, `test.yml` triggers only on
`push: branches: [main]` and `pull_request:`, and its run count is still 72. So the branch push matched
neither trigger and nothing has executed it. Under this repo's own rules (a green check on the PR is the
trust signal; the supervisor merges, not the author) an untested release commit is not releasable yet —
which is why "1.4.0 exists on a branch" must not be read here as "1.4.0 is ready".

**Method and limits of this pass.** Same read-only tooling: `npm view`; `gh api` for run history and PRs
(REST; the GraphQL path `gh pr list` returns `API rate limit already exceeded` for this token, REST does
not); Docker Hub tag API; GHCR anonymous token; `git ls-remote`; `git show origin/main:<file>`. Not
re-run, and said so rather than implied: the tarball-vs-`files` allowlist diff of §1 — the artefact it
measures cannot change while `1.3.1` is the newest published version and `time.modified` is unchanged —
and any inspection of the contents of the published images. `npm test` again not run (step 10).

**Nothing was committed to `cachegate` for this card.** The deliverable is internal coordination material
and this repo's `AGENTS.md` §2 forbids internal planning material (task ids, roadmap references) in the
public repo and treats the `files` allowlist as a publication boundary, so there is deliberately no
`agent/T-210-cachegate-release` branch on origin. The artifact's write path is the state clone below.

This is the third pass over the same card (claims at 11:18, 11:32, 12:03; the T-210 task file is still
`status: pending` while the acceptance already passes), so passes 2 and 3 mostly re-measure the same
unchanging release. That is the correct direction for this particular check — a release number is exactly
the thing that must be re-read rather than assumed — but a reader should not expect a new finding unless
the version in `package.json` on main changes.

### Pass 4, 2026-09-12T12:41Z — **the version changed: 1.4.0 is published, and the release is green end to end**

Pass 3 closed with "a reader should not expect a new finding unless the version in `package.json` on main
changes." It changed, roughly twenty minutes later, so this pass is a new answer rather than a re-measure.
Every value below was re-fetched between 12:39Z and 12:45Z.

**The release happened.** `main` moved `8228274` → `49dcf168`, committed `2026-09-12T12:33:52Z`, PR #25
*"chore(release): 1.4.0 — make the changelog's claim true, and lead with the security fix"* — that is the
`agent/T-213-trust-proxy` branch pass 3 saw sitting untested, merged. `package.json` on main: `1.4.0`.

| channel | value |
|---|---|
| npm version / dist-tags | `1.4.0` / `{ latest: '1.4.0' }` |
| npm versions | `1.0.0, 1.1.0, 1.1.1, 1.2.0, 1.3.0, 1.3.1, 1.4.0` |
| npm `time.modified` | `2026-09-12T12:35:38.411Z` |
| npm `gitHead` | `49dcf1686b3bd780d0c4b6cb574cfeb65411fb9c` **= main tip** |
| git tags | `v1.4.0` → `49dcf168…`; `v1.3.1` → `ac5ba84…` still the only other |
| GitHub Release | `v1.4.0`, `draft=false`, published `2026-09-12T12:37:00Z` |
| Docker Hub `1.4.0` and `latest` | manifest `sha256:2d5d04f6…`, `images[0]` `sha256:8d0a23ce…`, pushed `12:36:42Z` / `12:36:43Z` |
| GHCR `1.4.0` and `latest` | `docker-content-digest: sha256:2d5d04f6…` |

The two registries serve the **same manifest digest** for `1.4.0`, so Docker Hub and GHCR hold
byte-identical images, and `latest` on each *is* that manifest — no tag drift, on either.

**The pipeline ran the publish path, not the gate — and was green first try.** Release run `34694017580`
(`push`, `main`, `49dcf168`, `2026-09-12T12:33:54Z`) → `success`, and **all five jobs ran**: `check-version`,
`test`, `publish-docker`, `publish-npm`, `tag-and-release`, none `skipped` — unlike the four 2026-09-06
runs §3 identified as no-ops. First end-to-end exercise of the publish path since `33994132040`
(2026-09-05), and it did **not** repeat the partial-release failure of `33993168310`: npm, both image
registries, the git tag and the GitHub Release all exist for the same commit. `release.yml` now stands at
**9 runs — 7 success, 2 failure**, the two failures still the 1.3.1 attempts in §3.

`test.yml` is now **74 runs**: `34693848189` (`pull_request`, `55cb0ff5`) → `success`, which is the
**pre-merge PR run and closes the gap pass 3 flagged** (the release commit was untested then; the PR run
shows it tested before merge), and `34694017620` (`push`, `49dcf16`) → `success`, so post-merge main is
green as well. Open PRs on the repo: **0**.

**All three §4 blockers are closed.**

1. *"The changelog claims 1.4.0 shipped; it never did."* Now it did. On `49dcf168`: `## [Unreleased]`
   (empty) at line 7, `## [1.4.0] - 2026-09-12` at line 9, `## [1.3.1] - 2026-09-05` at line 170.
2. *"...a security fix that is also a behaviour change."* The fix is in the **shipped artifact**, which
   pass 3 could not claim (it verified main). From the published tarball's `package/server.js`:
   `resolveTrustProxy` (109-142) returns `false` for an unset/empty value, warning only when
   `RENDER`/`RENDER_EXTERNAL_URL` is set; `false` for `false|0|off|no`; `true` for `true`; an integer for
   digits; and **throws** on an unparseable value. `npm i cachegate@1.4.0` gets the fail-closed default —
   not a main-only promise.
3. *"Any release must be verified on all three channels."* Done above, on all three, comparing manifest
   digests rather than tag names.

**Publication boundary, re-checked on the new tarball.** Pass 3 deliberately skipped §1's
tarball-vs-allowlist diff because 1.3.1's contents could not change; a new publish makes it live again, so
it was re-run. `1.4.0` ships **24 paths** = exactly the `files` allowlist at `49dcf168` (17 entries → 21
paths) plus the three npm always adds (`LICENSE`, `README.md`, `package.json`). No `CHANGELOG.md`, no
`.github/`, no `eval/`, nothing planning-shaped (`tar -tzf … | grep -iE 'changelog|roadmap|plan|task|
journal|design'` → no matches). The shipped `package.json`'s own `files` array is identical to main's, and
the GitHub Release body is changelog text with no internal reference in it. The five modules added to the
allowlist since 1.3.1 (`cascade.js`, `coalescing.js`, `guardrails.js`, `pii.js`, `tracing.js`) were each
added by the commit that introduced them, and `fd9bb8f6` is explicitly titled *"fix files gap"*.

**New check this pass — "does a published tarball require a file it does not ship?"** The allowlist has
demonstrably lost entries on main: `6e5292e7` added `cascade.js` while `coalescing.js`, `guardrails.js`
and `pii.js` were absent from it, restored the same day by `fd9bb8f6` (`+3` lines). So a tarball with an
unresolvable `require()` was a real possibility here, not a hypothetical one. Static check over both
published tarballs: every relative `require()` resolves inside the package — **1.3.1: 14 requires, 1.4.0:
24 requires, both clean**. *Negative control, so the check is known able to fail:* delete `failover.js`
from a copy of the 1.3.1 tree and it exits 1 naming `server.js -> ./failover`. **The gap never shipped** —
the allowlist at 1.3.1's release commit (`1e94628`) names only modules that existed then, and 1.4.0 ships
the complete set.

**Remaining — these belong to steps 07/10/11, not to the release:**

- The `local` bare mirror `/app/workspace/remote/cachegate.git` is at `8228274`, **behind `origin/main`**
  (`49dcf168`). The deploy-chain check reads that mirror, so it needs a fetch before it can report
  `DEPLOYED` for 1.4.0.
- Environment trap hit this pass: `git fetch` inside this worktree fails with *"insufficient permission for
  adding an object to repository database /app/work/cachegate/.git/objects"* — the worktree shares an object
  store the agent uid cannot write. Post-`8228274` main was therefore read through `gh api` and an
  anonymous `git clone https://github.com/iDebunk/cachegate.git` into `/tmp` (which does work), not by
  fetching here. Anyone re-running these checks should clone rather than fetch.
- **Not run, stated so it is not read as a pass:** `npm test` in this clone — step 10's acceptance; the
  test claims above are `test.yml`'s, not mine — and the *contents* of the published images.

**No cachegate commit, deliberately.** Nothing here is a repo change: step 09's fix landed as PR #25 and
this verification is read-only. This file is internal coordination material, so under this repo's
`AGENTS.md` (§2 publication boundary, §3 no task ids or internal references) it stays out of the public
repo — branch `agent/T-210-cachegate-release` sits at `origin/main` with **no commits** — and the
deliverable goes out through the coordination state clone
(`/app/workspace/coordination-state-claude-deepseek` → `/app/workspace/remote/coordination.git`), as in
passes 1-3.

### Pass 5, 2026-09-12T13:03Z — re-verified independently; nothing has moved since pass 4

**Current answer as of this pass: the live release is `1.4.0`**, green on npm, Docker Hub and GHCR — §1-§3
below are the 1.3.1-era record and pass 4 supersedes them.

This card was dispatched again (claim `refs/claims/T-210` at `12:47:50Z`) while `tasks/T-210.md` still
reads `status: pending`, so this pass is a re-measure rather than a new answer. Every value in pass 4 was
re-fetched from scratch between 13:01Z and 13:03Z and **all of it reproduced**: npm `1.4.0`,
`{latest:'1.4.0'}`, `time.modified 2026-09-12T12:35:38.411Z` — byte-identical to pass 4, so **nothing has
been published since** — `gitHead 49dcf168` = `origin/main`; tags `v1.4.0` → `49dcf168…` and `v1.3.1` →
`ac5ba84…`; GitHub Release `v1.4.0`, `draft=false`, `12:37:00Z`; Docker Hub and GHCR both → manifest
`sha256:2d5d04f6…` for `1.4.0` *and* `latest`; release run `34694017580` with all five jobs
`completed/success` and none `skipped` (`release.yml` still 9 runs, 7 success / 2 failure); `test.yml`
still 74 runs, with `34693848189` (`pull_request`, `55cb0ff5`) and `34694017620` (`push`, `49dcf168`) both
green; `CHANGELOG.md` on main still `[Unreleased]` (empty) / `## [1.4.0] - 2026-09-12` / `## [1.3.1] -
2026-09-05`; 0 open PRs; and the `1.4.0` tarball is still exactly **24 paths = the `files` allowlist at
`49dcf168` (17 entries → 21 paths) + `LICENSE`/`README.md`/`package.json`**, compared programmatically
(extra: none, missing: none). **No correction to pass 4.**

**One check pass 4 read rather than ran, now executed.** Pass 4 states what the shipped
`resolveTrustProxy` returns; this pass sliced that function's body out of the *published* tarball's
`package/server.js` (balanced-brace extract, no `require` of the module) and called it directly:

| input | result |
|---|---|
| unset / `""` | `false` |
| `"1"` / `"2"` | `1` / `2` |
| `"true"` / `"false"` | `true` / `false` |
| `"bogus-value"` | **throws** — refuses to boot |

The fail-closed default is therefore demonstrated on the artifact a stranger installs, by execution
including the failure path, rather than by reading the source.

**Still true, and it is step 11's item, not the release's:** the local bare mirror
`/app/workspace/remote/cachegate.git` — what the deploy-chain check reads — has `main` = `8228274`, behind
`origin/main` `49dcf168`. It needs a fetch before step 11 can report `DEPLOYED` for 1.4.0.

**Operational finding — the card, not the release.** `tasks/T-210.md` is `status: pending` with an empty
`result`/`result_log` while its `accept` has passed since pass 1, and `refs/claims/T-210` shows repeat
claims (12:19:56, 12:47:50, this run). `T-213`, which `depends_on: [T-210]`, is already `verified-done`,
so nothing in Part 2 is waiting on this card.

**Correction to this pass's own first diagnosis (13:12Z).** Pass 5 first wrote that the card "keeps
dispatching because it is `pending`" and that flipping it to `verified-done` would stop that. The
`syntax` is right and the `mechanism` was wrong: the card cannot leave `pending`, for two independent
reasons, and neither is its content. Evidence is the watcher's own log
(`/app/workspace/coordination/watchers/claude-deepseek.log`): 6 × `CLAIM T-210`, 4 × `VERIFY T-210`,
5 × `report T-210: failed after retries`, and every run ends the same way:

```
DONE T-210: exit 0
VERIFY T-210: origin/agent/T-210-cachegate-release is not on the remote - nothing was pushed to verify
NEEDS-REVIEW T-210: could not verify (no pushed branch, or no worktree) - never reported as done
push failed: ! [rejected] main -> main (non-fast-forward)          ×5
report T-210: failed after retries
```

1. **The verification gate only trusts a pushed branch of the task repo** (`watch.sh:443-457`: no branch
   on the remote → rc 3 → `needs-review`, "never reported as done"). This card is read-only by design and
   its deliverable is coordination material that `AGENTS.md` §2/§3 keeps out of the public `cachegate`
   repo — so **no branch will ever be pushed, and the card can never verify**, however correct the work.
   That is a card/dispatcher mismatch: the accept (`test -s` on a coordination path) and the verification
   (a pushed commit in `cachegate`) are looking in two different places.
2. **The report then fails for a second, unrelated reason.** `push_file()` (`watch.sh:137-149`) commits on
   the clone's **current branch** but pushes `git push "${COORD_REMOTE}" main`. This clone's checkout is
   `t210-reverify` (created from `origin/main` at 11:43:30 by an earlier revision pass and never switched
   back — `git reflog show t210-reverify`), while its local `main` sits at `c0f10a6` (11:18:46) and is
   **not** an ancestor of the remote's `main`. Every push is therefore rejected non-fast-forward, five
   times, and `sync_fresh` throws the attempt away with `git reset --hard FETCH_HEAD` — the reflog shows
   the discarded verdicts (`commit: watch(claude-deepseek): T-210 failed` at 11:47:43/49/55, `... T-210
   needs-review` at 12:46:06/18/30). So even the `needs-review` verdict never reaches the board: the card
   looks untouched and is re-claimed, and the loop has been running since ~11:47, not since pass 3.

Neither is fixable from inside a read-only, no-lease card, and both are shared machinery, so they are
recorded rather than acted on: (1) is the supervisor's call — a coordination-only card needs an accept
that does not assume a pushed repo branch, or it should be closed by hand; (2) has two one-line
remedies — switch the clone back (`git -C /app/workspace/coordination-state-claude-deepseek checkout main
&& git reset --hard <remote main>`), or change `push_file` to push `HEAD` rather than the literal branch
`main`. Until one of them happens, every poll cycle buys another full read-only run that cannot be
reported — this card has already cost four.

**Limits, stated rather than implied.** Not run: `npm test` in this clone (step 10's acceptance — the test
claims here are `test.yml`'s, not mine) and any inspection of the *contents* of the published images;
`test.yml` is green at run level, not per assertion. No `cachegate` commit: nothing here is a repo change,
and this file is internal material, which this repo's `AGENTS.md` §2/§3 keeps out of the public repo
(branch `agent/T-210-cachegate-release` does not exist on origin — checked, not assumed).

**The live tree lags by exactly pass 4** (checked, not assumed): the live
`coordination/designs/cachegate-release-check.md` still ends at pass 3 (sha256 `5a2fedc2…`), while the
committed copy carries pass 4 (sha256 `5f02305a…`). So `test -s` passes on content one revision stale —
worth knowing when this card's acceptance is read as evidence.

### Pass 6, 2026-09-12T13:17Z — release unchanged and green; the report path is repaired and the verify gate is escalated

**Current answer, unchanged: the live release is `1.4.0`, green on npm, Docker Hub and GHCR.** Every value
below was re-fetched between 13:14Z and 13:17Z in this run and is identical to passes 4-5, so this pass adds
no correction — it adds a repair and an escalation.

- **npm**: version `1.4.0`, dist-tags `{ latest: '1.4.0' }`, versions `1.0.0, 1.1.0, 1.1.1, 1.2.0, 1.3.0,
  1.3.1, 1.4.0`; `time.modified 2026-09-12T12:35:38.411Z` — byte-identical to passes 4 and 5, so **nothing
  has been published since 1.4.0**; `gitHead 49dcf1686b3bd780d0c4b6cb574cfeb65411fb9c` **= the current
  `origin/main` tip** (both read in this pass, seconds apart), so the artifact on npm is the tip of main.
- **Tags**: `v1.4.0` → `49dcf168…`, `v1.3.1` → `ac5ba84…`, nothing else. **GitHub Release** `v1.4.0`,
  `draft=false`, `prerelease=false`, published `12:37:00Z`, target `main`.
- **Registries**: Docker Hub `1.4.0` and `latest` both → manifest `sha256:2d5d04f6…`, `images[0]` (amd64)
  `sha256:8d0a23ce…`, pushed `12:36:42Z` / `12:36:43Z`; GHCR `1.4.0` and `latest` both →
  `docker-content-digest: sha256:2d5d04f6…`. Same manifest on both registries, `latest` not drifted.
- **Pipelines**: `release.yml` 9 runs — 7 success, 2 failure (the 1.3.1 attempts); run `34694017580`
  (`push`, `main`, `49dcf168`, `12:33:54Z`) → `success` with **all five jobs** — `check-version`, `test`,
  `publish-docker`, `publish-npm`, `tag-and-release` — none skipped. `test.yml` 74 runs, `34694017620`
  (`push`, `49dcf16`) and `34693848189` (`pull_request`, `55cb0ff`) both `success`. Open PRs: **0** (PR #25
  closed/merged `12:33:52Z`). `CHANGELOG.md` on main: `## [Unreleased]` line 7 (empty), `## [1.4.0] -
  2026-09-12` line 9, `## [1.3.1] - 2026-09-05` line 170. All three §4 blockers stay closed.

**Publication boundary re-checked, this time programmatically rather than by eye.** The `1.4.0` tarball
ships **24 paths = the 21 paths the `files` allowlist at `49dcf168` expands to, plus exactly
`LICENSE`/`README.md`/`package.json`**; the comparison reports `extra: []`, `missing: []`. No
`CHANGELOG.md`, no `.github/`, no `eval/`, nothing planning-shaped. Re-run because a new publish makes the
check live again — 1.3.1's could not change, this one could.

**Repair — the state clone's branch, and the failure path was observed before it was fixed.** Pass 5
diagnosed why this card's verdict never reached the board; this pass confirms the diagnosis at the push
itself and fixes the half that lives in this agent's own clone:

| | before | after |
|---|---|---|
| checked-out branch | `t210-reverify` | `main` |
| local `main` / remote `main` | `c0f10a6` / `068b6ea` | `068b6ea` / `068b6ea` |
| `git push --dry-run origin main` | **`! [rejected] main -> main (non-fast-forward)`**, exit 1 | `Everything up-to-date`, exit 0 |

The rejection was reproduced live, not quoted from the log — it is the same failure `push_file()` records
×5 in the watcher log, and it is why `sync_fresh` then reset each verdict away. `git checkout main &&
git reset --hard origin/main` puts the checked-out branch and the pushed branch back in agreement, so the
watcher's next report (whatever verdict it carries) can fast-forward to the bare remote instead of being
discarded. Nothing was lost: the claim is a ref in the bare remote (`refs/claims/T-210` → `53096fc`), not a
branch, so it survives the switch. **Residual, not claimed as fixed:** two agents pushing `main`
concurrently can still lose the race — `push_file`'s retry loop exists for that — and this repair does not
touch `watch.sh`, which is shared tooling and not this card's to edit.

**Still unfixable from here, and escalated to the supervisor.** `accept_verify` (`watch.sh:443-457`)
requires `refs/remotes/origin/agent/T-210-cachegate-release` **in the cachegate repo**; this card is
read-only by design and its deliverable is coordination material that cachegate's `AGENTS.md` §2/§3 keeps
out of the public repo, so no branch exists and none should. The gate and the `accept` point at different
repos. **`2` is not `1`:** this is *could not check*, not *checked and broken* — the artifact is written and
its claims verified; the gate simply cannot look at it. Sent to `claude-ide` as supervisor `blocked`
(`--ref step-08`): close the card by hand, or give coordination-only cards an accept that does not assume a
pushed task-repo branch. With the report path repaired, the honest verdict (`needs-review`) should now land
and stop the re-claim loop rather than being reset away.

**Live tree**: at the time of writing it is at `08850e2` with the artifact still ending at **pass 3**
(268 lines, sha256 `5a2fedc2…`) while the committed copy carries pass 5 (sha256 `10a4b06a…`) — so the lag
is one revision wider than pass 5 reported, exactly as its own note predicted, and the sync is the
root-capable watcher's to do. `test -s` on that path passes on stale content either way.

**Limits, stated rather than implied.** Not run: `npm test` in this clone (step 10's acceptance — the test
claims above are `test.yml`'s, not mine), and any inspection of the *contents* of the published images.
No `cachegate` commit: nothing in this card is a repo change. This pass re-verified §1-§4 against the live
registries; it did not re-execute the extracted `resolveTrustProxy` harness of pass 5 (the artifact it
measures — the published `1.4.0` tarball — cannot have changed, since `time.modified` is byte-identical).
