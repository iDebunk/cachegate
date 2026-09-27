<!-- moved from iDebunk/cachegate-coordination@2f8b360:designs/cachegate-step09.md on 2026-09-27 - this repo keeps its own reports; the original stays in that repo as the archive -->

## Step 09

T-213 / roadmap step 09 — Part 2 (claude-deepseek). Repo `cachegate`, branch
`agent/T-213-trust-proxy`. **PR opened, not merged** (the supervisor merges).

### What was wrong

Two defects, found by the T-210 release check and confirmed here:

1. **The changelog claimed a release that never happened.** `CHANGELOG.md` carried
   `## [1.4.0] - 2026-09-06`, while `npm view cachegate@1.4.0` was **404**, there was **no `v1.4.0` tag**, and
   `package.json` still said `1.3.1`. Keep a Changelog reads `## [version] - date` as *shipped on that
   date*, so the file told every stranger — and the GitHub Releases page the pipeline fills from it — that
   1.4.0 shipped four days ago.
2. **`[Unreleased]` held a security fix that was also a behaviour change** and was not prominently
   flagged as non-optional: `trust proxy` defaulted to `1`, so with no proxy in front, express trusted
   client-controlled `X-Forwarded-For` and a caller could present a fresh IP per request, defeating the
   per-IP limiter on the key-holding routes — **fail-open, and silent**.

### What this PR does

- **Makes the claim true rather than deleting it.** `[Unreleased]` is folded into `## [1.4.0] - 2026-09-12`.
  The code for that release is already on `main`; only the release was missing, so shipping 1.4.0 is the
  honest repair.
- **The `trust proxy` upgrade note leads the release**, under `### Changed — UPGRADE NOTE for proxied
  deployments`, with the escape hatch spelled out: **set `TRUST_PROXY=1` (single hop) or your real hop
  count.** An unparseable value now refuses to start rather than silently changing limiter scope.
- **The release preamble was corrected.** It said *"Everything below is additive and opt-in … byte-identical
  in observable behavior to 1.3.1"*. That is still true of the **features** and is now stated as such, but
  it was about to become false of the release as a whole: the trust-proxy change is deliberately **not**
  opt-in, and the preamble now says so and points at the upgrade note.
- **`package.json` and `package-lock.json` bumped to `1.4.0`** via `npm version --no-git-tag-version`, so all
  three version fields agree. Minor bump, per the card: a security fix and a behaviour change.

### ⚠️ WHAT MERGING THIS DOES — read before merging

**`release.yml` fires on a push to `main` that changes `package.json`'s version to one not already on
npm.** So merging this PR does not merely land a changelog edit: **it triggers a real publish of 1.4.0 to
npm, Docker Hub and GHCR.** That is the intended outcome — publishing 1.4.0 is exactly how the phantom
release gets resolved — but it is an outward-facing action and it should be a deliberate one.

Precedent for why it deserves care: **run `33993168310` was a partial release** — npm published, Docker
failed — and it took a manual retry. So this should be verified **on all three channels afterwards**, not
just npm: `npm view cachegate version`, Docker Hub `shipman/cachegate:1.4.0`, GHCR, and a `v1.4.0` tag.
"The pipeline is green" is not "it published", as the four no-op runs of 2026-09-06 demonstrate.

### Verification run

- `npm test` in `cachegate` — see the PR for the result; the pipeline re-runs it, and step 10 does the
  formal pass-plus-accept.
- Version consistency: `package.json` and both `package-lock.json` fields read `1.4.0`.
- Changelog structure checked by heading: `## [Unreleased]` (now empty), `## [1.4.0] - 2026-09-12` with
  `### Changed`, `### Added`, `### Fixed`, then `## [1.3.1]`.

### What I did not do

- **Did not merge** (the supervisor merges) and **did not publish** — nothing was pushed to any registry.
- **Did not re-date or rewrite history.** The 1.4.0 heading was re-dated to today because the release
  happens today; the content it describes is unchanged, and `[Unreleased]`'s entries moved rather than
  being rewritten.
- **Did not touch `[1.3.1]` or anything below it.**

### The lesson worth keeping

A changelog entry is a **claim about an artifact**, and nothing was checking it. The registry, the tags and
`package.json` all disagreed with the file and no mechanism compared them. That is the same shape as the
`ops-runner` digest bug fixed earlier today (`#99`) and the vendored router's version marker (T-209): **a
marker that asserts something the thing it describes does not support.** The check that would catch it is
cheap — does the version in `package.json` appear in the registry and in the tags after every release — and
it does not exist yet.
